import type { Manifest, Entity, MetricDef } from "./types.js";
import { findConnectedComponents } from "./graph.js";

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
  checkClusterMetrics(manifest, metricOwner, errors);
  checkTraversalRules(manifest, metricOwner, relationshipNames, errors);
  checkNonAdditiveStrategies(manifest, metricOwner, errors);
  checkGrainConnectivity(manifest, entityMap, errors);

  return errors;
}

function buildEntityMap(entities: Entity[]): Map<string, Entity> {
  return new Map(entities.map((e) => [e.name, e]));
}

function buildMetricOwnerMap(entities: Entity[]): Map<string, Entity> {
  const map = new Map<string, Entity>();
  for (const entity of entities) {
    for (const metric of entity.metrics) {
      map.set(metric.name, entity);
    }
  }
  return map;
}

function findMetricDef(
  entities: Entity[],
  metricName: string
): MetricDef | undefined {
  for (const entity of entities) {
    for (const metric of entity.metrics) {
      if (metric.name === metricName) return metric;
    }
  }
  return undefined;
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
    manifest.metric_clusters.map((c) => c.name),
    "metric cluster",
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

// Rule: All metric names referenced in clusters must exist on some entity
function checkClusterMetrics(
  manifest: Manifest,
  metricOwner: Map<string, Entity>,
  errors: ValidationError[]
): void {
  for (const cluster of manifest.metric_clusters) {
    for (const metricName of cluster.metrics) {
      if (!metricOwner.has(metricName)) {
        errors.push({
          rule: "cluster-metric-exists",
          message: `Cluster "${cluster.name}" references nonexistent metric "${metricName}"`,
          path: `metric_clusters.${cluster.name}.metrics`,
        });
      }
    }
  }
}

// Rule: All relationship names referenced in traversal rules must exist
// Rule: Every metric in every cluster must have a traversal rule (or be direct/native)
function checkTraversalRules(
  manifest: Manifest,
  metricOwner: Map<string, Entity>,
  relationshipNames: Set<string>,
  errors: ValidationError[]
): void {
  for (const cluster of manifest.metric_clusters) {
    // Check weight_source references
    for (const rule of cluster.traversals) {
      if (rule.weight_source && !relationshipNames.has(rule.weight_source)) {
        errors.push({
          rule: "traversal-relationship-exists",
          message: `Traversal rule for "${rule.metric}" in cluster "${cluster.name}" references nonexistent relationship "${rule.weight_source}"`,
          path: `metric_clusters.${cluster.name}.traversals`,
        });
      }
    }

    // Check every metric has a traversal rule or is native
    const traversedMetrics = new Set(cluster.traversals.map((t) => t.metric));

    // Find all distinct entities owning metrics in this cluster
    const clusterEntities = new Set<string>();
    for (const metricName of cluster.metrics) {
      const owner = metricOwner.get(metricName);
      if (owner) clusterEntities.add(owner.name);
    }

    // If only one entity, all metrics are native — no traversals needed
    if (clusterEntities.size <= 1) continue;

    // Multiple entities: every metric needs a traversal rule
    for (const metricName of cluster.metrics) {
      if (!traversedMetrics.has(metricName)) {
        errors.push({
          rule: "traversal-rule-required",
          message: `Metric "${metricName}" in cluster "${cluster.name}" has no traversal rule (cluster spans multiple entities: ${[...clusterEntities].join(", ")})`,
          path: `metric_clusters.${cluster.name}.traversals`,
        });
      }
    }
  }
}

// Rule: Non-additive metrics must use sum_over_sum strategy, not allocation/elimination
function checkNonAdditiveStrategies(
  manifest: Manifest,
  metricOwner: Map<string, Entity>,
  errors: ValidationError[]
): void {
  const invalidStrategies = new Set([
    "allocation",
    "elimination",
    "reserve",
  ]);

  // Check traversal rules in clusters
  for (const cluster of manifest.metric_clusters) {
    for (const rule of cluster.traversals) {
      const def = findMetricDef(manifest.entities, rule.metric);
      if (
        def &&
        def.nature === "non-additive" &&
        invalidStrategies.has(rule.on_foreign_rows)
      ) {
        errors.push({
          rule: "non-additive-strategy",
          message: `Non-additive metric "${rule.metric}" cannot use "${rule.on_foreign_rows}" strategy — must use "sum_over_sum" or "direct"`,
          path: `metric_clusters.${cluster.name}.traversals.${rule.metric}`,
        });
      }
    }
  }

  // Check resolved metrics in tables
  for (const table of manifest.bft_tables) {
    for (const rm of table.metrics) {
      const def = findMetricDef(manifest.entities, rm.metric);
      if (
        def &&
        def.nature === "non-additive" &&
        invalidStrategies.has(rm.strategy)
      ) {
        errors.push({
          rule: "non-additive-strategy",
          message: `Non-additive metric "${rm.metric}" in table "${table.name}" cannot use "${rm.strategy}" strategy — must use "sum_over_sum" or "direct"`,
          path: `bft_tables.${table.name}.metrics.${rm.metric}`,
        });
      }
    }
  }
}

// Rule: Grain entities must form a connected graph through declared relationships
//       (or be explicitly unrelated — all disconnected)
function checkGrainConnectivity(
  manifest: Manifest,
  entityMap: Map<string, Entity>,
  errors: ValidationError[]
): void {
  for (const table of manifest.bft_tables) {
    // Check grain entities exist
    for (const entityName of table.grain_entities) {
      if (!entityMap.has(entityName)) {
        errors.push({
          rule: "grain-entity-exists",
          message: `Table "${table.name}" references nonexistent grain entity "${entityName}"`,
          path: `bft_tables.${table.name}.grain_entities`,
        });
      }
    }

    // Check cluster references exist
    const clusterNames = new Set(manifest.metric_clusters.map((c) => c.name));
    for (const clusterName of table.clusters_served) {
      if (!clusterNames.has(clusterName)) {
        errors.push({
          rule: "table-cluster-exists",
          message: `Table "${table.name}" references nonexistent cluster "${clusterName}"`,
          path: `bft_tables.${table.name}.clusters_served`,
        });
      }
    }

    // Check grain connectivity
    if (table.grain_entities.length < 2) continue;

    const grainSet = new Set(table.grain_entities);
    const grainRels = manifest.relationships.filter(
      (r) => grainSet.has(r.between[0]) && grainSet.has(r.between[1])
    );
    const components = findConnectedComponents(table.grain_entities, grainRels);

    // Fully connected (1 component) is fine — standard M-M chain.
    // Fully disconnected (N components == N entities) is fine — sparse union.
    // Partially connected is ambiguous and likely a mistake.
    if (components.length > 1 && components.length < table.grain_entities.length) {
      const componentStrs = components.map((c) => c.join(", "));
      errors.push({
        rule: "grain-connectivity",
        message: `Table "${table.name}" grain entities are partially connected — some linked, some isolated. Connected groups: [${componentStrs.join("] [")}]. Either connect all entities via relationships or make all entities independent.`,
        path: `bft_tables.${table.name}.grain_entities`,
      });
    }
  }
}
