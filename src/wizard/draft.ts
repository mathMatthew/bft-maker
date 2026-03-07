import * as fs from "node:fs";
import * as path from "node:path";
import type { WizardState, WizardStep, GridCell } from "./state.js";
import type { Entity, Relationship, MetricDef, BftTable } from "../manifest/types.js";
import type {
  DetectedModel,
  TableInfo,
  ColumnInfo,
  FKRef,
  DetectedRelationship,
} from "./introspect.js";

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

interface SerializedDetectedModel {
  tables: TableInfo[];
  entityNames: string[];
  junctionNames: string[];
  unclassifiedNames: string[];
  allFKs: FKRef[];
  metrics: { table: string; column: string; type: string; nature?: "additive" | "non-additive" }[];
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
  /** Saved introspection results so we can skip re-introspecting on resume. */
  detectedModel?: SerializedDetectedModel;
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
  model?: DetectedModel,
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

  if (model) {
    draft.detectedModel = {
      tables: model.tables,
      entityNames: model.entities.map((t) => t.name),
      junctionNames: model.junctions.map((t) => t.name),
      unclassifiedNames: model.unclassified.map((t) => t.name),
      allFKs: model.allFKs,
      metrics: model.metrics,
    };
  }

  fs.writeFileSync(draftPath(dbPath), JSON.stringify(draft, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Load                                                               */
/* ------------------------------------------------------------------ */

export interface LoadedDraft {
  resumeStep: WizardStep | "hub";
  savedAt: string;
  state: WizardState;
  detectedModel?: DetectedModel;
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

    // Rebuild DetectedModel from saved data — re-link table references
    let detectedModel: DetectedModel | undefined;
    if (raw.detectedModel) {
      const dm = raw.detectedModel;
      const tableByName = new Map(dm.tables.map((t) => [t.name, t]));
      const entities = dm.entityNames.map((n) => tableByName.get(n)!).filter(Boolean);
      const junctions = dm.junctionNames.map((n) => tableByName.get(n)!).filter(Boolean);
      const unclassified = dm.unclassifiedNames.map((n) => tableByName.get(n)!).filter(Boolean);

      // Rebuild directFKs and relationships from allFKs + classifications
      const entityNameSet = new Set(dm.entityNames);
      const directFKs = dm.allFKs.filter(
        (fk) => entityNameSet.has(fk.fromTable) && entityNameSet.has(fk.toTable),
      );
      const relationships: DetectedRelationship[] = [];
      for (const jt of junctions) {
        const jtFKs = dm.allFKs.filter((fk) => fk.fromTable === jt.name);
        if (jtFKs.length >= 2) {
          relationships.push({
            junctionTable: jt.name,
            entity1: jtFKs[0].toTable,
            entity2: jtFKs[1].toTable,
            fk1Column: jtFKs[0].fromColumn,
            fk2Column: jtFKs[1].fromColumn,
            rowCount: jt.rowCount,
          });
        }
      }

      detectedModel = {
        tables: dm.tables,
        entities,
        junctions,
        unclassified,
        relationships,
        directFKs,
        allFKs: dm.allFKs,
        metrics: dm.metrics,
      };
    }

    return {
      resumeStep: raw.resumeStep,
      savedAt: raw.savedAt,
      state,
      detectedModel,
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
