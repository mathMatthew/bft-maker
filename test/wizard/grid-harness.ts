/**
 * Standalone harness that launches the strategy matrix grid
 * with test data. Used by tmux integration tests.
 *
 * Usage: node dist/test/wizard/grid-harness.js
 */
import { runGridLoop } from "../../src/wizard/grid/input.js";
import { showCursor } from "../../src/wizard/grid/renderer.js";
import { initGrid } from "../../src/wizard/state.js";
import type { Entity, Relationship } from "../../src/manifest/types.js";

const entities: Entity[] = [
  {
    name: "Student",
    role: "leaf",
    detail: true,
    estimated_rows: 45000,
    metrics: [
      { name: "tuition_paid", type: "currency", nature: "additive" },
    ],
  },
  {
    name: "Class",
    role: "bridge",
    detail: true,
    estimated_rows: 1200,
    metrics: [
      { name: "class_budget", type: "currency", nature: "additive" },
    ],
  },
  {
    name: "Professor",
    role: "leaf",
    detail: true,
    estimated_rows: 800,
    metrics: [
      { name: "salary", type: "currency", nature: "additive" },
    ],
  },
];

const relationships: Relationship[] = [
  {
    name: "Enrollment",
    between: ["Student", "Class"],
    type: "many-to-many",
    estimated_links: 120000,
  },
  {
    name: "Assignment",
    between: ["Class", "Professor"],
    type: "many-to-many",
    estimated_links: 1800,
  },
];

const { grid, metricNames, entityNames } = initGrid(entities, relationships);

const result = await runGridLoop({
  grid,
  metricNames,
  entityNames,
  input: process.stdin,
  output: process.stdout,
  getTermSize: () => ({
    rows: (process.stdout as NodeJS.WriteStream).rows ?? 24,
    cols: (process.stdout as NodeJS.WriteStream).columns ?? 80,
  }),
});

showCursor(process.stdout);

// Print final grid state as JSON for test assertions
console.log("\n__GRID_RESULT__");
console.log(JSON.stringify(result.map((row) =>
  row.map((cell) => ({ entity: cell.entityName, metric: cell.metricName, value: cell.value })),
)));
