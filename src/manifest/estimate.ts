import type { Entity, Relationship, BftTable } from "./types.js";

export interface RowEstimate {
  rows: number;
  reserve_rows: number;
  total: number;
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
    reserve_rows: 0,
    total: totalRows,
    breakdown,
  };
}

/**
 * Estimate rows for a BFT table, including reserve rows.
 */
export function estimateTableRows(
  entities: Entity[],
  relationships: Relationship[],
  table: BftTable
): RowEstimate {
  const base = estimateRows(entities, relationships, table.grain_entities);

  // Count reserve rows: +1 per entity with reserve-strategy metrics
  let reserveCount = 0;
  const reserveEntities: string[] = [];
  const entityMap = new Map(entities.map((e) => [e.name, e]));

  for (const rm of table.metrics) {
    if (rm.requires_reserve_rows || rm.strategy === "reserve" || rm.strategy === "elimination") {
      // Find which entity owns this metric
      for (const entity of entities) {
        if (
          entity.metrics.some((m) => m.name === rm.metric) &&
          !reserveEntities.includes(entity.name)
        ) {
          reserveEntities.push(entity.name);
          reserveCount++;
        }
      }
    }
  }

  if (reserveCount > 0) {
    base.breakdown.push(
      `Reserve rows: +${reserveCount} (${reserveEntities.join(", ")})`
    );
  }

  base.reserve_rows = reserveCount;
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

function findConnectedComponents(
  entityNames: string[],
  mmRels: Relationship[]
): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const name of entityNames) {
    adj.set(name, new Set());
  }
  for (const rel of mmRels) {
    const [a, b] = rel.between;
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const name of entityNames) {
    if (visited.has(name)) continue;
    const component: string[] = [];
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  return components;
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

  // BFS from first entity, building a spanning tree
  const visited = new Set<string>();
  const queue: { entity: string; rows: number; path: string[] }[] = [
    { entity: component[0], rows: 0, path: [component[0]] },
  ];

  let result = 0;
  let firstRel = true;

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
    // Shouldn't happen for a component > 1, but just in case
    const entity = entityMap.get(component[0]);
    return entity?.estimated_rows ?? 0;
  }

  // First relationship: base = links
  result = spanRels[0].estimated_links;
  breakdown.push(
    `${spanRels[0].name}: ${spanRels[0].estimated_links} links (base)`
  );

  // Each additional relationship: multiply by fan-out
  for (let i = 1; i < spanRels.length; i++) {
    const rel = spanRels[i];
    // The shared entity is the one that connects this rel to the existing tree
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
  // The shared entity is the one that appears in both this relationship
  // and one of the prior relationships
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
