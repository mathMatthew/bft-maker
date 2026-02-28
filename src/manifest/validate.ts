import type { Manifest, Entity } from "./types.js";
import { VALID_STRATEGIES } from "./types.js";
import { buildMetricHomeMap, findMetricDef } from "./helpers.js";
import type { MetricHome } from "./helpers.js";

export interface ValidationError {
  rule: string;
  message: string;
  path?: string;
  severity?: "error" | "warning";
}

export function validate(manifest: Manifest): ValidationError[] {
  const errors: ValidationError[] = [];

  const entityMap = buildEntityMap(manifest.entities);
  const metricHome = buildMetricHomeMap(manifest.entities, manifest.relationships);
  const relationshipNames = new Set(
    manifest.relationships.map((r) => r.name)
  );

  checkIdentifierNames(manifest, errors);
  checkMetricTypes(manifest, errors);
  checkDuplicateNames(manifest, errors);
  checkPositiveCardinalities(manifest, errors);
  checkRelationshipEntities(manifest, entityMap, errors);
  checkPropagations(manifest, entityMap, metricHome, relationshipNames, errors);
  checkTableEntities(manifest, entityMap, errors);
  checkTableMetrics(manifest, metricHome, errors);
  checkUnreachableMetrics(manifest, metricHome, errors);
  return errors;
}

function buildEntityMap(entities: Entity[]): Map<string, Entity> {
  return new Map(entities.map((e) => [e.name, e]));
}

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Rule: All names must be valid SQL identifiers (letters, digits, underscores)
function checkIdentifierNames(
  manifest: Manifest,
  errors: ValidationError[]
): void {
  function check(name: string, kind: string, path: string): void {
    if (!VALID_IDENTIFIER.test(name)) {
      errors.push({
        rule: "valid-identifier",
        message: `${kind} "${name}" has an invalid name: must contain only letters, digits, and underscores, and start with a letter or underscore`,
        path,
      });
    }
  }

  for (const entity of manifest.entities) {
    check(entity.name, "Entity", `entities.${entity.name}`);
    if (entity.source_table) {
      check(entity.source_table, "Entity source_table", `entities.${entity.name}.source_table`);
    }
    if (entity.id_column) {
      check(entity.id_column, "Entity id_column", `entities.${entity.name}.id_column`);
    }
    if (entity.label_column) {
      check(entity.label_column, "Entity label_column", `entities.${entity.name}.label_column`);
    }
    for (const metric of entity.metrics) {
      check(metric.name, "Metric", `entities.${entity.name}.metrics.${metric.name}`);
      if (metric.source_column) {
        check(metric.source_column, "Metric source_column", `entities.${entity.name}.metrics.${metric.name}.source_column`);
      }
    }
  }
  for (const rel of manifest.relationships) {
    check(rel.name, "Relationship", `relationships.${rel.name}`);
    if (rel.source_table) {
      check(rel.source_table, "Relationship source_table", `relationships.${rel.name}.source_table`);
    }
    if (rel.columns) {
      for (const [entityName, colName] of Object.entries(rel.columns)) {
        check(colName, "Relationship column", `relationships.${rel.name}.columns.${entityName}`);
      }
    }
    if (rel.metrics) {
      for (const metric of rel.metrics) {
        check(metric.name, "Metric", `relationships.${rel.name}.metrics.${metric.name}`);
        if (metric.source_column) {
          check(metric.source_column, "Metric source_column", `relationships.${rel.name}.metrics.${metric.name}.source_column`);
        }
      }
    }
  }
  for (const table of manifest.bft_tables) {
    check(table.name, "Table", `bft_tables.${table.name}`);
  }
}

const VALID_METRIC_TYPES: ReadonlySet<string> = new Set([
  "currency", "integer", "float", "rating", "percentage", "score",
]);

// Rule: All metric type values must be one of the allowed types
function checkMetricTypes(
  manifest: Manifest,
  errors: ValidationError[]
): void {
  function check(type: string, metricName: string, path: string): void {
    if (!VALID_METRIC_TYPES.has(type)) {
      errors.push({
        rule: "valid-metric-type",
        message: `Metric "${metricName}" has invalid type "${type}" — must be one of: ${[...VALID_METRIC_TYPES].join(", ")}`,
        path,
      });
    }
  }

  for (const entity of manifest.entities) {
    for (const metric of entity.metrics) {
      check(metric.type, metric.name, `entities.${entity.name}.metrics.${metric.name}.type`);
    }
  }
  for (const rel of manifest.relationships) {
    if (rel.metrics) {
      for (const metric of rel.metrics) {
        check(metric.type, metric.name, `relationships.${rel.name}.metrics.${metric.name}.type`);
      }
    }
  }
}

// Rule: No duplicate entity names, metric names, relationship names, or table names
function checkDuplicateNames(
  manifest: Manifest,
  errors: ValidationError[]
): void {
  checkDuplicates(
    manifest.entities.map((e) => e.name),
    "entity",
    errors
  );

  const allMetrics: string[] = [];
  for (const entity of manifest.entities) {
    for (const metric of entity.metrics) {
      allMetrics.push(metric.name);
    }
  }
  for (const rel of manifest.relationships) {
    if (rel.metrics) {
      for (const metric of rel.metrics) {
        allMetrics.push(metric.name);
      }
    }
  }
  checkDuplicates(allMetrics, "metric", errors);

  checkDuplicates(
    manifest.relationships.map((r) => r.name),
    "relationship",
    errors
  );

  checkDuplicates(
    manifest.propagations.map((p) => p.metric),
    "propagation",
    errors
  );

  checkDuplicates(
    manifest.bft_tables.map((t) => t.name),
    "table",
    errors
  );
}

function checkDuplicates(
  names: string[],
  kind: string,
  errors: ValidationError[]
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      errors.push({
        rule: "no-duplicates",
        message: `Duplicate ${kind} name: "${name}"`,
        path: `${kind}s.${name}`,
      });
    }
    seen.add(name);
  }
}

// Rule: Estimated rows/links must be positive integers
function checkPositiveCardinalities(
  manifest: Manifest,
  errors: ValidationError[]
): void {
  for (const entity of manifest.entities) {
    if (
      !Number.isInteger(entity.estimated_rows) ||
      entity.estimated_rows <= 0
    ) {
      errors.push({
        rule: "positive-cardinality",
        message: `Entity "${entity.name}" has invalid estimated_rows: ${entity.estimated_rows} (must be a positive integer)`,
        path: `entities.${entity.name}.estimated_rows`,
      });
    }
  }
  for (const rel of manifest.relationships) {
    if (!Number.isInteger(rel.estimated_links) || rel.estimated_links <= 0) {
      errors.push({
        rule: "positive-cardinality",
        message: `Relationship "${rel.name}" has invalid estimated_links: ${rel.estimated_links} (must be a positive integer)`,
        path: `relationships.${rel.name}.estimated_links`,
      });
    }
  }
}

// Rule: All entity names referenced in relationships must exist
function checkRelationshipEntities(
  manifest: Manifest,
  entityMap: Map<string, Entity>,
  errors: ValidationError[]
): void {
  for (const rel of manifest.relationships) {
    if (!Array.isArray(rel.between) || rel.between.length !== 2) {
      errors.push({
        rule: "relationship-between-pair",
        message: `Relationship "${rel.name}" must have exactly 2 entities in "between", got ${Array.isArray(rel.between) ? rel.between.length : typeof rel.between}`,
        path: `relationships.${rel.name}.between`,
      });
      continue;
    }
    for (const entityName of rel.between) {
      if (!entityMap.has(entityName)) {
        errors.push({
          rule: "relationship-entity-exists",
          message: `Relationship "${rel.name}" references nonexistent entity "${entityName}"`,
          path: `relationships.${rel.name}.between`,
        });
      }
    }
  }
}

// Rule: Propagation paths must reference valid metrics, relationships, and entities.
// Rule: Non-additive metrics cannot use allocation or elimination.
// Rule: Each propagation path must form a valid chain from the metric's home entity.
function checkPropagations(
  manifest: Manifest,
  entityMap: Map<string, Entity>,
  metricHome: Map<string, MetricHome>,
  relationshipNames: Set<string>,
  errors: ValidationError[]
): void {
  const relMap = new Map(manifest.relationships.map((r) => [r.name, r]));
  const nonAdditiveInvalid = new Set(["allocation", "elimination"]);

  for (const prop of manifest.propagations) {
    const home = metricHome.get(prop.metric);
    if (!home) {
      errors.push({
        rule: "propagation-metric-exists",
        message: `Propagation references nonexistent metric "${prop.metric}"`,
        path: `propagations.${prop.metric}`,
      });
      continue;
    }

    // Empty path is a no-op — if the metric should be reserve, omit the
    // propagation entirely rather than declaring an empty one.
    if (prop.path.length === 0) {
      errors.push({
        rule: "propagation-path-nonempty",
        message: `Propagation for "${prop.metric}" has an empty path — omit the propagation to use reserve`,
        path: `propagations.${prop.metric}`,
      });
      continue;
    }

    const def = findMetricDef(manifest.entities, manifest.relationships, prop.metric);

    // Walk the path and validate each edge.
    // For entity metrics, start from the single home entity.
    // For relationship metrics, start from both between entities.
    const currentEntities = new Set<string>(home.grain);
    const visited = new Set<string>(home.grain);

    for (let i = 0; i < prop.path.length; i++) {
      const edge = prop.path[i];

      // Check relationship exists
      if (!relationshipNames.has(edge.relationship)) {
        errors.push({
          rule: "propagation-relationship-exists",
          message: `Propagation for "${prop.metric}" references nonexistent relationship "${edge.relationship}"`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
        currentEntities.clear();
        currentEntities.add(edge.target_entity);
        continue;
      }

      // Check target entity exists
      if (!entityMap.has(edge.target_entity)) {
        errors.push({
          rule: "propagation-entity-exists",
          message: `Propagation for "${prop.metric}" references nonexistent target entity "${edge.target_entity}"`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
        currentEntities.clear();
        currentEntities.add(edge.target_entity);
        continue;
      }

      // Check relationship connects some current entity to target entity
      const rel = relMap.get(edge.relationship);
      if (rel) {
        const connects =
          (currentEntities.has(rel.between[0]) && rel.between[1] === edge.target_entity) ||
          (currentEntities.has(rel.between[1]) && rel.between[0] === edge.target_entity);
        if (!connects) {
          const currentList = [...currentEntities].join(", ");
          errors.push({
            rule: "propagation-path-connected",
            message: `Propagation for "${prop.metric}": relationship "${edge.relationship}" does not connect "${currentList}" to "${edge.target_entity}"`,
            path: `propagations.${prop.metric}.path[${i}]`,
          });
        }
      }

      // Check strategy is a valid enum value
      if (!VALID_STRATEGIES.has(edge.strategy)) {
        errors.push({
          rule: "valid-strategy",
          message: `Propagation for "${prop.metric}" has invalid strategy "${edge.strategy}" — must be one of: elimination, allocation, sum_over_sum`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
      }

      // Reserve is not valid in propagation edges — it's the implicit default
      // when an entity is omitted from the path entirely.
      if (edge.strategy === "reserve") {
        errors.push({
          rule: "propagation-no-reserve",
          message: `Propagation for "${prop.metric}" uses "reserve" at path[${i}] — reserve is the default when an entity is not in the propagation path; omit this edge instead`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
      }

      // Check weight is provided for strategies that require it
      if ((edge.strategy === "allocation" || edge.strategy === "sum_over_sum") && !edge.weight) {
        errors.push({
          rule: "strategy-weight-required",
          message: `Propagation for "${prop.metric}": strategy "${edge.strategy}" requires a weight`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
      }

      // Check for cycles (tree constraint)
      if (visited.has(edge.target_entity)) {
        errors.push({
          rule: "propagation-no-cycle",
          message: `Propagation for "${prop.metric}" creates a cycle: "${edge.target_entity}" already visited`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
      }
      visited.add(edge.target_entity);

      // Check non-additive strategy constraint
      if (def && def.nature === "non-additive" && nonAdditiveInvalid.has(edge.strategy)) {
        errors.push({
          rule: "non-additive-strategy",
          message: `Non-additive metric "${prop.metric}" cannot use "${edge.strategy}" strategy — must use "sum_over_sum" (or omit from path for reserve)`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
      }

      currentEntities.add(edge.target_entity);
    }
  }
}

// Rule: All entity names referenced in tables must exist
function checkTableEntities(
  manifest: Manifest,
  entityMap: Map<string, Entity>,
  errors: ValidationError[]
): void {
  for (const table of manifest.bft_tables) {
    if (!Array.isArray(table.entities) || table.entities.length === 0) {
      errors.push({
        rule: "table-entities-nonempty",
        message: `Table "${table.name}" must declare at least one entity`,
        path: `bft_tables.${table.name}.entities`,
      });
      continue;
    }

    const seen = new Set<string>();
    for (const entityName of table.entities) {
      if (seen.has(entityName)) {
        errors.push({
          rule: "table-entity-unique",
          message: `Table "${table.name}" lists entity "${entityName}" more than once`,
          path: `bft_tables.${table.name}.entities`,
        });
      }
      seen.add(entityName);

      if (!entityMap.has(entityName)) {
        errors.push({
          rule: "table-entity-exists",
          message: `Table "${table.name}" references nonexistent entity "${entityName}"`,
          path: `bft_tables.${table.name}.entities.${entityName}`,
        });
      }
    }
  }
}

// Rule: All metric names referenced in tables must exist on some entity or relationship.
function checkTableMetrics(
  manifest: Manifest,
  metricHome: Map<string, MetricHome>,
  errors: ValidationError[]
): void {
  for (const table of manifest.bft_tables) {
    const seen = new Set<string>();
    for (const metricName of table.metrics) {
      if (seen.has(metricName)) {
        errors.push({
          rule: "table-metric-unique",
          message: `Table "${table.name}" lists metric "${metricName}" more than once`,
          path: `bft_tables.${table.name}.metrics`,
        });
      }
      seen.add(metricName);

      if (!metricHome.has(metricName)) {
        errors.push({
          rule: "table-metric-exists",
          message: `Table "${table.name}" references nonexistent metric "${metricName}"`,
          path: `bft_tables.${table.name}.metrics.${metricName}`,
        });
      }
    }
  }
}

// Warning: A metric whose home grain doesn't overlap the BFT grain and whose
// propagation path doesn't reach any grain entity contributes nothing to the table.
function checkUnreachableMetrics(
  manifest: Manifest,
  metricHome: Map<string, MetricHome>,
  errors: ValidationError[]
): void {
  const propMap = new Map(manifest.propagations.map((p) => [p.metric, p]));

  for (const table of manifest.bft_tables) {
    const grainSet = new Set(table.entities);

    for (const metricName of table.metrics) {
      const home = metricHome.get(metricName);
      if (!home) continue; // caught by checkTableMetrics

      if (home.grain.some((e) => grainSet.has(e))) continue; // home grain overlaps BFT grain

      // Home grain not in BFT grain — check if any propagation hop targets a grain entity
      const prop = propMap.get(metricName);
      const reachesGrain = prop?.path.some((edge) => grainSet.has(edge.target_entity)) ?? false;

      if (!reachesGrain) {
        errors.push({
          rule: "table-metric-unreachable",
          message: `Table "${table.name}": metric "${metricName}" (owned by ${home.name}) has no path to any entity in the table — it will contribute nothing`,
          path: `bft_tables.${table.name}.metrics.${metricName}`,
          severity: "warning",
        });
      }
    }
  }
}

