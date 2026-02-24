import type { Entity, MetricDef, Relationship } from "./types.js";

/** Where a metric lives: on an entity (1-entity grain) or a relationship (2-entity grain). */
export interface MetricHome {
  kind: "entity" | "relationship";
  name: string;       // entity or relationship name
  grain: string[];    // [entityName] for entity metrics, [entityA, entityB] for relationship metrics
}

/** Map each metric name to its home (entity or relationship). */
export function buildMetricHomeMap(
  entities: Entity[],
  relationships: Relationship[]
): Map<string, MetricHome> {
  const map = new Map<string, MetricHome>();
  for (const entity of entities) {
    for (const metric of entity.metrics) {
      map.set(metric.name, {
        kind: "entity",
        name: entity.name,
        grain: [entity.name],
      });
    }
  }
  for (const rel of relationships) {
    if (rel.metrics) {
      for (const metric of rel.metrics) {
        map.set(metric.name, {
          kind: "relationship",
          name: rel.name,
          grain: [...rel.between],
        });
      }
    }
  }
  return map;
}

/** Find a MetricDef by name across all entities and relationships. */
export function findMetricDef(
  entities: Entity[],
  relationships: Relationship[],
  metricName: string
): MetricDef | undefined {
  for (const entity of entities) {
    for (const metric of entity.metrics) {
      if (metric.name === metricName) return metric;
    }
  }
  for (const rel of relationships) {
    if (rel.metrics) {
      for (const metric of rel.metrics) {
        if (metric.name === metricName) return metric;
      }
    }
  }
  return undefined;
}
