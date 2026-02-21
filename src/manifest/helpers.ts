import type { Entity, MetricDef } from "./types.js";

/** Map each metric name to its owning Entity. */
export function buildMetricOwnerMap(entities: Entity[]): Map<string, Entity> {
  const map = new Map<string, Entity>();
  for (const entity of entities) {
    for (const metric of entity.metrics) {
      map.set(metric.name, entity);
    }
  }
  return map;
}

/** Find a MetricDef by name across all entities. */
export function findMetricDef(
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
