export type SqlType =
  | "BOOLEAN"
  | "TINYINT"
  | "SMALLINT"
  | "INTEGER"
  | "BIGINT"
  | "HUGEINT"
  | "REAL"
  | "DOUBLE"
  | "DECIMAL"
  | "VARCHAR"
  | "DATE"
  | "TIMESTAMP";

export interface ColumnRef {
  alias: string;
  column: string;
}

export interface ColumnExpression extends ColumnRef {
  kind: "column";
}

export interface LiteralExpression {
  kind: "literal";
  type: SqlType;
  value: string | number | boolean | null;
}

export type Expression = ColumnExpression | LiteralExpression;

export interface SourceRef {
  kind: "relation" | "population";
  schema?: string;
  name: string;
  alias: string;
}

export interface JoinCondition {
  left: ColumnRef;
  right: ColumnRef;
}

export interface JoinDef {
  kind: "inner" | "left";
  source: SourceRef;
  on: JoinCondition[];
}

export type PredicateOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "in"
  | "is_null"
  | "is_not_null";

export interface Predicate {
  expression: Expression;
  operator: PredicateOperator;
  value?: LiteralExpression | LiteralExpression[];
}

export interface OutputColumn {
  name: string;
  type: SqlType;
  role: "dimension" | "metric";
}

export interface PopulationDef {
  name: string;
  from: SourceRef;
  joins: JoinDef[];
  projections: Record<string, Expression>;
  predicates: Predicate[];
}

export interface MetricDef {
  name: string;
  type: SqlType;
  aggregation: "sum";
  from: SourceRef;
  joins: JoinDef[];
  expression: Expression;
  dimensions: Record<string, Expression>;
  reserveDimensions: Record<string, LiteralExpression>;
  predicates: Predicate[];
}

export interface OrderByDef {
  column: string;
  direction: "asc" | "desc";
}

export interface RequestPlan {
  schemaVersion: 1;
  dialect: "duckdb";
  id: string;
  outputColumns: OutputColumn[];
  populations: PopulationDef[];
  metrics: MetricDef[];
  orderBy?: OrderByDef[];
}

export interface RequestCompilerMetadata {
  requestId: string;
  dimensions: string[];
  metrics: string[];
  reserveDimensions: Record<string, string[]>;
}

export interface CompiledRequest {
  materializationSql: string;
  countSql: string;
  metadata: RequestCompilerMetadata;
  outputMetadata: import("../output-metadata/types.js").BftOutputMetadataV1;
  outputMetadataJson: string;
}
