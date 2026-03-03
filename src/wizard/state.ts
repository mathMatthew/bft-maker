import type {
  Entity,
  Relationship,
  MetricDef,
  MetricPropagation,
  PropagationEdge,
  BftTable,
  Strategy,
  Manifest,
} from "../manifest/types.js";

/* ------------------------------------------------------------------ */
/*  Wizard step identifiers                                           */
/* ------------------------------------------------------------------ */

export type WizardStep =
  | "data-model"
  | "strategy-matrix"
  | "weights"
  | "tables";

export const STEP_ORDER: readonly WizardStep[] = [
  "data-model",
  "strategy-matrix",
  "weights",
  "tables",
];

/* ------------------------------------------------------------------ */
/*  Grid cell — one metric × one foreign entity                       */
/* ------------------------------------------------------------------ */

/**
 * A cell in the strategy matrix. Each cell represents a metric's strategy
 * on a specific foreign entity.
 *
 * - "home" means the metric lives on this entity (not editable)
 * - "unreachable" means no relationship path exists (grayed out)
 * - A Strategy value means the user has chosen how this metric propagates
 */
export type CellValue = "home" | "unreachable" | Strategy;

export interface GridCell {
  metricName: string;
  entityName: string;
  value: CellValue;
  /** Which relationship connects to this entity from the prior hop. */
  relationship?: string;
}

/* ------------------------------------------------------------------ */
/*  Wizard state                                                      */
/* ------------------------------------------------------------------ */

export interface WizardState {
  step: WizardStep;

  /* Step 1 output */
  entities: Entity[];
  relationships: Relationship[];

  /* Step 2 — strategy matrix (derived from step 1, edited by user) */
  grid: GridCell[][];   // rows = metrics, cols = entities
  metricNames: string[];
  entityNames: string[];

  /* Step 3 — weights for allocation / sum_over_sum cells */
  weights: Map<string, string>;  // key: "metric:entity", value: weight column name

  /* Step 4 — BFT table definitions */
  bftTables: BftTable[];
}

/* ------------------------------------------------------------------ */
/*  State factory                                                     */
/* ------------------------------------------------------------------ */

export function createInitialState(): WizardState {
  return {
    step: "data-model",
    entities: [],
    relationships: [],
    grid: [],
    metricNames: [],
    entityNames: [],
    weights: new Map(),
    bftTables: [],
  };
}

/* ------------------------------------------------------------------ */
/*  Step navigation                                                   */
/* ------------------------------------------------------------------ */

export function nextStep(state: WizardState): WizardStep | null {
  const idx = STEP_ORDER.indexOf(state.step);
  return idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : null;
}

export function prevStep(state: WizardState): WizardStep | null {
  const idx = STEP_ORDER.indexOf(state.step);
  return idx > 0 ? STEP_ORDER[idx - 1] : null;
}

/* ------------------------------------------------------------------ */
/*  Grid initialization — build the matrix from entities/metrics      */
/* ------------------------------------------------------------------ */

/** Collect all metrics across entities and relationships. */
export function collectMetrics(
  entities: Entity[],
  relationships: Relationship[],
): { name: string; homeEntities: string[] }[] {
  const result: { name: string; homeEntities: string[] }[] = [];

  for (const entity of entities) {
    for (const metric of entity.metrics) {
      result.push({ name: metric.name, homeEntities: [entity.name] });
    }
  }

  for (const rel of relationships) {
    if (rel.metrics) {
      for (const metric of rel.metrics) {
        // Relationship metrics are "home" on both connected entities.
        result.push({ name: metric.name, homeEntities: [...rel.between] });
      }
    }
  }

  return result;
}

/**
 * Build adjacency map: entity → list of { entity, relationship }.
 * Used to determine which entities are reachable from a metric's home.
 */
export function buildAdjacency(
  entities: Entity[],
  relationships: Relationship[],
): Map<string, { entity: string; relationship: string }[]> {
  const adj = new Map<string, { entity: string; relationship: string }[]>();

  for (const e of entities) {
    adj.set(e.name, []);
  }

  for (const rel of relationships) {
    const [a, b] = rel.between;
    adj.get(a)!.push({ entity: b, relationship: rel.name });
    adj.get(b)!.push({ entity: a, relationship: rel.name });
  }

  return adj;
}

/**
 * BFS from a set of home entities to find all reachable entities and
 * which relationship leads to each.
 */
export function findReachable(
  homeEntities: string[],
  adj: Map<string, { entity: string; relationship: string }[]>,
): Map<string, string> {
  // Returns: reachable entity → relationship that connects to it
  const visited = new Set(homeEntities);
  const queue = [...homeEntities];
  const result = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { entity, relationship } of adj.get(current) ?? []) {
      if (!visited.has(entity)) {
        visited.add(entity);
        result.set(entity, relationship);
        queue.push(entity);
      }
    }
  }

  return result;
}

/**
 * Initialize the strategy grid from entities, relationships, and metrics.
 * Each cell is either "home", "unreachable", or defaults to "reserve".
 */
export function initGrid(
  entities: Entity[],
  relationships: Relationship[],
): { grid: GridCell[][]; metricNames: string[]; entityNames: string[] } {
  const entityNames = entities.map((e) => e.name);
  const metrics = collectMetrics(entities, relationships);
  const metricNames = metrics.map((m) => m.name);
  const adj = buildAdjacency(entities, relationships);

  const grid: GridCell[][] = [];

  for (const metric of metrics) {
    const row: GridCell[] = [];
    const reachable = findReachable(metric.homeEntities, adj);

    for (const entityName of entityNames) {
      if (metric.homeEntities.includes(entityName)) {
        row.push({
          metricName: metric.name,
          entityName,
          value: "home",
        });
      } else if (reachable.has(entityName)) {
        row.push({
          metricName: metric.name,
          entityName,
          value: "reserve",
          relationship: reachable.get(entityName),
        });
      } else {
        row.push({
          metricName: metric.name,
          entityName,
          value: "unreachable",
        });
      }
    }

    grid.push(row);
  }

  return { grid, metricNames, entityNames };
}

/* ------------------------------------------------------------------ */
/*  Cell editing                                                      */
/* ------------------------------------------------------------------ */

const EDITABLE_STRATEGIES: readonly Strategy[] = [
  "reserve",
  "elimination",
  "allocation",
  "sum_over_sum",
];

/** Cycle a cell's strategy forward. Only works on editable cells. */
export function cycleStrategy(cell: GridCell): GridCell {
  if (cell.value === "home" || cell.value === "unreachable") {
    return cell;
  }
  const idx = EDITABLE_STRATEGIES.indexOf(cell.value);
  const next = EDITABLE_STRATEGIES[(idx + 1) % EDITABLE_STRATEGIES.length];
  return { ...cell, value: next };
}

/* ------------------------------------------------------------------ */
/*  Extract propagations from grid state                              */
/* ------------------------------------------------------------------ */

/**
 * Given the grid and weights, produce MetricPropagation[] for the manifest.
 * Only metrics that have at least one non-reserve cell get a propagation entry.
 */
export function extractPropagations(
  state: WizardState,
): MetricPropagation[] {
  const propagations: MetricPropagation[] = [];

  for (let row = 0; row < state.grid.length; row++) {
    const metricName = state.metricNames[row];
    const path: PropagationEdge[] = [];

    for (let col = 0; col < state.grid[row].length; col++) {
      const cell = state.grid[row][col];
      if (
        cell.value !== "home" &&
        cell.value !== "unreachable" &&
        cell.value !== "reserve"
      ) {
        const edge: PropagationEdge = {
          relationship: cell.relationship!,
          target_entity: cell.entityName,
          strategy: cell.value,
        };
        if (cell.value === "allocation" || cell.value === "sum_over_sum") {
          const weightKey = `${metricName}:${cell.entityName}`;
          const weight = state.weights.get(weightKey);
          if (weight) {
            edge.weight = weight;
          }
        }
        path.push(edge);
      }
    }

    if (path.length > 0) {
      propagations.push({ metric: metricName, path });
    }
  }

  return propagations;
}

/* ------------------------------------------------------------------ */
/*  Collect all MetricDefs (needed for validation and tables step)     */
/* ------------------------------------------------------------------ */

export function allMetricDefs(state: WizardState): MetricDef[] {
  const defs: MetricDef[] = [];
  for (const entity of state.entities) {
    defs.push(...entity.metrics);
  }
  for (const rel of state.relationships) {
    if (rel.metrics) {
      defs.push(...rel.metrics);
    }
  }
  return defs;
}

/* ------------------------------------------------------------------ */
/*  Build final Manifest from wizard state                            */
/* ------------------------------------------------------------------ */

export function buildManifest(state: WizardState): Manifest {
  return {
    entities: state.entities,
    relationships: state.relationships,
    propagations: extractPropagations(state),
    bft_tables: state.bftTables,
  };
}

/* ------------------------------------------------------------------ */
/*  Find cells that need weights                                      */
/* ------------------------------------------------------------------ */

export function cellsNeedingWeights(state: WizardState): GridCell[] {
  const cells: GridCell[] = [];
  for (const row of state.grid) {
    for (const cell of row) {
      if (cell.value === "allocation" || cell.value === "sum_over_sum") {
        cells.push(cell);
      }
    }
  }
  return cells;
}
