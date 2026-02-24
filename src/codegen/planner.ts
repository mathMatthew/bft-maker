import type { Manifest, BftTable, Relationship } from "../manifest/types.js";
import { buildMetricHomeMap, findMetricDef } from "../manifest/helpers.js";
import type { MetricHome } from "../manifest/helpers.js";
import type {
  TablePlan,
  MetricPlan,
  MetricBehavior,
  DimensionStrategy,
  JoinLink,
  SourceMapping,
  EntitySource,
  RelationshipSource,
  GrainGroup,
} from "./types.js";

/**
 * Build a default source mapping using naming conventions:
 *   Entity "Student" → table "students", id "student_id", label "name"
 *   Relationship "Enrollment" → table "enrollments", columns from entity ids
 */
export function defaultSourceMapping(manifest: Manifest): SourceMapping {
  const entities: Record<string, EntitySource> = {};
  for (const e of manifest.entities) {
    const lower = e.name.toLowerCase();
    entities[e.name] = {
      table: pluralize(lower),
      idColumn: `${lower}_id`,
      labelColumn: "name",
    };
  }

  const relationships: Record<string, RelationshipSource> = {};
  for (const r of manifest.relationships) {
    const columns: Record<string, string> = {};
    for (const entityName of r.between) {
      columns[entityName] = entities[entityName].idColumn;
    }
    relationships[r.name] = {
      table: pluralize(r.name.toLowerCase()),
      columns,
    };
  }

  return { entities, relationships };
}

function pluralize(word: string): string {
  if (word.endsWith("s") || word.endsWith("x") || word.endsWith("z") ||
      word.endsWith("ch") || word.endsWith("sh")) {
    return word + "es";
  }
  if (word.endsWith("y") && !/[aeiou]y$/.test(word)) {
    return word.slice(0, -1) + "ies";
  }
  return word + "s";
}

/**
 * Build a plan for one BFT table.
 */
export function planTable(manifest: Manifest, table: BftTable, sourceMapping: SourceMapping): TablePlan {
  const metricHomes = buildMetricHomeMap(manifest.entities, manifest.relationships);
  const bftGrain = table.entities;
  const bftGrainSet = new Set(bftGrain);
  const bftJoinChain = buildJoinChain(bftGrain, manifest.relationships, sourceMapping);

  const metrics: MetricPlan[] = table.metrics.map((metricName) => {
    const home = metricHomes.get(metricName);
    if (!home) throw new Error(`Metric "${metricName}" not found on any entity or relationship`);
    const def = findMetricDef(manifest.entities, manifest.relationships, metricName)!;
    const propagation = manifest.propagations.find((p) => p.metric === metricName);

    return planMetric(metricName, home, def.nature, propagation, bftGrainSet, bftGrain);
  });

  // Group metrics by computeGrain
  const grainGroups = buildGrainGroups(metrics, manifest.relationships, sourceMapping);

  return { tableName: table.name, bftGrain, grainGroups, bftJoinChain };
}

/**
 * Plan a single metric within a BFT table.
 */
function planMetric(
  metricName: string,
  home: MetricHome,
  nature: "additive" | "non-additive",
  propagation: { path: { relationship: string; target_entity: string; strategy: import("../manifest/types.js").Strategy; weight?: string }[] } | undefined,
  bftGrainSet: Set<string>,
  bftGrain: string[]
): MetricPlan {
  // Start with home grain entities
  const computeGrainSet = new Set<string>(home.grain);

  // Walk propagation path, lazily include steps that reach BFT entities
  // or are intermediate hops needed to reach BFT entities.
  const propagatedDimensions: DimensionStrategy[] = [];

  if (propagation) {
    // Determine which steps are needed: any step whose target or subsequent
    // target reaches a BFT grain entity.
    const needed = new Set<number>();
    for (let i = propagation.path.length - 1; i >= 0; i--) {
      const edge = propagation.path[i];
      if (bftGrainSet.has(edge.target_entity)) {
        // This step reaches a BFT entity directly
        needed.add(i);
        // Mark all earlier steps as needed too (they're on the path)
        for (let j = 0; j < i; j++) needed.add(j);
      }
    }

    for (let i = 0; i < propagation.path.length; i++) {
      if (!needed.has(i)) continue;
      const edge = propagation.path[i];
      computeGrainSet.add(edge.target_entity);
      propagatedDimensions.push({
        entity: edge.target_entity,
        strategy: edge.strategy,
        relationship: edge.relationship,
        hopIndex: i,
      });
    }
  }

  const computeGrain = [...computeGrainSet];
  const reserveDimensions = bftGrain.filter((e) => !computeGrainSet.has(e));
  const summarizeOut = computeGrain.filter((e) => !bftGrainSet.has(e));

  // For backward compatibility with existing tests: add reserve dimensions
  // to propagatedDimensions when there's no summarization or explicit propagation
  // (This preserves the "all foreign entities get a strategy" behavior)
  const allDimensions = [
    ...propagatedDimensions,
    ...reserveDimensions.map((entity) => ({
      entity,
      strategy: "reserve" as const,
      relationship: "",
    })),
  ];

  const behavior = classifyBehavior(allDimensions, nature, reserveDimensions.length, summarizeOut.length);

  return {
    name: metricName,
    home,
    nature,
    propagatedDimensions: allDimensions,
    computeGrain,
    reserveDimensions,
    summarizeOut,
    behavior,
  };
}

function classifyBehavior(
  dimensions: DimensionStrategy[],
  nature: "additive" | "non-additive",
  reserveCount: number,
  summarizeOutCount: number
): MetricBehavior {
  if (nature === "non-additive") return "sum_over_sum";
  if (dimensions.length === 0) return "fully_allocated";

  const strategies = new Set(dimensions.map((d) => d.strategy));
  if (strategies.size === 1) {
    const only = [...strategies][0];
    if (only === "allocation" && reserveCount === 0) return "fully_allocated";
    if (only === "elimination" && reserveCount === 0) return "pure_elimination";
    if (only === "reserve") return "pure_reserve";
  }
  if (strategies.has("elimination") && strategies.has("reserve")) return "mixed";
  if (strategies.has("allocation") && strategies.size === 1 && reserveCount === 0) return "fully_allocated";
  return "mixed";
}

/**
 * Group metrics by their computeGrain → GrainGroup[].
 */
function buildGrainGroups(
  metrics: MetricPlan[],
  relationships: Relationship[],
  sourceMapping: SourceMapping
): GrainGroup[] {
  const groups = new Map<string, MetricPlan[]>();

  for (const metric of metrics) {
    const key = [...metric.computeGrain].sort().join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(metric);
  }

  const result: GrainGroup[] = [];
  let groupIdx = 0;
  for (const [key, groupMetrics] of groups) {
    const grain = groupMetrics[0].computeGrain;
    const joinChain = buildJoinChain(grain, relationships, sourceMapping);
    const bftGrainSet = new Set(grain);
    const needsSummarization = groupMetrics.some((m) => m.summarizeOut.length > 0);

    result.push({
      id: `g${groupIdx}`,
      grain,
      joinChain,
      metrics: groupMetrics,
      needsSummarization,
    });
    groupIdx++;
  }

  return result;
}

/**
 * Find a join chain connecting all entities via relationships.
 * Uses BFS from the first entity outward.
 */
export function buildJoinChain(
  entities: string[],
  relationships: Relationship[],
  sourceMapping: SourceMapping
): JoinLink[] {
  if (entities.length <= 1) return [];

  // Build adjacency: entity → [(neighbor, relationship)]
  const adj = new Map<string, { neighbor: string; rel: Relationship }[]>();
  for (const e of entities) adj.set(e, []);
  for (const rel of relationships) {
    const [a, b] = rel.between;
    if (adj.has(a) && adj.has(b)) {
      adj.get(a)!.push({ neighbor: b, rel });
      adj.get(b)!.push({ neighbor: a, rel });
    }
  }

  // BFS from first entity
  const visited = new Set<string>([entities[0]]);
  const queue = [entities[0]];
  const chain: JoinLink[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { neighbor, rel } of adj.get(current) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);

      const relSource = sourceMapping.relationships[rel.name];
      chain.push({
        fromEntity: current,
        toEntity: neighbor,
        relationship: rel.name,
        junctionTable: relSource.table,
        fromColumn: relSource.columns[current],
        toColumn: relSource.columns[neighbor],
      });
    }
  }

  return chain;
}

/**
 * Plan all BFT tables in a manifest.
 */
export function planAll(manifest: Manifest, sourceMapping: SourceMapping): TablePlan[] {
  return manifest.bft_tables.map((table) => planTable(manifest, table, sourceMapping));
}
