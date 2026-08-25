import type {
  ColumnRef,
  CompiledRequest,
  Expression,
  JoinDef,
  LiteralExpression,
  MetricDef,
  Predicate,
  RequestPlan,
  SourceRef,
} from "./types.js";
import { assertValidRequestPlan } from "./validate.js";
import {
  canonicalOutputMetadataJson,
  produceOutputMetadataV1,
} from "../output-metadata/metadata.js";

function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function column(ref: ColumnRef): string {
  return `${q(ref.alias)}.${q(ref.column)}`;
}

function literal(expression: LiteralExpression): string {
  let value: string;
  if (expression.value === null) value = "NULL";
  else if (typeof expression.value === "string") value = `'${expression.value.replace(/'/g, "''")}'`;
  else if (typeof expression.value === "boolean") value = expression.value ? "TRUE" : "FALSE";
  else value = String(expression.value);
  return `CAST(${value} AS ${expression.type})`;
}

function expr(expression: Expression): string {
  return expression.kind === "column" ? column(expression) : literal(expression);
}

function source(ref: SourceRef): string {
  const name = ref.kind === "relation" && ref.schema
    ? `${q(ref.schema)}.${q(ref.name)}`
    : q(ref.name);
  return `${name} AS ${q(ref.alias)}`;
}

function join(definition: JoinDef): string {
  const kind = definition.kind === "left" ? "LEFT JOIN" : "JOIN";
  const conditions = definition.on
    .map((condition) => `${column(condition.left)} = ${column(condition.right)}`)
    .join(" AND ");
  return `${kind} ${source(definition.source)} ON ${conditions}`;
}

function predicate(definition: Predicate): string {
  const left = expr(definition.expression);
  switch (definition.operator) {
    case "equals": return `${left} = ${literal(definition.value as LiteralExpression)}`;
    case "not_equals": return `${left} <> ${literal(definition.value as LiteralExpression)}`;
    case "greater_than": return `${left} > ${literal(definition.value as LiteralExpression)}`;
    case "greater_than_or_equal": return `${left} >= ${literal(definition.value as LiteralExpression)}`;
    case "less_than": return `${left} < ${literal(definition.value as LiteralExpression)}`;
    case "less_than_or_equal": return `${left} <= ${literal(definition.value as LiteralExpression)}`;
    case "in": return `${left} IN (${(definition.value as LiteralExpression[]).map(literal).join(", ")})`;
    case "is_null": return `${left} IS NULL`;
    case "is_not_null": return `${left} IS NOT NULL`;
  }
}

function fromAndWhere(from: SourceRef, joins: JoinDef[], predicates: Predicate[]): string[] {
  const lines = [`FROM ${source(from)}`, ...joins.map(join)];
  if (predicates.length > 0) {
    lines.push("WHERE " + predicates.map(predicate).join("\n  AND "));
  }
  return lines;
}

function populationSql(plan: RequestPlan, index: number): string {
  const population = plan.populations[index];
  const projections = Object.entries(population.projections)
    .map(([name, expression]) => `  ${expr(expression)} AS ${q(name)}`);
  return [
    `${q(population.name)} AS (`,
    "SELECT",
    projections.join(",\n"),
    ...fromAndWhere(population.from, population.joins, population.predicates),
    ")",
  ].join("\n");
}

function metricCteName(index: number, metric: MetricDef): string {
  return `__bft_metric_${String(index + 1).padStart(2, "0")}_${metric.name}`;
}

function metricSql(plan: RequestPlan, metric: MetricDef, index: number): string {
  const dimensions = plan.outputColumns.filter((output) => output.role === "dimension");
  const selects = dimensions.map((output) => {
    const expression = metric.dimensions[output.name] ?? metric.reserveDimensions[output.name];
    return `  CAST(${expr(expression)} AS ${output.type}) AS ${q(output.name)}`;
  });
  selects.push(`  CAST(SUM(${expr(metric.expression)}) AS ${metric.type}) AS ${q(metric.name)}`);
  const naturalExpressions = dimensions
    .filter((output) => metric.dimensions[output.name] !== undefined)
    .map((output) => `CAST(${expr(metric.dimensions[output.name])} AS ${output.type})`);
  const lines = [
    `${q(metricCteName(index, metric))} AS (`,
    "SELECT",
    selects.join(",\n"),
    ...fromAndWhere(metric.from, metric.joins, metric.predicates),
  ];
  if (naturalExpressions.length > 0) lines.push(`GROUP BY ${naturalExpressions.join(", ")}`);
  else lines.push("HAVING COUNT(*) > 0");
  lines.push(")");
  return lines.join("\n");
}

function combinedSql(plan: RequestPlan): string {
  const branches = plan.metrics.map((metric, index) => {
    const columns = plan.outputColumns.map((output) => {
      if (output.role === "dimension" || output.name === metric.name) return q(output.name);
      return `CAST(NULL AS ${output.type}) AS ${q(output.name)}`;
    });
    return `SELECT\n  ${columns.join(",\n  ")}\nFROM ${q(metricCteName(index, metric))}`;
  });
  return `${q("__bft_combined_metric_rows")} AS (\n${branches.join("\nUNION ALL\n")}\n)`;
}

function assembledSql(plan: RequestPlan, includeOrder: boolean): string {
  const dimensions = plan.outputColumns.filter((output) => output.role === "dimension");
  const metrics = plan.outputColumns.filter((output) => output.role === "metric");
  const ctes = [
    ...plan.populations.map((_, index) => populationSql(plan, index)),
    ...plan.metrics.map((metric, index) => metricSql(plan, metric, index)),
    combinedSql(plan),
  ];
  const selects = plan.outputColumns.map((output) => output.role === "dimension"
    ? q(output.name)
    : `CAST(SUM(${q(output.name)}) AS ${output.type}) AS ${q(output.name)}`);
  const lines = [
    `WITH\n${ctes.join(",\n")}`,
    "SELECT",
    selects.map((item) => `  ${item}`).join(",\n"),
    `FROM ${q("__bft_combined_metric_rows")}`,
  ];
  if (dimensions.length > 0) lines.push(`GROUP BY ${dimensions.map((output) => q(output.name)).join(", ")}`);
  if (includeOrder && plan.orderBy && plan.orderBy.length > 0) {
    lines.push("ORDER BY " + plan.orderBy.map((item) => `${q(item.column)} ${item.direction.toUpperCase()}`).join(", "));
  }
  return lines.join("\n");
}

export function compileRequest(plan: RequestPlan): CompiledRequest {
  assertValidRequestPlan(plan);
  const materializationSql = assembledSql(plan, true);
  const countSql = `SELECT COUNT(*)::BIGINT AS ${q("row_count")} FROM (\n${assembledSql(plan, false)}\n) AS ${q("compiled_request")}`;
  const dimensions = plan.outputColumns.filter((column) => column.role === "dimension").map((column) => column.name);
  const metrics = plan.outputColumns.filter((column) => column.role === "metric").map((column) => column.name);
  const outputMetadata = produceOutputMetadataV1(plan);
  return {
    materializationSql,
    countSql,
    metadata: {
      requestId: plan.id,
      dimensions,
      metrics,
      reserveDimensions: Object.fromEntries(plan.metrics.map((metric) => [metric.name, Object.keys(metric.reserveDimensions)])),
    },
    outputMetadata,
    outputMetadataJson: canonicalOutputMetadataJson(outputMetadata),
  };
}
