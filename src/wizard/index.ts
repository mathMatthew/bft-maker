import * as clack from "@clack/prompts";
import { settings, updateSettings } from "@clack/core";
import {
  createInitialState,
  buildManifest,
  collectMetrics,
  cellsNeedingWeights,
  allMetricDefs,
  type WizardState,
} from "./state.js";
import { runDataModelStep } from "./steps/data-model.js";
import { runStrategyMatrixStep } from "./steps/strategy-matrix.js";
import { runWeightsStep } from "./steps/weights.js";
import { runTablesStep } from "./steps/tables.js";
import { validate } from "../manifest/validate.js";
import { serializeManifest, saveManifest } from "../manifest/yaml.js";
import { saveDraft, loadDraft, deleteDraft } from "./draft.js";

/* ------------------------------------------------------------------ */
/*  Wizard runner                                                     */
/* ------------------------------------------------------------------ */

export interface WizardOptions {
  /** Path to a DuckDB database file to introspect. */
  dbPath: string;
  /** If set, write the manifest to this path. Otherwise print to stdout. */
  outputPath?: string;
}

export async function runWizard(opts: WizardOptions): Promise<void> {
  // Catch SIGINT (Ctrl-C) during clack prompts
  let cancelled = false;
  const onSigint = () => { cancelled = true; };
  process.on("SIGINT", onSigint);
  const cleanup = () => { process.removeListener("SIGINT", onSigint); };

  // Map 'q' to cancel in select/multiselect prompts
  updateSettings({ aliases: { q: "cancel" } });

  clack.intro("bft-maker wizard");
  clack.log.info("Press q to quit at any prompt.");

  // ── Check for saved draft ──────────────────────────────────

  let state = createInitialState();
  let hasDataModel = false;

  const draft = loadDraft(opts.dbPath);
  if (draft) {
    const ago = timeSince(draft.savedAt);
    const resume = await clack.select({
      message: `Found saved progress from ${ago}. Resume?`,
      options: [
        { value: "resume", label: "Resume", hint: statusSummary(draft.state) },
        { value: "fresh", label: "Start fresh" },
      ],
    });

    if (clack.isCancel(resume)) {
      cleanup();
      clack.outro("Wizard cancelled.");
      return;
    }

    if (resume === "resume") {
      state = draft.state;
      hasDataModel = state.entities.length > 0;
    } else {
      deleteDraft(opts.dbPath);
    }
  }

  // ── Step 1: Data model (required first time) ────────────────

  if (!hasDataModel) {
    const ok = await runDataModelStep(state, opts.dbPath);
    if (!ok || cancelled) {
      cleanup();
      saveOnQuit(opts.dbPath, state);
      return;
    }
    hasDataModel = true;
    saveDraft(opts.dbPath, state, "strategy-matrix");
  }

  // ── Hub menu ────────────────────────────────────────────────

  while (true) {
    if (cancelled) {
      cleanup();
      saveOnQuit(opts.dbPath, state);
      return;
    }

    const choice = await showHubMenu(state);

    if (clack.isCancel(choice) || choice === "quit") {
      cleanup();
      saveOnQuit(opts.dbPath, state);
      return;
    }

    if (choice === "generate") {
      break;
    }

    let ok = true;

    switch (choice) {
      case "data-model":
        // Re-run data model — reset downstream state
        state.entities = [];
        state.relationships = [];
        state.grid = [];
        state.metricNames = [];
        state.entityNames = [];
        state.weights = new Map();
        state.bftTables = [];
        ok = await runDataModelStep(state, opts.dbPath);
        break;

      case "strategy-matrix":
        ok = await runStrategyMatrixStep(state);
        break;

      case "weights":
        state.step = "weights";
        ok = await runWeightsStep(state);
        break;

      case "tables":
        state.step = "tables";
        ok = await runTablesStep(state);
        break;
    }

    if (!ok || cancelled) {
      cleanup();
      saveOnQuit(opts.dbPath, state);
      return;
    }

    // Save progress after each step
    saveDraft(opts.dbPath, state, "hub");
  }

  cleanup();

  // ── Build manifest ──────────────────────────────────────────

  const manifest = buildManifest(state);

  const errors = validate(manifest);
  const hard = errors.filter((e) => e.severity !== "warning");
  const warnings = errors.filter((e) => e.severity === "warning");

  for (const w of warnings) {
    clack.log.warning(w.message);
  }

  if (hard.length > 0) {
    clack.log.error("Manifest has validation errors:");
    for (const e of hard) {
      clack.log.error(`  ${e.message}`);
    }
    clack.outro("Fix the issues above and try again.");
    return;
  }

  const yaml = serializeManifest(manifest);

  if (opts.outputPath) {
    saveManifest(manifest, opts.outputPath);
    clack.outro(`Manifest written to ${opts.outputPath}`);
  } else {
    console.log("\n" + yaml);
    clack.outro("Done! Copy the YAML above or re-run with --output <path>.");
  }

  deleteDraft(opts.dbPath);
}

/* ------------------------------------------------------------------ */
/*  Hub menu                                                           */
/* ------------------------------------------------------------------ */

type HubChoice =
  | "data-model"
  | "strategy-matrix"
  | "weights"
  | "tables"
  | "generate"
  | "quit";

async function showHubMenu(state: WizardState): Promise<HubChoice | symbol> {
  const totalMetrics =
    state.entities.reduce((n, e) => n + e.metrics.length, 0) +
    state.relationships.reduce((n, r) => n + (r.metrics?.length ?? 0), 0);

  // Status for each section
  const matrixDone = state.grid.length > 0;
  const needsWeights = cellsNeedingWeights(state);
  const weightsDone = needsWeights.length === 0 ||
    needsWeights.every((c) => state.weights.has(`${c.metricName}:${c.entityName}`));
  const tablesDone = state.bftTables.length > 0;

  // Can we generate?
  const canGenerate = matrixDone && weightsDone && tablesDone;

  const options: { value: HubChoice; label: string; hint?: string }[] = [];

  // Data model — always available
  options.push({
    value: "data-model",
    label: "Data model",
    hint: `${state.entities.length} entities, ${totalMetrics} metrics — redo`,
  });

  // Strategy matrix
  options.push({
    value: "strategy-matrix",
    label: "Strategy matrix",
    hint: matrixDone ? "configured — edit" : "not started",
  });

  // Weights — only relevant if there are allocation/sum-over-sum cells
  if (matrixDone) {
    if (needsWeights.length === 0) {
      options.push({
        value: "weights",
        label: "Weights",
        hint: "none needed",
      });
    } else {
      options.push({
        value: "weights",
        label: "Weights",
        hint: weightsDone
          ? `${needsWeights.length} defined — edit`
          : `${needsWeights.length} needed`,
      });
    }
  }

  // BFT tables
  if (matrixDone) {
    options.push({
      value: "tables",
      label: "BFT tables",
      hint: tablesDone
        ? `${state.bftTables.length} table(s) — edit`
        : "not started",
    });
  }

  // Generate
  if (canGenerate) {
    options.push({
      value: "generate",
      label: "Generate manifest",
    });
  }

  // Quit
  options.push({
    value: "quit",
    label: "Save & quit",
  });

  clack.log.message("");
  return clack.select({ message: "What next?", options });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function saveOnQuit(dbPath: string, state: WizardState): void {
  if (state.entities.length > 0 || state.relationships.length > 0) {
    saveDraft(dbPath, state, "hub");
    clack.log.info("Progress saved. Run the wizard again to resume.");
  }
  clack.outro("Wizard cancelled.");
}

function statusSummary(state: WizardState): string {
  const parts: string[] = [];
  const totalMetrics =
    state.entities.reduce((n, e) => n + e.metrics.length, 0) +
    state.relationships.reduce((n, r) => n + (r.metrics?.length ?? 0), 0);
  parts.push(`${state.entities.length} entities, ${totalMetrics} metrics`);
  if (state.grid.length > 0) parts.push("matrix done");
  if (state.bftTables.length > 0) parts.push(`${state.bftTables.length} table(s)`);
  return parts.join(", ");
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
