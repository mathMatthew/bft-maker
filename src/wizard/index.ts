import * as clack from "@clack/prompts";
import { createInitialState, buildManifest, type WizardState } from "./state.js";
import { initGrid } from "./state.js";
import { runDataModelStep } from "./steps/data-model.js";
import { runStrategyMatrixStep } from "./steps/strategy-matrix.js";
import { runWeightsStep } from "./steps/weights.js";
import { runTablesStep } from "./steps/tables.js";
import { validate } from "../manifest/validate.js";
import { serializeManifest, saveManifest } from "../manifest/yaml.js";

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
  clack.intro("bft-maker wizard");

  const state = createInitialState();

  // Step 1: Data model (database-driven discovery)
  const ok1 = await runDataModelStep(state, opts.dbPath);
  if (!ok1) {
    clack.outro("Wizard cancelled.");
    return;
  }

  // Step 2: Strategy matrix
  const ok2 = await runStrategyMatrixStep(state);
  if (!ok2) {
    clack.outro("Wizard cancelled.");
    return;
  }

  // Step 3: Weights (only if needed)
  state.step = "weights";
  const ok3 = await runWeightsStep(state);
  if (!ok3) {
    clack.outro("Wizard cancelled.");
    return;
  }

  // Step 4: BFT tables
  state.step = "tables";
  const ok4 = await runTablesStep(state);
  if (!ok4) {
    clack.outro("Wizard cancelled.");
    return;
  }

  // Build manifest
  const manifest = buildManifest(state);

  // Validate
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

  // Output
  const yaml = serializeManifest(manifest);

  if (opts.outputPath) {
    saveManifest(manifest, opts.outputPath);
    clack.outro(`Manifest written to ${opts.outputPath}`);
  } else {
    console.log("\n" + yaml);
    clack.outro("Done! Copy the YAML above or re-run with --output <path>.");
  }
}
