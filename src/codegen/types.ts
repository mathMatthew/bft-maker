import type { Strategy } from "../manifest/types.js";
import type { MetricHome } from "../manifest/helpers.js";

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
  home: MetricHome;
  nature: "additive" | "non-additive";
  /** Source column name in the CSV/table (defaults to name if not overridden). */
  sourceColumn: string;

  /** Strategy for each non-home entity in the compute grain */
  propagatedDimensions: DimensionStrategy[];

  /** The grain at which this metric is computed (home + propagation targets).
   *  May include entities not in BFT grain (to be summarized out). */
  computeGrain: string[];

  /** BFT entities not in computeGrain — reserve treatment. */
  reserveDimensions: string[];

  /** Entities in computeGrain not in BFT grain — aggregated out after computation. */
  summarizeOut: string[];

}

/**
 * Metrics sharing the same computeGrain are grouped for shared SQL generation.
 */
export interface GrainGroup {
  id: string;                    // CTE naming prefix
  grain: string[];               // the shared computeGrain
  joinChain: JoinLink[];         // how to join entities at this grain
  metrics: MetricPlan[];         // metrics computed at this grain
  needsSummarization: boolean;   // true if grain includes non-BFT entities
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
  bftGrain: string[];
  grainGroups: GrainGroup[];
  bftJoinChain: JoinLink[];
}

/**
 * Output of the generator: SQL strings ready to write to files.
 */
export interface GeneratedOutput {
  loadDataSQL: string;
  tables: { name: string; sql: string }[];
  runScript: string;
}
