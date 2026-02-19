import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  estimateRows,
  estimateTableRows,
  deriveGrainEntities,
  fanOut,
} from "../../src/manifest/estimate.js";
import type {
  Entity,
  Relationship,
  Manifest,
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
    const result = estimateRows(entities, relationships, ["Student", "Class"]);
    assert.equal(result.rows, 120000);
  });

  it("two M-M bridges sharing a bridge entity", () => {
    const result = estimateRows(entities, relationships, [
      "Student", "Class", "Professor",
    ]);
    assert.equal(result.rows, 180000);
  });

  it("unrelated entities sum their rows", () => {
    const result = estimateRows(entities, [], ["Student", "Professor"]);
    assert.equal(result.rows, 45000 + 800);
  });

  it("many-to-one relationships do not create cross-product", () => {
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
    assert.equal(result.rows, 45000 + 50);
  });

  it("provides breakdown describing the calculation", () => {
    const result = estimateRows(entities, relationships, [
      "Student", "Class", "Professor",
    ]);
    assert.ok(result.breakdown.length > 0);
    assert.ok(result.breakdown.some((b) => b.includes("Enrollment")));
    assert.ok(result.breakdown.some((b) => b.includes("Assignment")));
  });
});

describe("deriveGrainEntities", () => {
  it("derives grain from propagation paths", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [
        {
          metric: "tuition_paid",
          path: [
            { relationship: "Enrollment", target_entity: "Class", strategy: "allocation" },
            { relationship: "Assignment", target_entity: "Professor", strategy: "allocation" },
          ],
        },
      ],
      bft_tables: [{ name: "test", metrics: ["tuition_paid", "salary"] }],
    };
    const grain = deriveGrainEntities(manifest, manifest.bft_tables[0]);
    assert.ok(grain.includes("Student"));
    assert.ok(grain.includes("Class"));
    assert.ok(grain.includes("Professor"));
    assert.equal(grain.length, 3);
  });

  it("includes home entity even without propagation", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [],
      bft_tables: [{ name: "test", metrics: ["salary"] }],
    };
    const grain = deriveGrainEntities(manifest, manifest.bft_tables[0]);
    assert.deepStrictEqual(grain, ["Professor"]);
  });
});

describe("estimateTableRows", () => {
  it("estimates rows from propagation-derived grain", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [
        {
          metric: "tuition_paid",
          path: [
            { relationship: "Enrollment", target_entity: "Class", strategy: "allocation" },
            { relationship: "Assignment", target_entity: "Professor", strategy: "allocation" },
          ],
        },
      ],
      bft_tables: [{ name: "test", metrics: ["tuition_paid", "salary"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    assert.equal(result.rows, 180000);
    // salary has no propagation = reserve, needs reserve row
    assert.equal(result.reserve_row_count, 1);
    assert.equal(result.total, 180001);
  });

  it("counts elimination as needing reserve rows", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [
        {
          metric: "class_budget",
          path: [
            { relationship: "Enrollment", target_entity: "Student", strategy: "elimination" },
          ],
        },
      ],
      bft_tables: [{ name: "test", metrics: ["tuition_paid", "class_budget"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    assert.ok(result.reserve_row_count >= 1);
  });

  it("no reserve rows for single-entity table", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [],
      bft_tables: [{ name: "test", metrics: ["salary"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    assert.equal(result.rows, 800);
    assert.equal(result.reserve_row_count, 0);
    assert.equal(result.total, 800);
  });
});

describe("fanOut", () => {
  it("computes fan-out for Enrollment", () => {
    assert.equal(fanOut(enrollment, classEntity), 100);
  });

  it("computes fan-out for Assignment", () => {
    assert.equal(fanOut(assignment, classEntity), 1.5);
  });
});
