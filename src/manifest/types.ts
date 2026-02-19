export type Strategy =
  | "reserve"
  | "elimination"
  | "allocation"
  | "sum_over_sum"
  | "direct";

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

export interface Relationship {
  name: string;
  between: [string, string];
  type: "many-to-many" | "many-to-one";
  estimated_links: number;
  weight_column?: string;
}

export interface TraversalRule {
  metric: string;
  on_foreign_rows: Strategy;
  weight?: string;
  weight_source?: string;
}

export interface MetricCluster {
  name: string;
  metrics: string[];
  traversals: TraversalRule[];
}

export interface ResolvedMetric {
  metric: string;
  strategy: Strategy;
  weight?: string;
  weight_column?: string;
  sum_safe: boolean;
  requires_reserve_rows: boolean;
}

export interface BftTable {
  name: string;
  grain: string;
  grain_entities: string[];
  clusters_served: string[];
  estimated_rows: number;
  metrics: ResolvedMetric[];
  reserve_rows: string[];
}

export interface Manifest {
  entities: Entity[];
  relationships: Relationship[];
  metric_clusters: MetricCluster[];
  bft_tables: BftTable[];
}
