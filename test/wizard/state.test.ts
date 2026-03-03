import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  createInitialState,
  nextStep,
  prevStep,
  collectMetrics,
  buildAdjacency,
  findReachable,
  initGrid,
  cycleStrategy,
  extractPropagations,
  cellsNeedingWeights,
  buildManifest,
  type GridCell,
  type WizardState,
} from "../../src/wizard/state.js";
import type { Entity, Relationship } from "../../src/manifest/types.js";

/* ------------------------------------------------------------------ */
/*  Test fixtures                                                     */
/* ------------------------------------------------------------------ */

function studentClassProfessor(): { entities: Entity[]; relationships: Relationship[] } {
  return {
    entities: [
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
    ],
    relationships: [
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
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Step navigation                                                   */
/* ------------------------------------------------------------------ */

describe("step navigation", () => {
  it("nextStep advances through steps", () => {
    const state = createInitialState();
    assert.equal(state.step, "data-model");
    assert.equal(nextStep(state), "strategy-matrix");

    state.step = "strategy-matrix";
    assert.equal(nextStep(state), "weights");

    state.step = "weights";
    assert.equal(nextStep(state), "tables");

    state.step = "tables";
    assert.equal(nextStep(state), null);
  });

  it("prevStep goes backward", () => {
    const state = createInitialState();
    assert.equal(prevStep(state), null);

    state.step = "tables";
    assert.equal(prevStep(state), "weights");
  });
});

/* ------------------------------------------------------------------ */
/*  Metric collection                                                 */
/* ------------------------------------------------------------------ */

describe("collectMetrics", () => {
  it("collects entity metrics with home entities", () => {
    const { entities, relationships } = studentClassProfessor();
    const metrics = collectMetrics(entities, relationships);

    assert.equal(metrics.length, 3);
    assert.deepStrictEqual(metrics[0], {
      name: "tuition_paid",
      homeEntities: ["Student"],
    });
    assert.deepStrictEqual(metrics[1], {
      name: "class_budget",
      homeEntities: ["Class"],
    });
  });

  it("collects relationship metrics with both entities as home", () => {
    const { entities, relationships } = studentClassProfessor();
    relationships[0].metrics = [
      { name: "enrollment_grade", type: "float", nature: "additive" },
    ];
    const metrics = collectMetrics(entities, relationships);

    const relMetric = metrics.find((m) => m.name === "enrollment_grade");
    assert.ok(relMetric);
    assert.deepStrictEqual(relMetric.homeEntities, ["Student", "Class"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Adjacency and reachability                                        */
/* ------------------------------------------------------------------ */

describe("buildAdjacency", () => {
  it("builds bidirectional adjacency", () => {
    const { entities, relationships } = studentClassProfessor();
    const adj = buildAdjacency(entities, relationships);

    assert.equal(adj.get("Student")!.length, 1);
    assert.equal(adj.get("Class")!.length, 2);
    assert.equal(adj.get("Professor")!.length, 1);
  });
});

describe("findReachable", () => {
  it("finds all entities reachable from Student", () => {
    const { entities, relationships } = studentClassProfessor();
    const adj = buildAdjacency(entities, relationships);
    const reachable = findReachable(["Student"], adj);

    assert.ok(reachable.has("Class"));
    assert.ok(reachable.has("Professor"));
    assert.equal(reachable.get("Class"), "Enrollment");
    assert.equal(reachable.get("Professor"), "Assignment");
  });

  it("does not include home entities in reachable", () => {
    const { entities, relationships } = studentClassProfessor();
    const adj = buildAdjacency(entities, relationships);
    const reachable = findReachable(["Student"], adj);

    assert.ok(!reachable.has("Student"));
  });

  it("handles disconnected graphs", () => {
    const { entities, relationships } = studentClassProfessor();
    entities.push({
      name: "Building",
      role: "leaf",
      detail: true,
      estimated_rows: 50,
      metrics: [],
    });
    const adj = buildAdjacency(entities, relationships);
    const reachable = findReachable(["Building"], adj);

    assert.equal(reachable.size, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  Grid initialization                                               */
/* ------------------------------------------------------------------ */

describe("initGrid", () => {
  it("creates correct dimensions", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    assert.equal(metricNames.length, 3);
    assert.equal(entityNames.length, 3);
    assert.equal(grid.length, 3);
    assert.equal(grid[0].length, 3);
  });

  it("marks home cells correctly", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    // tuition_paid is on Student (col 0)
    const tuitionRow = metricNames.indexOf("tuition_paid");
    const studentCol = entityNames.indexOf("Student");
    assert.equal(grid[tuitionRow][studentCol].value, "home");
  });

  it("marks reachable cells as reserve by default", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    const tuitionRow = metricNames.indexOf("tuition_paid");
    const classCol = entityNames.indexOf("Class");
    assert.equal(grid[tuitionRow][classCol].value, "reserve");
    assert.equal(grid[tuitionRow][classCol].relationship, "Enrollment");
  });

  it("marks unreachable cells for disconnected entities", () => {
    const { entities, relationships } = studentClassProfessor();
    entities.push({
      name: "Building",
      role: "leaf",
      detail: true,
      estimated_rows: 50,
      metrics: [{ name: "square_feet", type: "integer", nature: "additive" }],
    });
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    // square_feet (on Building) can't reach Student/Class/Professor
    const sqftRow = metricNames.indexOf("square_feet");
    const studentCol = entityNames.indexOf("Student");
    assert.equal(grid[sqftRow][studentCol].value, "unreachable");
  });
});

/* ------------------------------------------------------------------ */
/*  Cell cycling                                                      */
/* ------------------------------------------------------------------ */

describe("cycleStrategy", () => {
  it("cycles through all strategies", () => {
    let cell: GridCell = {
      metricName: "m",
      entityName: "e",
      value: "reserve",
      relationship: "r",
    };

    cell = cycleStrategy(cell);
    assert.equal(cell.value, "elimination");

    cell = cycleStrategy(cell);
    assert.equal(cell.value, "allocation");

    cell = cycleStrategy(cell);
    assert.equal(cell.value, "sum_over_sum");

    cell = cycleStrategy(cell);
    assert.equal(cell.value, "reserve");
  });

  it("does not cycle home cells", () => {
    const cell: GridCell = { metricName: "m", entityName: "e", value: "home" };
    assert.equal(cycleStrategy(cell).value, "home");
  });

  it("does not cycle unreachable cells", () => {
    const cell: GridCell = { metricName: "m", entityName: "e", value: "unreachable" };
    assert.equal(cycleStrategy(cell).value, "unreachable");
  });
});

/* ------------------------------------------------------------------ */
/*  Propagation extraction                                            */
/* ------------------------------------------------------------------ */

describe("extractPropagations", () => {
  it("extracts non-reserve strategies as propagation edges", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    // Set tuition_paid → Class to allocation
    const tuitionRow = metricNames.indexOf("tuition_paid");
    const classCol = entityNames.indexOf("Class");
    grid[tuitionRow][classCol] = { ...grid[tuitionRow][classCol], value: "allocation" };

    const state: WizardState = {
      step: "tables",
      entities,
      relationships,
      grid,
      metricNames,
      entityNames,
      weights: new Map([["tuition_paid:Class", "enrollment_share"]]),
      bftTables: [],
    };

    const props = extractPropagations(state);
    assert.equal(props.length, 1);
    assert.equal(props[0].metric, "tuition_paid");
    assert.equal(props[0].path.length, 1);
    assert.equal(props[0].path[0].strategy, "allocation");
    assert.equal(props[0].path[0].weight, "enrollment_share");
  });

  it("skips reserve-only metrics", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    const state: WizardState = {
      step: "tables",
      entities,
      relationships,
      grid,
      metricNames,
      entityNames,
      weights: new Map(),
      bftTables: [],
    };

    // All non-home cells default to reserve, so no propagations
    const props = extractPropagations(state);
    assert.equal(props.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  Cells needing weights                                             */
/* ------------------------------------------------------------------ */

describe("cellsNeedingWeights", () => {
  it("finds allocation and sum_over_sum cells", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    const tuitionRow = metricNames.indexOf("tuition_paid");
    const classCol = entityNames.indexOf("Class");
    grid[tuitionRow][classCol] = { ...grid[tuitionRow][classCol], value: "allocation" };

    const salaryRow = metricNames.indexOf("salary");
    const studentCol = entityNames.indexOf("Student");
    // salary → Student (via Class → Student) — but relationship stores the first hop
    // For this test we just set it directly
    grid[salaryRow][studentCol] = { ...grid[salaryRow][studentCol], value: "sum_over_sum" };

    const state: WizardState = {
      step: "weights",
      entities,
      relationships,
      grid,
      metricNames,
      entityNames,
      weights: new Map(),
      bftTables: [],
    };

    const cells = cellsNeedingWeights(state);
    assert.equal(cells.length, 2);
  });

  it("returns empty when only reserve and elimination", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    const tuitionRow = metricNames.indexOf("tuition_paid");
    const classCol = entityNames.indexOf("Class");
    grid[tuitionRow][classCol] = { ...grid[tuitionRow][classCol], value: "elimination" };

    const state: WizardState = {
      step: "weights",
      entities,
      relationships,
      grid,
      metricNames,
      entityNames,
      weights: new Map(),
      bftTables: [],
    };

    const cells = cellsNeedingWeights(state);
    assert.equal(cells.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  buildManifest                                                     */
/* ------------------------------------------------------------------ */

describe("buildManifest", () => {
  it("assembles a complete manifest", () => {
    const { entities, relationships } = studentClassProfessor();
    const { grid, metricNames, entityNames } = initGrid(entities, relationships);

    const state: WizardState = {
      step: "tables",
      entities,
      relationships,
      grid,
      metricNames,
      entityNames,
      weights: new Map(),
      bftTables: [
        { name: "test_table", entities: ["Student", "Class"], metrics: ["tuition_paid"] },
      ],
    };

    const manifest = buildManifest(state);
    assert.equal(manifest.entities.length, 3);
    assert.equal(manifest.relationships.length, 2);
    assert.equal(manifest.bft_tables.length, 1);
    assert.equal(manifest.bft_tables[0].name, "test_table");
  });
});
