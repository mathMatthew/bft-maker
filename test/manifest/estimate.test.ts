import { describe, it } from "node:test";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import {
  estimateRows,
  estimateTableRows,
  fanOut,
} from "../../src/manifest/estimate.js";
import { loadManifest } from "../../src/manifest/yaml.js";
import type {
  Entity,
  Relationship,
  Manifest,
} from "../../src/manifest/types.js";

const dataDir = path.resolve(process.cwd(), "data");

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
    // = 120,000 × (1,800 / 1,200) = 180,000
    const result = estimateRows(entities, relationships, [
      "Student", "Class", "Professor",
    ]);
    assert.equal(result.rows, 180000);
  });

  it("unrelated entities sum their rows", () => {
    // Student and Professor with no connecting relationship
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
    // M-to-1 doesn't create M-M expansion, treated as sparse union
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

describe("estimateTableRows", () => {
  it("estimates rows from declared grain entities", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [
        {
          metric: "tuition_paid",
          path: [
            { relationship: "Enrollment", target_entity: "Class", strategy: "allocation", weight: "enrollment_share" },
            { relationship: "Assignment", target_entity: "Professor", strategy: "allocation", weight: "assignment_share" },
          ],
        },
      ],
      bft_tables: [{
        name: "test",
        entities: ["Student", "Class", "Professor"],
        metrics: ["tuition_paid", "salary"],
      }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    assert.equal(result.rows, 180000);
    // salary has no propagation = reserve, needs placeholder rows
    // One per Professor value: 800
    assert.equal(result.placeholder_row_count, 800);
    assert.equal(result.total, 180800);
  });

  it("counts elimination as needing placeholder rows", () => {
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
      bft_tables: [{
        name: "test",
        entities: ["Student", "Class"],
        metrics: ["tuition_paid", "class_budget"],
      }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    // class_budget elimination → placeholder rows for Class: 1200
    // tuition_paid has no propagation, Student is home with foreign entity (Class) → placeholder rows for Student: 45000
    assert.equal(result.placeholder_row_count, 1200 + 45000);
  });

  it("no placeholder rows for single-entity table", () => {
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [],
      bft_tables: [{
        name: "test",
        entities: ["Professor"],
        metrics: ["salary"],
      }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    assert.equal(result.rows, 800);
    assert.equal(result.placeholder_row_count, 0);
    assert.equal(result.total, 800);
  });

  it("unrelated entities sum rows (sparse union)", () => {
    const entityA: Entity = {
      name: "EntityA",
      role: "leaf",
      detail: true,
      estimated_rows: 100,
      metrics: [{ name: "metric_a", type: "currency", nature: "additive" }],
    };
    const entityB: Entity = {
      name: "EntityB",
      role: "leaf",
      detail: true,
      estimated_rows: 50,
      metrics: [{ name: "metric_b", type: "currency", nature: "additive" }],
    };
    const manifest: Manifest = {
      entities: [entityA, entityB],
      relationships: [],
      propagations: [],
      bft_tables: [{
        name: "unrelated",
        entities: ["EntityA", "EntityB"],
        metrics: ["metric_a", "metric_b"],
      }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    // Unrelated entities: sparse union
    assert.equal(result.rows, 100 + 50);
  });

  it("propagation hops outside grain are ignored for placeholder counting", () => {
    // tuition propagates Student → Class → Professor, but Professor
    // isn't in the grain — the hop to Professor is irrelevant.
    const manifest: Manifest = {
      entities,
      relationships,
      propagations: [
        {
          metric: "tuition_paid",
          path: [
            { relationship: "Enrollment", target_entity: "Class", strategy: "allocation", weight: "enrollment_share" },
            { relationship: "Assignment", target_entity: "Professor", strategy: "reserve" },
          ],
        },
      ],
      bft_tables: [{
        name: "test",
        entities: ["Student", "Class"],
        metrics: ["tuition_paid"],
      }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    // The reserve hop to Professor is outside the grain — no placeholder rows for it
    assert.equal(result.placeholder_row_count, 0);
  });
});

describe("estimateTableRows — reference manifests", () => {
  it("university-ops combined table: Building×Month + Program×Month", () => {
    const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
    const combined = m.bft_tables.find((t) => t.name === "monthly_operations")!;
    const result = estimateTableRows(m, combined);
    // Building×Month (60) + Program×Month (36) = 96 (Month connects both)
    // NOT Building×Month×Program cross product
    assert.equal(result.rows, 96);
  });

  it("university-ops facilities-only table", () => {
    const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
    const facilities = m.bft_tables.find((t) => t.name === "facilities_monthly")!;
    const result = estimateTableRows(m, facilities);
    assert.equal(result.rows, 60);
  });

  it("university-ops admissions-only table", () => {
    const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
    const admissions = m.bft_tables.find((t) => t.name === "admissions_monthly")!;
    const result = estimateTableRows(m, admissions);
    assert.equal(result.rows, 36);
  });

  it("university department_financial table", () => {
    const m = loadManifest(path.join(dataDir, "university/manifest.yaml"));
    const table = m.bft_tables.find((t) => t.name === "department_financial")!;
    const result = estimateTableRows(m, table);
    // 90 enrollments × (13 assignments / 10 classes) = 117 rows
    assert.equal(result.rows, 117);
  });

  it("northwind order_product table", () => {
    const m = loadManifest(path.join(dataDir, "northwind/manifest.yaml"));
    const table = m.bft_tables.find((t) => t.name === "order_product")!;
    const result = estimateTableRows(m, table);
    // 2155 links (OrderDetails M-M)
    assert.equal(result.rows, 2155);
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
