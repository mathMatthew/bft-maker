import type { Entity, Relationship, Manifest, MetricPropagation, BftTable } from "./types.js";
import { findConnectedComponents } from "./graph.js";
import { buildMetricOwnerMap } from "./helpers.js";

export interface RowEstimate {
  rows: number;
  placeholder_row_count: number;
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
 * - Placeholder rows: entity.estimated_rows per entity with reserve/elimination metrics
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
    placeholder_row_count: 0,
    total: totalRows,
    breakdown,
  };
}

/**
 * Estimate rows for a BFT table. The table declares its grain entities
 * explicitly — no derivation from propagation paths.
 *
 * When metrics have independent entity groups (no single metric spans
 * both), the codegen emits UNION ALL — not a cross product. Each metric's
 * "active entities" = home entity + propagation targets that are in the
 * grain. Independent groups are estimated separately and summed.
 *
 * Reserve and elimination strategies produce rows where foreign entity
 * columns show placeholder labels. There is one such row per entity VALUE
 * (not per entity), so the count is entity.estimated_rows for each entity
 * with reserve or elimination metrics.
 */
export function estimateTableRows(manifest: Manifest, table: BftTable): RowEstimate {
  const metricOwner = buildMetricOwnerMap(manifest.entities);
  const propMap = new Map(manifest.propagations.map((p) => [p.metric, p]));
  const entityMap = new Map(manifest.entities.map((e) => [e.name, e]));
  const grainEntities = table.entities;
  const grainSet = new Set(grainEntities);

  // Compute each metric's active entities in this table:
  // home entity + propagation targets that are in the grain.
  const chains: Set<string>[] = [];
  for (const metricName of table.metrics) {
    const owner = metricOwner.get(metricName);
    if (!owner || !grainSet.has(owner.name)) continue;
    const chain = new Set<string>([owner.name]);
    const prop = propMap.get(metricName);
    if (prop) {
      for (const edge of prop.path) {
        if (grainSet.has(edge.target_entity)) chain.add(edge.target_entity);
      }
    }
    chains.push(chain);
  }

  // Add any grain entities not covered by metrics (pure dimension entities)
  const coveredEntities = new Set<string>();
  for (const chain of chains) {
    for (const e of chain) coveredEntities.add(e);
  }
  for (const entityName of grainEntities) {
    if (!coveredEntities.has(entityName)) {
      // Merge into whichever chain connects to it, or create a singleton
      let merged = false;
      for (const chain of chains) {
        // Check if any M-M relationship connects this entity to the chain
        for (const rel of manifest.relationships) {
          if (rel.type !== "many-to-many") continue;
          const [a, b] = rel.between;
          if ((a === entityName && chain.has(b)) || (b === entityName && chain.has(a))) {
            chain.add(entityName);
            merged = true;
            break;
          }
        }
        if (merged) break;
      }
      if (!merged) {
        chains.push(new Set([entityName]));
      }
    }
  }

  // Remove duplicate and subset chains
  const effectiveChains = removeSubsetChains(chains);

  // Estimate each chain independently and sum (UNION ALL)
  let totalRows = 0;
  const breakdown: string[] = [];
  for (const chain of effectiveChains) {
    const est = estimateRows(manifest.entities, manifest.relationships, [...chain]);
    totalRows += est.rows;
    breakdown.push(...est.breakdown);
  }
  if (effectiveChains.length > 1) {
    breakdown.push(
      `${effectiveChains.length} independent row groups (UNION ALL)`
    );
  }

  // Count placeholder rows — rows where a foreign entity column shows a
  // placeholder label. One per entity VALUE for each entity with reserve
  // or elimination metrics in this table.
  //
  // Reserve: salary (Professor) with no propagation means salary=0 on all
  // regular rows. Each professor gets a row carrying their salary, with
  // foreign entity columns showing the placeholder label.
  //
  // Elimination: class_budget (Class) eliminated toward Student means every
  // Student row shows the full budget. Each class gets a row carrying a
  // negative offset so SUM equals the true total.
  const placeholderEntities = new Set<string>();
  for (const metricName of table.metrics) {
    const owner = metricOwner.get(metricName);
    if (!owner) continue;

    // Only relevant if the owner entity is in the grain
    if (!grainSet.has(owner.name)) continue;

    const prop = propMap.get(metricName);
    if (!prop) {
      // No propagation = pure reserve. Needs placeholder rows if there are
      // foreign entities in the grain (single-entity tables don't need them).
      if (grainEntities.length > 1) {
        placeholderEntities.add(owner.name);
      }
    } else {
      // Only count hops whose target entity is in the grain
      for (const edge of prop.path) {
        if (!grainSet.has(edge.target_entity)) continue;
        if (edge.strategy === "reserve" || edge.strategy === "elimination") {
          placeholderEntities.add(owner.name);
        }
      }
    }
  }

  let placeholderRowCount = 0;
  for (const entityName of placeholderEntities) {
    const entity = entityMap.get(entityName);
    if (entity) placeholderRowCount += entity.estimated_rows;
  }

  if (placeholderRowCount > 0) {
    breakdown.push(
      `Placeholder rows: +${placeholderRowCount} (${[...placeholderEntities].map((name) => {
        const e = entityMap.get(name);
        return `${name}: ${e?.estimated_rows ?? 0}`;
      }).join(", ")})`
    );
  }

  return {
    rows: totalRows,
    placeholder_row_count: placeholderRowCount,
    total: totalRows + placeholderRowCount,
    breakdown,
  };
}

/**
 * Remove duplicate and strict-subset chains. A chain that is a subset of
 * another doesn't need its own row group — its rows ride along on the
 * larger chain's rows.
 */
function removeSubsetChains(chains: Set<string>[]): Set<string>[] {
  // Deduplicate identical chains
  const unique: Set<string>[] = [];
  for (const chain of chains) {
    if (!unique.some((u) => setsEqual(u, chain))) {
      unique.push(chain);
    }
  }

  // Remove strict subsets
  return unique.filter(
    (chain, i) =>
      !unique.some((other, j) => i !== j && isStrictSubset(chain, other))
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((e) => b.has(e));
}

function isStrictSubset(small: Set<string>, large: Set<string>): boolean {
  return small.size < large.size && [...small].every((e) => large.has(e));
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
    // Shouldn't happen for a component > 1, but defensive fallback
    const entity = entityMap.get(component[0]);
    return entity?.estimated_rows ?? 0;
  }

  // First relationship: base = links
  let result = spanRels[0].estimated_links;
  breakdown.push(
    `${spanRels[0].name}: ${spanRels[0].estimated_links} links (base)`
  );

  // Each additional relationship: multiply by fan-out.
  // The shared entity is the one that connects this rel to the existing tree.
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

// In a BFS spanning tree, each new edge has exactly one endpoint already
// in the tree (the node BFS discovered it from). So exactly one of
// rel.between will appear in priorRels — the first match is correct.
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
