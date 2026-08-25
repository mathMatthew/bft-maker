import type { LiteralExpression, RequestPlan } from "../request-compiler/types.js";
import { assertValidRequestPlan } from "../request-compiler/validate.js";
import type { BftAggregation, BftOutputMetadataV1 } from "./types.js";

export const BFT_SCHEMA_VERSION_KEY = "bft:schema-version";
export const BFT_OUTPUT_METADATA_KEY = "bft:output-metadata";
export const BFT_OUTPUT_METADATA_VERSION = 1;

const PRODUCER = { name: "bft-maker", version: "0.1.0" } as const;
const ROOT_KEYS = [
  "schemaVersion", "producer", "requestId", "dimensions", "measures",
  "placeholders", "filterConstraints", "internalColumns", "columnStatistics",
  "extensions",
];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is not supported`);
  }
}

function nonEmptyString(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function stringArray(
  value: unknown,
  path: string,
  errors: string[],
  minimum = 0,
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length < minimum) errors.push(`${path} must contain at least ${minimum} item`);
  value.forEach((item, index) => nonEmptyString(item, `${path}[${index}]`, errors));
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function aggregation(
  value: unknown,
  path: string,
  physicalColumns: Set<string>,
  dimensionIds: Set<string>,
  errors: string[],
): BftAggregation | undefined {
  if (!object(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const kind = value.kind;
  let columns: unknown[] = [];
  if (kind === "sum") {
    unknownKeys(value, path, ["kind", "column"], errors);
    columns = [value.column];
  } else if (kind === "sum_ratio") {
    unknownKeys(value, path, ["kind", "numeratorColumn", "denominatorColumn", "zeroDenominator"], errors);
    columns = [value.numeratorColumn, value.denominatorColumn];
    if (value.zeroDenominator !== "null") errors.push(`${path}.zeroDenominator must equal null`);
  } else if (kind === "end_of_period") {
    unknownKeys(value, path, ["kind", "column", "orderDimensionId"], errors);
    columns = [value.column];
    if (nonEmptyString(value.orderDimensionId, `${path}.orderDimensionId`, errors)
      && !dimensionIds.has(value.orderDimensionId)) {
      errors.push(`${path}.orderDimensionId references unknown dimension "${value.orderDimensionId}"`);
    }
  } else {
    errors.push(`${path}.kind must be sum, sum_ratio, or end_of_period`);
    return undefined;
  }
  columns.forEach((column, index) => {
    const name = kind === "sum_ratio"
      ? (index === 0 ? "numeratorColumn" : "denominatorColumn")
      : "column";
    if (nonEmptyString(column, `${path}.${name}`, errors) && !physicalColumns.has(column)) {
      errors.push(`${path}.${name} references missing physical column "${column}"`);
    }
  });
  return value as unknown as BftAggregation;
}

export class BftOutputMetadataValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid BFT output metadata:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "BftOutputMetadataValidationError";
  }
}

export function validateOutputMetadataV1(
  metadata: unknown,
  physicalColumnNames: readonly string[],
): string[] {
  const errors: string[] = [];
  if (!object(metadata)) return ["metadata must be an object"];
  unknownKeys(metadata, "metadata", ROOT_KEYS, errors);
  if (metadata.schemaVersion !== BFT_OUTPUT_METADATA_VERSION) errors.push("metadata.schemaVersion must equal 1");
  if (!object(metadata.producer)) errors.push("metadata.producer must be an object");
  else {
    unknownKeys(metadata.producer, "metadata.producer", ["name", "version"], errors);
    nonEmptyString(metadata.producer.name, "metadata.producer.name", errors);
    nonEmptyString(metadata.producer.version, "metadata.producer.version", errors);
  }
  nonEmptyString(metadata.requestId, "metadata.requestId", errors);

  const physicalColumns = new Set<string>();
  for (const [index, column] of physicalColumnNames.entries()) {
    if (!nonEmptyString(column, `physicalColumns[${index}]`, errors)) continue;
    if (physicalColumns.has(column)) errors.push(`physicalColumns[${index}] duplicates "${column}"`);
    physicalColumns.add(column);
  }

  const dimensionIds = new Set<string>();
  const dimensionColumns = new Map<string, string>();
  if (!Array.isArray(metadata.dimensions)) errors.push("metadata.dimensions must be an array");
  else metadata.dimensions.forEach((raw, index) => {
    const path = `metadata.dimensions[${index}]`;
    if (!object(raw)) {
      errors.push(`${path} must be an object`);
      return;
    }
    unknownKeys(raw, path, ["id", "column"], errors);
    if (nonEmptyString(raw.id, `${path}.id`, errors)) {
      if (dimensionIds.has(raw.id)) errors.push(`${path}.id duplicates "${raw.id}"`);
      dimensionIds.add(raw.id);
    }
    if (nonEmptyString(raw.column, `${path}.column`, errors)) {
      if (!physicalColumns.has(raw.column)) errors.push(`${path}.column references missing physical column "${raw.column}"`);
      if (dimensionColumns.has(raw.column)) errors.push(`${path}.column duplicates dimension column "${raw.column}"`);
      dimensionColumns.set(raw.column, typeof raw.id === "string" ? raw.id : "");
    }
  });

  const measureIds = new Set<string>();
  const visibleSumColumns = new Set<string>();
  if (!Array.isArray(metadata.measures)) errors.push("metadata.measures must be an array");
  else metadata.measures.forEach((raw, index) => {
    const path = `metadata.measures[${index}]`;
    if (!object(raw)) {
      errors.push(`${path} must be an object`);
      return;
    }
    unknownKeys(raw, path, ["id", "defaultAggregation", "dimensionAggregations"], errors);
    if (nonEmptyString(raw.id, `${path}.id`, errors)) {
      if (measureIds.has(raw.id)) errors.push(`${path}.id duplicates "${raw.id}"`);
      measureIds.add(raw.id);
    }
    const route = aggregation(raw.defaultAggregation, `${path}.defaultAggregation`, physicalColumns, dimensionIds, errors);
    if (route?.kind === "sum") visibleSumColumns.add(route.column);
    if (!Array.isArray(raw.dimensionAggregations)) errors.push(`${path}.dimensionAggregations must be an array`);
    else {
      const overrides = new Set<string>();
      raw.dimensionAggregations.forEach((override, overrideIndex) => {
        const overridePath = `${path}.dimensionAggregations[${overrideIndex}]`;
        if (!object(override)) {
          errors.push(`${overridePath} must be an object`);
          return;
        }
        unknownKeys(override, overridePath, ["dimensionId", "when", "aggregation"], errors);
        if (nonEmptyString(override.dimensionId, `${overridePath}.dimensionId`, errors)) {
          if (!dimensionIds.has(override.dimensionId)) errors.push(`${overridePath}.dimensionId references unknown dimension "${override.dimensionId}"`);
          if (overrides.has(override.dimensionId)) errors.push(`${overridePath}.dimensionId duplicates "${override.dimensionId}"`);
          overrides.add(override.dimensionId);
        }
        if (override.when !== "collapsed") errors.push(`${overridePath}.when must equal collapsed`);
        aggregation(override.aggregation, `${overridePath}.aggregation`, physicalColumns, dimensionIds, errors);
      });
    }
  });
  for (const column of visibleSumColumns) {
    if (dimensionColumns.has(column)) errors.push(`physical column "${column}" cannot be both a dimension and a visible sum measure`);
  }

  const eliminationPlaceholderPairs = new Set<string>();
  if (!Array.isArray(metadata.placeholders)) errors.push("metadata.placeholders must be an array");
  else metadata.placeholders.forEach((raw, index) => {
    const path = `metadata.placeholders[${index}]`;
    if (!object(raw)) {
      errors.push(`${path} must be an object`);
      return;
    }
    unknownKeys(raw, path, ["column", "value", "kind", "measureIds"], errors);
    let dimensionId: string | undefined;
    if (nonEmptyString(raw.column, `${path}.column`, errors)) {
      if (!physicalColumns.has(raw.column)) errors.push(`${path}.column references missing physical column "${raw.column}"`);
      dimensionId = dimensionColumns.get(raw.column);
      if (!dimensionId) errors.push(`${path}.column must reference a declared dimension column`);
    }
    if (!["string", "number", "boolean"].includes(typeof raw.value)
      || (typeof raw.value === "number" && !Number.isFinite(raw.value))) {
      errors.push(`${path}.value must be a finite string, number, or boolean`);
    }
    if (raw.kind !== "reserve" && raw.kind !== "elimination") errors.push(`${path}.kind must be reserve or elimination`);
    const ids = stringArray(raw.measureIds, `${path}.measureIds`, errors, 1);
    ids.forEach((id) => {
      if (!measureIds.has(id)) errors.push(`${path}.measureIds references unknown measure "${id}"`);
      if (raw.kind === "elimination" && dimensionId) eliminationPlaceholderPairs.add(`${id}\u0000${dimensionId}`);
    });
  });

  const eliminationConstraintPairs = new Set<string>();
  const constraintIds = new Set<string>();
  if (!Array.isArray(metadata.filterConstraints)) errors.push("metadata.filterConstraints must be an array");
  else metadata.filterConstraints.forEach((raw, index) => {
    const path = `metadata.filterConstraints[${index}]`;
    if (!object(raw)) {
      errors.push(`${path} must be an object`);
      return;
    }
    unknownKeys(raw, path, ["id", "kind", "measureIds", "hierarchy", "selectionMode", "allSelection"], errors);
    if (nonEmptyString(raw.id, `${path}.id`, errors)) {
      if (constraintIds.has(raw.id)) errors.push(`${path}.id duplicates "${raw.id}"`);
      constraintIds.add(raw.id);
    }
    if (raw.kind !== "elimination") errors.push(`${path}.kind must equal elimination`);
    const ids = stringArray(raw.measureIds, `${path}.measureIds`, errors, 1);
    ids.forEach((id) => {
      if (!measureIds.has(id)) errors.push(`${path}.measureIds references unknown measure "${id}"`);
    });
    let levels: string[] = [];
    if (!object(raw.hierarchy)) errors.push(`${path}.hierarchy must be an object`);
    else {
      unknownKeys(raw.hierarchy, `${path}.hierarchy`, ["levels", "correctionsAtEveryHop"], errors);
      levels = stringArray(raw.hierarchy.levels, `${path}.hierarchy.levels`, errors, 1);
      levels.forEach((id) => {
        if (!dimensionIds.has(id)) errors.push(`${path}.hierarchy.levels references unknown dimension "${id}"`);
      });
      if (raw.hierarchy.correctionsAtEveryHop !== true) errors.push(`${path}.hierarchy.correctionsAtEveryHop must equal true`);
    }
    if (raw.selectionMode !== "all_or_single_hierarchy_node") errors.push(`${path}.selectionMode must equal all_or_single_hierarchy_node`);
    if (raw.allSelection !== "no_predicate") errors.push(`${path}.allSelection must equal no_predicate`);
    ids.forEach((measureId) => levels.forEach((dimensionId) => eliminationConstraintPairs.add(`${measureId}\u0000${dimensionId}`)));
  });
  for (const pair of new Set([...eliminationPlaceholderPairs, ...eliminationConstraintPairs])) {
    if (!eliminationPlaceholderPairs.has(pair) || !eliminationConstraintPairs.has(pair)) {
      const [measureId, dimensionId] = pair.split("\u0000");
      errors.push(`elimination placeholders and constraints disagree for measure "${measureId}" and dimension "${dimensionId}"`);
    }
  }

  const internalColumns = new Set<string>();
  if (!Array.isArray(metadata.internalColumns)) errors.push("metadata.internalColumns must be an array");
  else metadata.internalColumns.forEach((raw, index) => {
    const path = `metadata.internalColumns[${index}]`;
    if (!object(raw)) {
      errors.push(`${path} must be an object`);
      return;
    }
    unknownKeys(raw, path, ["column", "reason"], errors);
    if (nonEmptyString(raw.column, `${path}.column`, errors)) {
      if (!physicalColumns.has(raw.column)) errors.push(`${path}.column references missing physical column "${raw.column}"`);
      if (internalColumns.has(raw.column)) errors.push(`${path}.column duplicates "${raw.column}"`);
      if (visibleSumColumns.has(raw.column)) errors.push(`${path}.column exposes an internal component as a visible sum measure`);
      internalColumns.add(raw.column);
    }
    if (!["ratio_component", "weight_component", "correction_offset"].includes(String(raw.reason))) errors.push(`${path}.reason is not supported`);
  });

  if (metadata.columnStatistics !== undefined) {
    if (!Array.isArray(metadata.columnStatistics)) errors.push("metadata.columnStatistics must be an array");
    else {
      const statisticsColumns = new Set<string>();
      metadata.columnStatistics.forEach((raw, index) => {
        const path = `metadata.columnStatistics[${index}]`;
        if (!object(raw)) {
          errors.push(`${path} must be an object`);
          return;
        }
        unknownKeys(raw, path, ["column", "distinctCount", "nullCount"], errors);
        if (nonEmptyString(raw.column, `${path}.column`, errors)) {
          if (!physicalColumns.has(raw.column)) errors.push(`${path}.column references missing physical column "${raw.column}"`);
          if (statisticsColumns.has(raw.column)) errors.push(`${path}.column duplicates "${raw.column}"`);
          statisticsColumns.add(raw.column);
        }
        for (const key of ["distinctCount", "nullCount"] as const) {
          const value = raw[key];
          if ((key === "distinctCount" || value !== undefined)
            && (!Number.isSafeInteger(value) || (value as number) < 0)) {
            errors.push(`${path}.${key} must be a non-negative safe integer`);
          }
        }
      });
    }
  }
  if (metadata.extensions !== undefined && !object(metadata.extensions)) errors.push("metadata.extensions must be an object");
  return errors;
}

export function assertValidOutputMetadataV1(
  metadata: unknown,
  physicalColumnNames: readonly string[],
): asserts metadata is BftOutputMetadataV1 {
  const errors = validateOutputMetadataV1(metadata, physicalColumnNames);
  if (errors.length > 0) throw new BftOutputMetadataValidationError(errors);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalOutputMetadataJson(metadata: BftOutputMetadataV1): string {
  return JSON.stringify(canonicalize(metadata));
}

function literalKey(value: LiteralExpression["value"]): string {
  return JSON.stringify([typeof value, value]);
}

export function produceOutputMetadataV1(plan: RequestPlan): BftOutputMetadataV1 {
  assertValidRequestPlan(plan);
  const dimensions = plan.outputColumns
    .filter((column) => column.role === "dimension")
    .map((column) => ({ id: column.name, column: column.name }));
  const measureOrder = plan.outputColumns
    .filter((column) => column.role === "metric")
    .map((column) => column.name);
  const measures = measureOrder.map((id) => ({
    id,
    defaultAggregation: { kind: "sum" as const, column: id },
    dimensionAggregations: [],
  }));
  const grouped = new Map<string, { column: string; value: string | number | boolean; measureIds: Set<string> }>();
  for (const metric of plan.metrics) {
    for (const [column, literal] of Object.entries(metric.reserveDimensions)) {
      if (literal.value === null) continue;
      const key = `${column}\u0000${literalKey(literal.value)}`;
      const item = grouped.get(key) ?? { column, value: literal.value, measureIds: new Set<string>() };
      item.measureIds.add(metric.name);
      grouped.set(key, item);
    }
  }
  const dimensionOrder = new Map(dimensions.map((item, index) => [item.column, index]));
  const metricOrder = new Map(measureOrder.map((item, index) => [item, index]));
  const placeholders = [...grouped.values()]
    .sort((left, right) =>
      (dimensionOrder.get(left.column) ?? Number.MAX_SAFE_INTEGER)
      - (dimensionOrder.get(right.column) ?? Number.MAX_SAFE_INTEGER)
      || literalKey(left.value).localeCompare(literalKey(right.value)))
    .map((item) => ({
      column: item.column,
      value: item.value,
      kind: "reserve" as const,
      measureIds: [...item.measureIds].sort((left, right) =>
        (metricOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (metricOrder.get(right) ?? Number.MAX_SAFE_INTEGER)),
    }));
  const metadata: BftOutputMetadataV1 = {
    schemaVersion: BFT_OUTPUT_METADATA_VERSION,
    producer: { ...PRODUCER },
    requestId: plan.id,
    dimensions,
    measures,
    placeholders,
    filterConstraints: [],
    internalColumns: [],
  };
  assertValidOutputMetadataV1(metadata, plan.outputColumns.map((column) => column.name));
  return metadata;
}

export function outputMetadataFooter(
  metadata: BftOutputMetadataV1,
  physicalColumnNames: readonly string[],
): Record<string, string> {
  assertValidOutputMetadataV1(metadata, physicalColumnNames);
  return {
    [BFT_SCHEMA_VERSION_KEY]: String(BFT_OUTPUT_METADATA_VERSION),
    [BFT_OUTPUT_METADATA_KEY]: canonicalOutputMetadataJson(metadata),
  };
}
