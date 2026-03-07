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
  type: "currency" | "integer" | "float" | "rating" | "percentage" | "score";
  nature: "additive" | "non-additive";
  /** Override the source column name if it differs from the metric name. */
  source_column?: string;
  /** Stock metric: use weighted average (not SUM) when summarizing out time dimensions. */
  stock?: boolean;
}

export interface Entity {
  name: string;
  role: "leaf" | "bridge";
  detail: boolean;
  estimated_rows: number;
  metrics: MetricDef[];
  /** Override the default table name (default: pluralized lowercase entity name). */
  source_table?: string;
  /** Override the default id column name (default: lowercase_name + "_id"). */
  id_column?: string;
  /** Override the default label column name (default: "name"). */
  label_column?: string;
}

/** Relationships are undirected — they describe what joins exist. */
export interface Relationship {
  name: string;
  between: [string, string];
  type: "many-to-many" | "many-to-one";
  estimated_links: number;
  weight_column?: string;
  metrics?: MetricDef[];
  /** Override the default table name (default: pluralized lowercase relationship name). */
  source_table?: string;
  /** Override the default foreign key column names. Keys are entity names, values are column names. */
  columns?: Record<string, string>;
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
 * Labels for placeholder values in entity columns. When a metric's value
 * appears on a row that isn't about a specific foreign entity, the foreign
 * entity column shows this label. Both default to "<Unallocated>".
 */
export interface PlaceholderLabels {
  reserve?: string;
  elimination?: string;
}

export const DEFAULT_PLACEHOLDER_LABELS: Required<PlaceholderLabels> = {
  reserve: "<Unallocated>",
  elimination: "<Unallocated>",
};

export type TimeGranularity = "day" | "week" | "month" | "quarter" | "year";
export type TimeWeighting = "days" | "equal";

export const VALID_TIME_GRANULARITIES: ReadonlySet<string> = new Set([
  "day", "week", "month", "quarter", "year",
]);

export const VALID_TIME_WEIGHTINGS: ReadonlySet<string> = new Set([
  "days", "equal",
]);

export interface TimeDeclaration {
  /** Which entity is the finest time grain. */
  entity: string;
  /** Date column on the time entity's source table. */
  column: string;
  /** What each row represents. */
  granularity: TimeGranularity;
  /** How to weight stock metrics: 'days' (day-weighted) or 'equal' (each period = 1). Default: 'days'. */
  weighting?: TimeWeighting;
}

export interface Manifest {
  entities: Entity[];
  relationships: Relationship[];
  propagations: MetricPropagation[];
  bft_tables: BftTable[];
  placeholder_labels?: PlaceholderLabels;
  time?: TimeDeclaration;
}
