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
 * A BFT table. Grain is derived from the union of all entities
 * across all included metrics' propagation paths.
 */
export interface BftTable {
  name: string;
  metrics: string[];
}

export interface Manifest {
  entities: Entity[];
  relationships: Relationship[];
  propagations: MetricPropagation[];
  bft_tables: BftTable[];
}
