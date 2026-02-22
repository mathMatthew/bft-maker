import type { Manifest, BftTable, Relationship } from "../manifest/types.js";
import { buildMetricOwnerMap, findMetricDef } from "../manifest/helpers.js";
import type {
  TablePlan,
  MetricPlan,
  DimensionStrategy,
  JoinLink,
  SourceMapping,
  EntitySource,
  RelationshipSource,
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
  const metricOwners = buildMetricOwnerMap(manifest.entities);
  const joinChain = buildJoinChain(table.entities, manifest.relationships, sourceMapping);

  const metrics: MetricPlan[] = table.metrics.map((metricName) => {
    const owner = metricOwners.get(metricName);
    if (!owner) throw new Error(`Metric "${metricName}" not found on any entity`);
    const def = findMetricDef(manifest.entities, metricName)!;

    const foreignEntities = table.entities.filter((e) => e !== owner.name);
    const propagation = manifest.propagations.find((p) => p.metric === metricName);

    const dimensions: DimensionStrategy[] = foreignEntities.map((entityName) => {
      if (!propagation) {
        // No propagation → reserve for all foreign entities
        return { entity: entityName, strategy: "reserve" as const, relationship: "" };
      }
      const hopIndex = propagation.path.findIndex((edge) => edge.target_entity === entityName);
      if (hopIndex === -1) {
        // Entity not in propagation path → reserve
        return { entity: entityName, strategy: "reserve" as const, relationship: "" };
      }
      const edge = propagation.path[hopIndex];
      return {
        entity: entityName,
        strategy: edge.strategy,
        relationship: edge.relationship,
        hopIndex,
      };
    });

    const behavior = classifyBehavior(dimensions, def.nature);

    return {
      name: metricName,
      homeEntity: owner.name,
      nature: def.nature,
      dimensions,
      behavior,
    };
  });

  return { tableName: table.name, entities: table.entities, joinChain, metrics };
}

function classifyBehavior(
  dimensions: DimensionStrategy[],
  nature: "additive" | "non-additive"
): MetricPlan["behavior"] {
  if (nature === "non-additive") return "sum_over_sum";

  const strategies = new Set(dimensions.map((d) => d.strategy));
  if (strategies.size === 1) {
    const only = [...strategies][0];
    if (only === "allocation") return "fully_allocated";
    if (only === "elimination") return "pure_elimination";
    if (only === "reserve") return "pure_reserve";
  }
  if (strategies.has("elimination") && strategies.has("reserve")) return "mixed";
  if (strategies.has("allocation") && strategies.size === 1) return "fully_allocated";
  return "mixed";
}

/**
 * Find a join chain connecting all entities via relationships.
 * Uses BFS from the first entity outward.
 */
function buildJoinChain(
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
