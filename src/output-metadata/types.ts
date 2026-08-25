export interface BftProducer {
  name: string;
  version: string;
}

export interface BftDimension {
  id: string;
  column: string;
}

export interface SumAggregation {
  kind: "sum";
  column: string;
}

export interface SumRatioAggregation {
  kind: "sum_ratio";
  numeratorColumn: string;
  denominatorColumn: string;
  zeroDenominator: "null";
}

export interface EndOfPeriodAggregation {
  kind: "end_of_period";
  column: string;
  orderDimensionId: string;
}

export type BftAggregation =
  | SumAggregation
  | SumRatioAggregation
  | EndOfPeriodAggregation;

export interface DimensionAggregation {
  dimensionId: string;
  when: "collapsed";
  aggregation: BftAggregation;
}

export interface BftMeasure {
  id: string;
  defaultAggregation: BftAggregation;
  dimensionAggregations: DimensionAggregation[];
}

export interface BftPlaceholder {
  column: string;
  value: string | number | boolean;
  kind: "reserve" | "elimination";
  measureIds: string[];
}

export interface EliminationFilterConstraint {
  id: string;
  kind: "elimination";
  measureIds: string[];
  hierarchy: {
    levels: string[];
    correctionsAtEveryHop: true;
  };
  selectionMode: "all_or_single_hierarchy_node";
  allSelection: "no_predicate";
}

export interface BftInternalColumn {
  column: string;
  reason: "ratio_component" | "weight_component" | "correction_offset";
}

export interface BftColumnStatistics {
  column: string;
  distinctCount: number;
  nullCount?: number;
}

export interface BftOutputMetadataV1 {
  schemaVersion: 1;
  producer: BftProducer;
  requestId: string;
  dimensions: BftDimension[];
  measures: BftMeasure[];
  placeholders: BftPlaceholder[];
  filterConstraints: EliminationFilterConstraint[];
  internalColumns: BftInternalColumn[];
  columnStatistics?: BftColumnStatistics[];
  extensions?: Record<string, unknown>;
}
