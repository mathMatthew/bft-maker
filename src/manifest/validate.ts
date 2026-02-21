import type { Manifest, Entity } from "./types.js";
import { VALID_STRATEGIES } from "./types.js";
import { buildMetricOwnerMap, findMetricDef } from "./helpers.js";

export interface ValidationError {
  rule: string;
  message: string;
  path?: string;
}

export function validate(manifest: Manifest): ValidationError[] {
  const errors: ValidationError[] = [];

  const entityMap = buildEntityMap(manifest.entities);
  const metricOwner = buildMetricOwnerMap(manifest.entities);
  const relationshipNames = new Set(
    manifest.relationships.map((r) => r.name)
  );

  checkDuplicateNames(manifest, errors);
  checkPositiveCardinalities(manifest, errors);
  checkRelationshipEntities(manifest, entityMap, errors);
  checkPropagations(manifest, entityMap, metricOwner, relationshipNames, errors);
  checkTableMetrics(manifest, metricOwner, errors);

  return errors;
}

function buildEntityMap(entities: Entity[]): Map<string, Entity> {
  return new Map(entities.map((e) => [e.name, e]));
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
  metricOwner: Map<string, Entity>,
  relationshipNames: Set<string>,
  errors: ValidationError[]
): void {
  const relMap = new Map(manifest.relationships.map((r) => [r.name, r]));
  const nonAdditiveInvalid = new Set(["allocation", "elimination"]);

  for (const prop of manifest.propagations) {
    const owner = metricOwner.get(prop.metric);
    if (!owner) {
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

    const def = findMetricDef(manifest.entities, prop.metric);

    // Walk the path and validate each edge
    let currentEntity = owner.name;
    const visited = new Set<string>([currentEntity]);

    for (let i = 0; i < prop.path.length; i++) {
      const edge = prop.path[i];

      // Check relationship exists
      if (!relationshipNames.has(edge.relationship)) {
        errors.push({
          rule: "propagation-relationship-exists",
          message: `Propagation for "${prop.metric}" references nonexistent relationship "${edge.relationship}"`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
        continue;
      }

      // Check target entity exists
      if (!entityMap.has(edge.target_entity)) {
        errors.push({
          rule: "propagation-entity-exists",
          message: `Propagation for "${prop.metric}" references nonexistent target entity "${edge.target_entity}"`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
        continue;
      }

      // Check relationship connects current entity to target entity
      const rel = relMap.get(edge.relationship);
      if (rel) {
        const connects =
          (rel.between[0] === currentEntity && rel.between[1] === edge.target_entity) ||
          (rel.between[1] === currentEntity && rel.between[0] === edge.target_entity);
        if (!connects) {
          errors.push({
            rule: "propagation-path-connected",
            message: `Propagation for "${prop.metric}": relationship "${edge.relationship}" does not connect "${currentEntity}" to "${edge.target_entity}"`,
            path: `propagations.${prop.metric}.path[${i}]`,
          });
        }
      }

      // Check strategy is a valid enum value
      if (!VALID_STRATEGIES.has(edge.strategy)) {
        errors.push({
          rule: "valid-strategy",
          message: `Propagation for "${prop.metric}" has invalid strategy "${edge.strategy}" — must be one of: reserve, elimination, allocation, sum_over_sum`,
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
          message: `Non-additive metric "${prop.metric}" cannot use "${edge.strategy}" strategy — must use "sum_over_sum" or "reserve"`,
          path: `propagations.${prop.metric}.path[${i}]`,
        });
      }

      currentEntity = edge.target_entity;
    }
  }
}

// Rule: All metric names referenced in tables must exist on some entity
function checkTableMetrics(
  manifest: Manifest,
  metricOwner: Map<string, Entity>,
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

      if (!metricOwner.has(metricName)) {
        errors.push({
          rule: "table-metric-exists",
          message: `Table "${table.name}" references nonexistent metric "${metricName}"`,
          path: `bft_tables.${table.name}.metrics.${metricName}`,
        });
      }
    }
  }
}
