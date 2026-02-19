import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  estimateRows,
  estimateTableRows,
  fanOut,
} from "../../src/manifest/estimate.js";
import type {
  Entity,
  Relationship,
  BftTable,
} from "../../src/manifest/types.js";

const student: Entity = {
  name: "Student",
  role: "leaf",
  detail: true,
  estimated_rows: 45000,
  metrics: [
    { name: "tuition_paid", type: "currency", nature: "additive" },
    { name: "satisfaction_score", type: "rating", nature: "non-additive" },
  ],
};

const classEntity: Entity = {
  name: "Class",
  role: "bridge",
  detail: true,
  estimated_rows: 1200,
  metrics: [
    { name: "class_budget", type: "currency", nature: "additive" },
  ],
};

const professor: Entity = {
  name: "Professor",
  role: "leaf",
  detail: true,
  estimated_rows: 800,
  metrics: [
    { name: "salary", type: "currency", nature: "additive" },
  ],
};

const enrollment: Relationship = {
  name: "Enrollment",
  between: ["Student", "Class"],
  type: "many-to-many",
  estimated_links: 120000,
};

const assignment: Relationship = {
  name: "Assignment",
  between: ["Class", "Professor"],
  type: "many-to-many",
  estimated_links: 1800,
};

const entities = [student, classEntity, professor];
const relationships = [enrollment, assignment];

describe("estimateRows", () => {
  it("single entity returns estimated_rows", () => {
    const result = estimateRows(entities, relationships, ["Student"]);
    assert.equal(result.rows, 45000);
  });

  it("single M-M bridge returns estimated_links", () => {
    // Student × Class via Enrollment
    const result = estimateRows(entities, relationships, ["Student", "Class"]);
    assert.equal(result.rows, 120000);
  });

  it("two M-M bridges sharing a bridge entity", () => {
    // Student × Class × Professor
    // = Enrollment links × (Assignment links / Class rows)
    // = 120,000 × (1,800 / 1,200) = 120,000 × 1.5 = 180,000
    const result = estimateRows(entities, relationships, [
      "Student",
      "Class",
      "Professor",
    ]);
    assert.equal(result.rows, 180000);
  });

  it("unrelated entities sum their rows", () => {
    // Student and Professor with no connecting relationship
    const result = estimateRows(
      entities,
      [], // no relationships
      ["Student", "Professor"]
    );
    assert.equal(result.rows, 45000 + 800);
  });

  it("many-to-one relationships do not create cross-product", () => {
    // M-to-1 relationships are not used for row expansion — entities
    // connected only via M-to-1 are treated as independent (sparse union)
    const department: Entity = {
      name: "Department",
      role: "leaf",
      detail: true,
      estimated_rows: 50,
      metrics: [],
    };
    const mtoRel: Relationship = {
      name: "StudentDept",
      between: ["Student", "Department"],
      type: "many-to-one",
      estimated_links: 45000,
    };
    const result = estimateRows(
      [...entities, department],
      [mtoRel],
      ["Student", "Department"]
    );
    // M-to-1 doesn't create M-M expansion, so treated as sparse union
    assert.equal(result.rows, 45000 + 50);
  });

  it("provides breakdown describing the calculation", () => {
    const result = estimateRows(entities, relationships, [
      "Student",
      "Class",
      "Professor",
    ]);
    assert.ok(result.breakdown.length > 0);
    assert.ok(result.breakdown.some((b) => b.includes("Enrollment")));
    assert.ok(result.breakdown.some((b) => b.includes("Assignment")));
  });
});

describe("estimateTableRows", () => {
  it("adds reserve rows for reserve-strategy metrics", () => {
    const table: BftTable = {
      name: "test_table",
      grain: "Student × Class × Professor",
      grain_entities: ["Student", "Class", "Professor"],
      clusters_served: ["financial_overview"],
      estimated_rows: 180000,
      metrics: [
        {
          metric: "tuition_paid",
          strategy: "allocation",
          sum_safe: true,
          requires_reserve_rows: false,
        },
        {
          metric: "salary",
          strategy: "reserve",
          sum_safe: true,
          requires_reserve_rows: true,
        },
      ],
      reserve_rows: ["<Reserve Professor>"],
    };

    const result = estimateTableRows(entities, relationships, table);
    assert.equal(result.rows, 180000);
    assert.equal(result.reserve_row_count, 1); // Professor has reserve-strategy metric
    assert.equal(result.total, 180001);
  });

  it("counts elimination metrics as needing reserve rows", () => {
    const table: BftTable = {
      name: "test_table",
      grain: "Student × Class",
      grain_entities: ["Student", "Class"],
      clusters_served: [],
      estimated_rows: 120000,
      metrics: [
        {
          metric: "class_budget",
          strategy: "elimination",
          sum_safe: true,
          requires_reserve_rows: true,
        },
      ],
      reserve_rows: ["<Reserve Class>"],
    };

    const result = estimateTableRows(entities, relationships, table);
    assert.equal(result.reserve_row_count, 1);
    assert.equal(result.total, 120001);
  });

  it("no reserve rows when all metrics are allocation or direct", () => {
    const table: BftTable = {
      name: "test_table",
      grain: "Student × Class",
      grain_entities: ["Student", "Class"],
      clusters_served: [],
      estimated_rows: 120000,
      metrics: [
        {
          metric: "tuition_paid",
          strategy: "direct",
          sum_safe: true,
          requires_reserve_rows: false,
        },
        {
          metric: "class_budget",
          strategy: "allocation",
          sum_safe: true,
          requires_reserve_rows: false,
        },
      ],
      reserve_rows: [],
    };

    const result = estimateTableRows(entities, relationships, table);
    assert.equal(result.reserve_row_count, 0);
    assert.equal(result.total, 120000);
  });
});

describe("fanOut", () => {
  it("computes fan-out for Enrollment", () => {
    // 120,000 links / 1,200 classes = 100 students per class
    assert.equal(fanOut(enrollment, classEntity), 100);
  });

  it("computes fan-out for Assignment", () => {
    // 1,800 links / 1,200 classes = 1.5 professors per class
    assert.equal(fanOut(assignment, classEntity), 1.5);
  });
});
