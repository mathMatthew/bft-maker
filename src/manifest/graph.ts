import type { Relationship } from "./types.js";

/**
 * Find connected components among entity names using the given relationships.
 * Pure graph utility — used by both the validator and estimator.
 */
export function findConnectedComponents(
  entityNames: string[],
  rels: Relationship[]
): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const name of entityNames) {
    adj.set(name, new Set());
  }
  for (const rel of rels) {
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
