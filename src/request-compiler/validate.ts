import type {
  Expression,
  JoinDef,
  LiteralExpression,
  MetricDef,
  PopulationDef,
  Predicate,
  RequestPlan,
  SourceRef,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_TYPES = new Set([
  "BOOLEAN", "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
  "REAL", "DOUBLE", "DECIMAL", "VARCHAR", "DATE", "TIMESTAMP",
]);
const PREDICATE_OPERATORS = new Set([
  "equals", "not_equals", "greater_than", "greater_than_or_equal",
  "less_than", "less_than_or_equal", "in", "is_null", "is_not_null",
]);

function canonicalIdentifier(value: string): string {
  return value.toLowerCase();
}

function noUnknownKeys(value: object, path: string, allowed: string[], errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is not supported`);
  }
}

export class RequestPlanValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid request plan:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "RequestPlanValidationError";
  }
}

function identifier(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    errors.push(`${path} must be a valid SQL identifier`);
    return false;
  }
  return true;
}

function sqlType(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !SQL_TYPES.has(value)) {
    errors.push(`${path} must be one of: ${[...SQL_TYPES].join(", ")}`);
  }
}

function literalExpression(
  value: unknown,
  path: string,
  aliases: Set<string>,
  errors: string[],
): value is LiteralExpression {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "literal") {
    errors.push(`${path} must be a typed literal`);
    return false;
  }
  expression(value as LiteralExpression, path, aliases, errors);
  const item = value as LiteralExpression;
  if (item.value === null) return true;
  const numericTypes = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "REAL", "DOUBLE", "DECIMAL"]);
  if (numericTypes.has(item.type) && typeof item.value !== "number") errors.push(`${path}.value must be numeric for ${item.type}`);
  if (item.type === "BOOLEAN" && typeof item.value !== "boolean") errors.push(`${path}.value must be boolean for BOOLEAN`);
  if (["VARCHAR", "DATE", "TIMESTAMP"].includes(item.type) && typeof item.value !== "string") {
    errors.push(`${path}.value must be a string for ${item.type}`);
  }
  return true;
}

function source(
  value: SourceRef,
  path: string,
  knownPopulations: Map<string, Set<string>>,
  aliases: Set<string>,
  errors: string[],
): void {
  if (!value || typeof value !== "object") {
    errors.push(`${path} must be an object`);
    return;
  }
  noUnknownKeys(value, path, ["kind", "schema", "name", "alias"], errors);
  if (value.kind !== "relation" && value.kind !== "population") {
    errors.push(`${path}.kind must be relation or population`);
  }
  identifier(value.name, `${path}.name`, errors);
  if (value.schema !== undefined) identifier(value.schema, `${path}.schema`, errors);
  if (value.kind === "population") {
    if (value.schema !== undefined) errors.push(`${path}.schema is not allowed for a population`);
    if (!knownPopulations.has(canonicalIdentifier(value.name))) errors.push(`${path} references unknown population "${value.name}"`);
  }
  if (identifier(value.alias, `${path}.alias`, errors)) {
    const canonicalAlias = canonicalIdentifier(value.alias);
    if (aliases.has(canonicalAlias)) errors.push(`${path}.alias duplicates alias "${value.alias}"`);
    aliases.add(canonicalAlias);
  }
}

function expression(
  value: Expression,
  path: string,
  aliases: Set<string>,
  errors: string[],
  populationAliases?: Map<string, Set<string>>,
): void {
  if (!value || typeof value !== "object") {
    errors.push(`${path} must be an expression object`);
    return;
  }
  if (value.kind === "column") {
    noUnknownKeys(value, path, ["kind", "alias", "column"], errors);
    if (identifier(value.alias, `${path}.alias`, errors) && !aliases.has(canonicalIdentifier(value.alias))) {
      errors.push(`${path}.alias references unknown alias "${value.alias}"`);
    }
    identifier(value.column, `${path}.column`, errors);
    const projected = populationAliases?.get(canonicalIdentifier(value.alias));
    if (projected && !projected.has(canonicalIdentifier(value.column))) {
      errors.push(`${path}.column references unknown projected population column "${value.column}"`);
    }
    return;
  }
  if (value.kind === "literal") {
    noUnknownKeys(value, path, ["kind", "type", "value"], errors);
    sqlType(value.type, `${path}.type`, errors);
    if (!["string", "number", "boolean"].includes(typeof value.value) && value.value !== null) {
      errors.push(`${path}.value must be a string, number, boolean, or null`);
    }
    if (typeof value.value === "number" && !Number.isFinite(value.value)) {
      errors.push(`${path}.value must be finite`);
    }
    return;
  }
  errors.push(`${path}.kind must be column or literal`);
}

function predicate(value: Predicate, path: string, aliases: Set<string>, errors: string[]): void {
  if (!value || typeof value !== "object") {
    errors.push(`${path} must be an object`);
    return;
  }
  noUnknownKeys(value, path, ["expression", "operator", "value"], errors);
  expression(value.expression, `${path}.expression`, aliases, errors);
  if (!PREDICATE_OPERATORS.has(value.operator)) {
    errors.push(`${path}.operator is not supported`);
    return;
  }
  const unary = value.operator === "is_null" || value.operator === "is_not_null";
  if (unary && value.value !== undefined) errors.push(`${path}.value is not allowed for ${value.operator}`);
  if (!unary && value.value === undefined) errors.push(`${path}.value is required for ${value.operator}`);
  if (value.operator === "in") {
    if (!Array.isArray(value.value) || value.value.length === 0) {
      errors.push(`${path}.value must be a non-empty literal array for in`);
    } else {
      value.value.forEach((item, index) => literalExpression(item, `${path}.value[${index}]`, aliases, errors));
      if (value.value.some((item) => item?.value === null)) errors.push(`${path}.value cannot contain null; use is_null`);
    }
  } else if (!unary && value.value !== undefined) {
    if (Array.isArray(value.value)) errors.push(`${path}.value must be one literal`);
    else {
      if (literalExpression(value.value, `${path}.value`, aliases, errors) && value.value.value === null) {
        errors.push(`${path}.value cannot be null; use is_null or is_not_null`);
      }
    }
  }
}

function joins(
  values: JoinDef[],
  path: string,
  knownPopulations: Map<string, Set<string>>,
  aliases: Set<string>,
  errors: string[],
): void {
  if (!Array.isArray(values)) {
    errors.push(`${path} must be an array`);
    return;
  }
  values.forEach((join, index) => {
    const itemPath = `${path}[${index}]`;
    if (!join || typeof join !== "object") {
      errors.push(`${itemPath} must be an object`);
      return;
    }
    noUnknownKeys(join, itemPath, ["kind", "source", "on"], errors);
    if (join.kind !== "inner" && join.kind !== "left") errors.push(`${itemPath}.kind must be inner or left`);
    const priorAliases = new Set(aliases);
    source(join.source, `${itemPath}.source`, knownPopulations, aliases, errors);
    const newAlias = join.source?.alias;
    if (!Array.isArray(join.on) || join.on.length === 0) {
      errors.push(`${itemPath}.on must be a non-empty array`);
      return;
    }
    join.on.forEach((condition, conditionIndex) => {
      const conditionPath = `${itemPath}.on[${conditionIndex}]`;
      if (!condition || typeof condition !== "object") {
        errors.push(`${conditionPath} must be an object`);
        return;
      }
      noUnknownKeys(condition, conditionPath, ["left", "right"], errors);
      for (const [side, ref] of [["left", condition.left], ["right", condition.right]] as const) {
        if (!ref || typeof ref !== "object") {
          errors.push(`${conditionPath}.${side} must be a column reference`);
          continue;
        }
        noUnknownKeys(ref, `${conditionPath}.${side}`, ["alias", "column"], errors);
        if (identifier(ref.alias, `${conditionPath}.${side}.alias`, errors) && !aliases.has(canonicalIdentifier(ref.alias))) {
          errors.push(`${conditionPath}.${side}.alias references unknown alias "${ref.alias}"`);
        }
        identifier(ref.column, `${conditionPath}.${side}.column`, errors);
      }
      const newAliasCanonical = typeof newAlias === "string" ? canonicalIdentifier(newAlias) : "";
      const leftAlias = typeof condition.left?.alias === "string" ? canonicalIdentifier(condition.left.alias) : "";
      const rightAlias = typeof condition.right?.alias === "string" ? canonicalIdentifier(condition.right.alias) : "";
      const leftNew = leftAlias === newAliasCanonical;
      const rightNew = rightAlias === newAliasCanonical;
      const leftPrior = priorAliases.has(leftAlias);
      const rightPrior = priorAliases.has(rightAlias);
      if (!((leftNew && rightPrior) || (rightNew && leftPrior))) {
        errors.push(`${conditionPath} must connect new alias "${newAlias}" to one prior alias`);
      }
    });
  });
}

function validateQueryBody(
  body: PopulationDef | MetricDef,
  path: string,
  knownPopulations: Map<string, Set<string>>,
  errors: string[],
): { aliases: Set<string>; populationAliases: Map<string, Set<string>> } {
  const aliases = new Set<string>();
  source(body.from, `${path}.from`, knownPopulations, aliases, errors);
  joins(body.joins, `${path}.joins`, knownPopulations, aliases, errors);
  if (!Array.isArray(body.predicates)) errors.push(`${path}.predicates must be an array`);
  else body.predicates.forEach((item, index) => predicate(item, `${path}.predicates[${index}]`, aliases, errors));
  const populationAliases = new Map<string, Set<string>>();
  for (const ref of [body.from, ...(Array.isArray(body.joins) ? body.joins.map((item) => item?.source) : [])]) {
    if (ref?.kind === "population") {
      const projections = knownPopulations.get(canonicalIdentifier(ref.name));
      if (projections) populationAliases.set(canonicalIdentifier(ref.alias), projections);
    }
  }
  const bodyJoins = Array.isArray(body.joins) ? body.joins : [];
  for (let index = 0; index < bodyJoins.length; index++) {
    const join = bodyJoins[index];
    if (!join || !Array.isArray(join.on)) continue;
    join.on.forEach((condition, conditionIndex) => {
      if (!condition) return;
      for (const [side, ref] of [["left", condition.left], ["right", condition.right]] as const) {
        if (!ref) continue;
        const projections = populationAliases.get(canonicalIdentifier(ref.alias));
        if (projections && !projections.has(canonicalIdentifier(ref.column))) {
          errors.push(`${path}.joins[${index}].on[${conditionIndex}].${side}.column references unknown projected population column "${ref.column}"`);
        }
      }
    });
  }
  if (Array.isArray(body.predicates)) {
    body.predicates.forEach((item, index) => {
      if (item?.expression) expression(item.expression, `${path}.predicates[${index}].expression`, aliases, errors, populationAliases);
    });
  }
  return { aliases, populationAliases };
}

export function validateRequestPlan(plan: RequestPlan): string[] {
  const errors: string[] = [];
  if (!plan || typeof plan !== "object") return ["request plan must be an object"];
  noUnknownKeys(plan, "requestPlan", ["schemaVersion", "dialect", "id", "outputColumns", "populations", "metrics", "orderBy"], errors);
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (plan.dialect !== "duckdb") errors.push("dialect must be duckdb");
  identifier(plan.id, "id", errors);

  const outputNames = new Set<string>();
  const canonicalOutputNames = new Set<string>();
  const dimensionNames = new Set<string>();
  const metricNames = new Set<string>();
  if (!Array.isArray(plan.outputColumns) || plan.outputColumns.length === 0) {
    errors.push("outputColumns must be a non-empty array");
  } else {
    plan.outputColumns.forEach((column, index) => {
      const path = `outputColumns[${index}]`;
      if (!column || typeof column !== "object") {
        errors.push(`${path} must be an object`);
        return;
      }
      noUnknownKeys(column, path, ["name", "type", "role"], errors);
      if (identifier(column.name, `${path}.name`, errors)) {
        const canonicalName = canonicalIdentifier(column.name);
        if (canonicalOutputNames.has(canonicalName)) errors.push(`${path}.name duplicates "${column.name}"`);
        canonicalOutputNames.add(canonicalName);
        outputNames.add(column.name);
        if (column.role === "dimension") dimensionNames.add(column.name);
        if (column.role === "metric") metricNames.add(column.name);
      }
      sqlType(column.type, `${path}.type`, errors);
      if (column.role !== "dimension" && column.role !== "metric") errors.push(`${path}.role must be dimension or metric`);
    });
  }

  const knownPopulations = new Map<string, Set<string>>();
  if (!Array.isArray(plan.populations)) errors.push("populations must be an array");
  else plan.populations.forEach((population, index) => {
    const path = `populations[${index}]`;
    if (!population || typeof population !== "object") {
      errors.push(`${path} must be an object`);
      return;
    }
    noUnknownKeys(population, path, ["name", "from", "joins", "projections", "predicates"], errors);
    if (identifier(population.name, `${path}.name`, errors)) {
      if (knownPopulations.has(canonicalIdentifier(population.name))) errors.push(`${path}.name duplicates "${population.name}"`);
    }
    const { aliases, populationAliases } = validateQueryBody(population, path, knownPopulations, errors);
    if (!population.projections || typeof population.projections !== "object" || Array.isArray(population.projections)) {
      errors.push(`${path}.projections must be an object`);
    } else {
      const canonicalProjectionNames = new Set<string>();
      for (const [name, value] of Object.entries(population.projections)) {
        identifier(name, `${path}.projections.${name}`, errors);
        const canonicalName = canonicalIdentifier(name);
        if (canonicalProjectionNames.has(canonicalName)) errors.push(`${path}.projections.${name} duplicates a projected column by case-insensitive name`);
        canonicalProjectionNames.add(canonicalName);
        expression(value, `${path}.projections.${name}`, aliases, errors, populationAliases);
      }
    }
    if (IDENTIFIER.test(population.name)) {
      const canonicalName = canonicalIdentifier(population.name);
      if (canonicalName === "__bft_combined_metric_rows" || canonicalName.startsWith("__bft_metric_")) {
        errors.push(`${path}.name uses reserved compiler namespace "__bft_"`);
      }
      knownPopulations.set(canonicalName, new Set(Object.keys(population.projections ?? {}).map(canonicalIdentifier)));
    }
  });

  const seenMetrics = new Set<string>();
  if (!Array.isArray(plan.metrics) || plan.metrics.length === 0) errors.push("metrics must be a non-empty array");
  else plan.metrics.forEach((metric, index) => {
    const path = `metrics[${index}]`;
    if (!metric || typeof metric !== "object") {
      errors.push(`${path} must be an object`);
      return;
    }
    noUnknownKeys(metric, path, ["name", "type", "aggregation", "from", "joins", "expression", "dimensions", "reserveDimensions", "predicates"], errors);
    if (identifier(metric.name, `${path}.name`, errors)) {
      const canonicalName = canonicalIdentifier(metric.name);
      if (seenMetrics.has(canonicalName)) errors.push(`${path}.name duplicates "${metric.name}"`);
      if (!metricNames.has(metric.name)) errors.push(`${path}.name is not a metric output column`);
      seenMetrics.add(canonicalName);
    }
    sqlType(metric.type, `${path}.type`, errors);
    const outputType = Array.isArray(plan.outputColumns)
      ? plan.outputColumns.find((column) => column?.name === metric.name)?.type
      : undefined;
    if (outputType && outputType !== metric.type) errors.push(`${path}.type does not match output column type ${outputType}`);
    if (metric.aggregation !== "sum") errors.push(`${path}.aggregation must be sum`);
    const { aliases, populationAliases } = validateQueryBody(metric, path, knownPopulations, errors);
    expression(metric.expression, `${path}.expression`, aliases, errors, populationAliases);
    const natural = metric.dimensions && typeof metric.dimensions === "object" ? metric.dimensions : {};
    const reserve = metric.reserveDimensions && typeof metric.reserveDimensions === "object" ? metric.reserveDimensions : {};
    for (const dimension of dimensionNames) {
      const naturalValue = natural[dimension];
      const reserveValue = reserve[dimension];
      if ((naturalValue === undefined) === (reserveValue === undefined)) {
        errors.push(`${path} must define exactly one of dimensions.${dimension} or reserveDimensions.${dimension}`);
      }
    }
    for (const [name, value] of Object.entries(natural)) {
      if (!dimensionNames.has(name)) errors.push(`${path}.dimensions.${name} is not a dimension output column`);
      expression(value, `${path}.dimensions.${name}`, aliases, errors, populationAliases);
    }
    for (const [name, value] of Object.entries(reserve)) {
      if (!dimensionNames.has(name)) errors.push(`${path}.reserveDimensions.${name} is not a dimension output column`);
      if (!literalExpression(value, `${path}.reserveDimensions.${name}`, aliases, errors)) {
        continue;
      }
      if (value.value === null) errors.push(`${path}.reserveDimensions.${name} cannot be null`);
      const dimensionType = Array.isArray(plan.outputColumns)
        ? plan.outputColumns.find((column) => column?.name === name)?.type
        : undefined;
      if (dimensionType && value.type !== dimensionType) {
        errors.push(`${path}.reserveDimensions.${name}.type does not match output column type ${dimensionType}`);
      }
    }
  });
  for (const name of metricNames) if (!seenMetrics.has(canonicalIdentifier(name))) errors.push(`metric output column "${name}" has no metric definition`);

  if (plan.orderBy !== undefined) {
    if (!Array.isArray(plan.orderBy)) errors.push("orderBy must be an array");
    else plan.orderBy.forEach((order, index) => {
      if (!order || typeof order !== "object") {
        errors.push(`orderBy[${index}] must be an object`);
        return;
      }
      noUnknownKeys(order, `orderBy[${index}]`, ["column", "direction"], errors);
      if (!outputNames.has(order.column)) errors.push(`orderBy[${index}].column references unknown output column "${order.column}"`);
      if (order.direction !== "asc" && order.direction !== "desc") errors.push(`orderBy[${index}].direction must be asc or desc`);
    });
  }
  return errors;
}

export function assertValidRequestPlan(plan: RequestPlan): void {
  const errors = validateRequestPlan(plan);
  if (errors.length > 0) throw new RequestPlanValidationError(errors);
}
