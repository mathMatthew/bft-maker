import * as fs from "node:fs";
import * as path from "node:path";
import type { WizardState, WizardStep, GridCell } from "./state.js";
import type { Entity, Relationship, MetricDef, BftTable } from "../manifest/types.js";

/* ------------------------------------------------------------------ */
/*  Draft file format                                                  */
/* ------------------------------------------------------------------ */

interface SerializedState {
  step: WizardStep;
  entities: Entity[];
  relationships: Relationship[];
  grid: GridCell[][];
  metricNames: string[];
  entityNames: string[];
  weights: Record<string, string>;
  bftTables: BftTable[];
}

interface DraftFile {
  /** Absolute path to the database file. */
  dbPath: string;
  /** ISO timestamp when draft was saved. */
  savedAt: string;
  /** Which step to resume FROM (the next step to run, or "hub" for the menu). */
  resumeStep: WizardStep | "hub";
  /** Serialized wizard state. */
  state: SerializedState;
}

/* ------------------------------------------------------------------ */
/*  Path helpers                                                       */
/* ------------------------------------------------------------------ */

export function draftPath(dbPath: string): string {
  const abs = path.resolve(dbPath);
  return abs + ".bft-draft.json";
}

/* ------------------------------------------------------------------ */
/*  Save                                                               */
/* ------------------------------------------------------------------ */

export function saveDraft(
  dbPath: string,
  state: WizardState,
  resumeStep: WizardStep | "hub",
): void {
  const draft: DraftFile = {
    dbPath: path.resolve(dbPath),
    savedAt: new Date().toISOString(),
    resumeStep,
    state: {
      step: state.step,
      entities: state.entities,
      relationships: state.relationships,
      grid: state.grid,
      metricNames: state.metricNames,
      entityNames: state.entityNames,
      weights: Object.fromEntries(state.weights),
      bftTables: state.bftTables,
    },
  };

  fs.writeFileSync(draftPath(dbPath), JSON.stringify(draft, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Load                                                               */
/* ------------------------------------------------------------------ */

export interface LoadedDraft {
  resumeStep: WizardStep | "hub";
  savedAt: string;
  state: WizardState;
}

export function loadDraft(dbPath: string): LoadedDraft | null {
  const fp = draftPath(dbPath);
  if (!fs.existsSync(fp)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8")) as DraftFile;

    // Verify it's for the same database
    if (raw.dbPath !== path.resolve(dbPath)) return null;

    const state: WizardState = {
      step: raw.state.step,
      entities: raw.state.entities,
      relationships: raw.state.relationships,
      grid: raw.state.grid,
      metricNames: raw.state.metricNames,
      entityNames: raw.state.entityNames,
      weights: new Map(Object.entries(raw.state.weights)),
      bftTables: raw.state.bftTables,
    };

    return {
      resumeStep: raw.resumeStep,
      savedAt: raw.savedAt,
      state,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Delete                                                             */
/* ------------------------------------------------------------------ */

export function deleteDraft(dbPath: string): void {
  const fp = draftPath(dbPath);
  try {
    fs.unlinkSync(fp);
  } catch {
    // ignore — file may not exist
  }
}
