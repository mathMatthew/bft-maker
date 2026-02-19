import type { Entity, Relationship, Manifest, BftTable } from "./types.js";
import { findConnectedComponents } from "./graph.js";

export interface RowEstimate {
  rows: number;
  reserve_row_count: number;
  total: number;
  grain_entities: string[];
  breakdown: string[];
}

/**
 * Estimate the row count for a BFT given its grain entities.
 *
 * Rules (from system-design.md):
 * - Single entity with detail: entity.estimated_rows
 * - One M-M bridge: relationship.estimated_links
 * - Two M-M bridges sharing a bridge entity: links1 * (links2 / bridge.estimated_rows)
 * - Each additional M-M bridge: multiply by fan-out
 * - Unrelated entities with detail: sum of row counts (sparse union)
 * - Reserve rows: +1 per entity with reserve-strategy metrics
 */
export function estimateRows(
  entities: Entity[],
  relationships: Relationship[],
  grainEntities: string[]
): RowEstimate {
  const entityMap = new Map(entities.map((e) => [e.name, e]));
  const breakdown: string[] = [];

  // Filter to relevant M-M relationships (between grain entities)
  const grainSet = new Set(grainEntities);
  const mmRels = relationships.filter(
    (r) =>
      r.type === "many-to-many" &&
      grainSet.has(r.between[0]) &&
      grainSet.has(r.between[1])
  );

  // Find connected components among grain entities via M-M relationships
  const components = findConnectedComponents(grainEntities, mmRels);
  let totalRows = 0;

  for (const component of components) {
    if (component.length === 1) {
      // Single entity: use its estimated_rows
      const entity = entityMap.get(component[0]);
      if (entity) {
        totalRows += entity.estimated_rows;
        breakdown.push(`${entity.name}: ${entity.estimated_rows} rows`);
      }
    } else {
      // Connected entities: compute via M-M chain
      const componentRows = estimateComponentRows(
        component,
        mmRels,
        entityMap,
        breakdown
      );
      totalRows += componentRows;
    }
  }

  return {
    rows: totalRows,
    reserve_row_count: 0,
    total: totalRows,
    grain_entities: grainEntities,
    breakdown,
  };
}

/**
 * Derive grain entities for a table from its metrics' propagation paths.
 * The grain is the union of all entities touched by included metrics.
 */
export function deriveGrainEntities(manifest: Manifest, table: BftTable): string[] {
  const entities = new Set<string>();

  // Build metric owner map
  const metricOwner = new Map<string, string>();
  for (const entity of manifest.entities) {
    for (const m of entity.metrics) {
      metricOwner.set(m.name, entity.name);
    }
  }

  // Build propagation lookup
  const propMap = new Map(manifest.propagations.map((p) => [p.metric, p]));

  for (const metricName of table.metrics) {
    // Add the metric's home entity
    const owner = metricOwner.get(metricName);
    if (owner) entities.add(owner);

    // Add all entities in this metric's propagation path
    const prop = propMap.get(metricName);
    if (prop) {
      for (const edge of prop.path) {
        entities.add(edge.target_entity);
      }
    }
  }

  return [...entities];
}

/**
 * Estimate rows for a BFT table, deriving grain from propagation paths.
 */
export function estimateTableRows(manifest: Manifest, table: BftTable): RowEstimate {
  const grainEntities = deriveGrainEntities(manifest, table);
  const base = estimateRows(manifest.entities, manifest.relationships, grainEntities);

  // Count reserve rows: entities whose metrics are in this table but have
  // no propagation path (default = reserve), or have reserve/elimination edges
  const metricOwner = new Map<string, string>();
  for (const entity of manifest.entities) {
    for (const m of entity.metrics) {
      metricOwner.set(m.name, entity.name);
    }
  }
  const propMap = new Map(manifest.propagations.map((p) => [p.metric, p]));

  const reserveEntities = new Set<string>();
  for (const metricName of table.metrics) {
    const owner = metricOwner.get(metricName);
    if (!owner) continue;

    const prop = propMap.get(metricName);
    if (!prop) {
      // No propagation = pure reserve. Needs a reserve row if this entity
      // is not the only entity in the grain.
      if (grainEntities.length > 1) {
        reserveEntities.add(owner);
      }
    } else {
      // Check if any edge uses reserve or elimination
      for (const edge of prop.path) {
        if (edge.strategy === "reserve" || edge.strategy === "elimination") {
          reserveEntities.add(owner);
        }
      }
    }
  }

  const reserveCount = reserveEntities.size;
  if (reserveCount > 0) {
    base.breakdown.push(
      `Reserve rows: +${reserveCount} (${[...reserveEntities].join(", ")})`
    );
  }

  base.reserve_row_count = reserveCount;
  base.total = base.rows + reserveCount;
  return base;
}

/**
 * Compute the fan-out multiplier for a relationship.
 */
export function fanOut(
  relationship: Relationship,
  bridgeEntity: Entity
): number {
  return relationship.estimated_links / bridgeEntity.estimated_rows;
}

function estimateComponentRows(
  component: string[],
  mmRels: Relationship[],
  entityMap: Map<string, Entity>,
  breakdown: string[]
): number {
  // Build a spanning tree via BFS and multiply fan-outs
  const componentSet = new Set(component);

  // Build adjacency with relationship info
  const adj = new Map<string, { neighbor: string; rel: Relationship }[]>();
  for (const name of component) {
    adj.set(name, []);
  }
  for (const rel of mmRels) {
    const [a, b] = rel.between;
    if (componentSet.has(a) && componentSet.has(b)) {
      adj.get(a)!.push({ neighbor: b, rel });
      adj.get(b)!.push({ neighbor: a, rel });
    }
  }

  // Track the order of relationships added to the spanning tree
  const spanRels: Relationship[] = [];

  // BFS spanning tree
  const treeVisited = new Set<string>();
  const treeQueue: string[] = [component[0]];
  treeVisited.add(component[0]);

  while (treeQueue.length > 0) {
    const current = treeQueue.shift()!;
    for (const { neighbor, rel } of adj.get(current) ?? []) {
      if (treeVisited.has(neighbor)) continue;
      treeVisited.add(neighbor);
      treeQueue.push(neighbor);
      spanRels.push(rel);
    }
  }

  if (spanRels.length === 0) {
    const entity = entityMap.get(component[0]);
    return entity?.estimated_rows ?? 0;
  }

  // First relationship: base = links
  let result = spanRels[0].estimated_links;
  breakdown.push(
    `${spanRels[0].name}: ${spanRels[0].estimated_links} links (base)`
  );

  // Each additional relationship: multiply by fan-out
  for (let i = 1; i < spanRels.length; i++) {
    const rel = spanRels[i];
    const sharedEntity = findSharedEntity(rel, spanRels.slice(0, i), entityMap);
    if (sharedEntity) {
      const fo = rel.estimated_links / sharedEntity.estimated_rows;
      result = Math.round(result * fo);
      breakdown.push(
        `${rel.name}: ×${fo.toFixed(2)} fan-out (${rel.estimated_links} links / ${sharedEntity.estimated_rows} ${sharedEntity.name} rows)`
      );
    }
  }

  return result;
}

function findSharedEntity(
  rel: Relationship,
  priorRels: Relationship[],
  entityMap: Map<string, Entity>
): Entity | undefined {
  const priorEntities = new Set<string>();
  for (const pr of priorRels) {
    priorEntities.add(pr.between[0]);
    priorEntities.add(pr.between[1]);
  }

  for (const entityName of rel.between) {
    if (priorEntities.has(entityName)) {
      return entityMap.get(entityName);
    }
  }

  return undefined;
}
