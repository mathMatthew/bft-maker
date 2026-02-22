import type { Strategy } from "../manifest/types.js";

/**
 * Maps entity/relationship names to database table and column names.
 * Keeps naming conventions out of the manifest.
 */
export interface SourceMapping {
  entities: Record<string, EntitySource>;
  relationships: Record<string, RelationshipSource>;
}

export interface EntitySource {
  table: string;
  idColumn: string;
  labelColumn: string;
}

export interface RelationshipSource {
  table: string;
  /** Column names keyed by entity name. E.g. { Student: "student_id", Class: "class_id" } */
  columns: Record<string, string>;
}

/**
 * Strategy resolved for a single metric on a single foreign entity dimension.
 */
export interface DimensionStrategy {
  entity: string;
  strategy: Strategy;
  relationship: string;
  /** For multi-hop allocation: which hop index (0-based) in the propagation path */
  hopIndex?: number;
}

/**
 * Full analysis of one metric within one BFT table.
 */
export interface MetricPlan {
  name: string;
  homeEntity: string;
  nature: "additive" | "non-additive";
  /** Strategy for each non-home entity in the table */
  dimensions: DimensionStrategy[];
  /** Shorthand classification for SQL generation */
  behavior:
    | "fully_allocated"   // all dims are allocation
    | "sum_over_sum"      // non-additive, sum/sum for some dims
    | "pure_elimination"  // all dims are elimination (no reserve interaction)
    | "pure_reserve"      // all dims are reserve (no propagation)
    | "mixed";            // elimination for some dims, reserve for others
}

/**
 * A link in the join chain connecting entities in the base grain.
 */
export interface JoinLink {
  fromEntity: string;
  toEntity: string;
  relationship: string;
  junctionTable: string;
  fromColumn: string;
  toColumn: string;
}

/**
 * Complete build plan for one BFT table.
 */
export interface TablePlan {
  tableName: string;
  entities: string[];
  joinChain: JoinLink[];
  metrics: MetricPlan[];
}

/**
 * Output of the generator: SQL strings ready to write to files.
 */
export interface GeneratedOutput {
  loadDataSQL: string;
  tables: { name: string; sql: string }[];
  runScript: string;
}
