export type Strategy =
  | "reserve"
  | "elimination"
  | "allocation"
  | "sum_over_sum";

export const VALID_STRATEGIES: ReadonlySet<string> = new Set([
  "reserve", "elimination", "allocation", "sum_over_sum",
]);

export interface MetricDef {
  name: string;
  type: "currency" | "integer" | "float" | "rating" | "percentage";
  nature: "additive" | "non-additive";
}

export interface Entity {
  name: string;
  role: "leaf" | "bridge";
  detail: boolean;
  estimated_rows: number;
  metrics: MetricDef[];
}

/** Relationships are undirected — they describe what joins exist. */
export interface Relationship {
  name: string;
  between: [string, string];
  type: "many-to-many" | "many-to-one";
  estimated_links: number;
  weight_column?: string;
}

/**
 * A single hop in a metric's propagation path.
 * Direction is implicit: outward from the metric's home entity.
 */
export interface PropagationEdge {
  relationship: string;
  target_entity: string;
  strategy: Strategy;
  weight?: string;
}

/**
 * Defines how a metric propagates from its home entity to foreign entities.
 * Metrics not listed here default to reserve (no propagation needed).
 */
export interface MetricPropagation {
  metric: string;
  path: PropagationEdge[];
}

/**
 * A BFT table. The user declares which entities and metrics to include.
 * Entities determine the grain (what a row represents). Metrics determine
 * what values appear on each row. Propagation paths describe what each
 * metric means on foreign entity rows — they don't determine the grain.
 */
export interface BftTable {
  name: string;
  entities: string[];
  metrics: string[];
}

/**
 * Labels for correction rows in generated output.
 * Correction rows make SUMs correct for reserve and elimination strategies.
 * Both default to "<Unallocated>".
 */
export interface CorrectionLabels {
  reserve_label: string;
  elimination_label: string;
}

export const DEFAULT_CORRECTION_LABELS: CorrectionLabels = {
  reserve_label: "<Unallocated>",
  elimination_label: "<Unallocated>",
};

export interface Manifest {
  entities: Entity[];
  relationships: Relationship[];
  propagations: MetricPropagation[];
  bft_tables: BftTable[];
  correction_labels?: CorrectionLabels;
}
