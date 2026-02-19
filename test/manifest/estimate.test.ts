import { describe, it } from "node:test";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import {
  estimateRows,
  estimateTableRows,
  deriveGrainEntities,
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

describe("estimateTableRows — independent chains", () => {
  // Shared dimension: Building and Program both connect to Month
  // but no metric spans both. Codegen emits UNION ALL, not cross product.
  const building: Entity = {
    name: "Building",
    role: "leaf",
    detail: true,
    estimated_rows: 5,
    metrics: [
      { name: "maintenance_cost", type: "currency", nature: "additive" },
    ],
  };
  const program: Entity = {
    name: "Program",
    role: "leaf",
    detail: true,
    estimated_rows: 3,
    metrics: [
      { name: "applications", type: "integer", nature: "additive" },
    ],
  };
  const month: Entity = {
    name: "Month",
    role: "bridge",
    detail: true,
    estimated_rows: 12,
    metrics: [],
  };
  const buildingMonth: Relationship = {
    name: "BuildingMonth",
    between: ["Building", "Month"],
    type: "many-to-many",
    estimated_links: 60,
  };
  const programMonth: Relationship = {
    name: "ProgramMonth",
    between: ["Program", "Month"],
    type: "many-to-many",
    estimated_links: 36,
  };
  const sharedEntities = [building, program, month];
  const sharedRels = [buildingMonth, programMonth];

  it("shared dimension with independent chains sums rows (UNION ALL)", () => {
    const manifest: Manifest = {
      entities: sharedEntities,
      relationships: sharedRels,
      propagations: [
        {
          metric: "maintenance_cost",
          path: [
            { relationship: "BuildingMonth", target_entity: "Month", strategy: "allocation", weight: "equal_share" },
          ],
        },
        {
          metric: "applications",
          path: [
            { relationship: "ProgramMonth", target_entity: "Month", strategy: "allocation", weight: "equal_share" },
          ],
        },
      ],
      bft_tables: [{ name: "combined", metrics: ["maintenance_cost", "applications"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    // Two independent chains: Building×Month (60) + Program×Month (36) = 96
    // NOT cross product Building×Month×Program (180)
    assert.equal(result.rows, 60 + 36);
    assert.ok(result.breakdown.some((b) => b.includes("UNION ALL")));
  });

  it("completely unrelated entities sum rows", () => {
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
      bft_tables: [{ name: "unrelated", metrics: ["metric_a", "metric_b"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    assert.equal(result.rows, 100 + 50);
    assert.ok(result.breakdown.some((b) => b.includes("UNION ALL")));
  });

  it("metric spanning shared dimension forces cross product", () => {
    // If a metric propagates Building → Month → Program, all three
    // are in one chain and must be cross-producted.
    const directRel: Relationship = {
      name: "BuildingProgram",
      between: ["Building", "Program"],
      type: "many-to-many",
      estimated_links: 15,
    };
    const manifest: Manifest = {
      entities: sharedEntities,
      relationships: [...sharedRels, directRel],
      propagations: [
        {
          metric: "maintenance_cost",
          path: [
            { relationship: "BuildingMonth", target_entity: "Month", strategy: "allocation", weight: "equal_share" },
            { relationship: "ProgramMonth", target_entity: "Program", strategy: "allocation", weight: "equal_share" },
          ],
        },
        {
          metric: "applications",
          path: [
            { relationship: "ProgramMonth", target_entity: "Month", strategy: "allocation", weight: "equal_share" },
          ],
        },
      ],
      bft_tables: [{ name: "spanning", metrics: ["maintenance_cost", "applications"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    // maintenance_cost chain: {Building, Month, Program} — cross product
    // applications chain: {Program, Month} — subset, removed
    // Result: single chain cross product through all three
    assert.ok(result.rows > 96);
  });

  it("subset chains are absorbed by larger chains", () => {
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
        {
          metric: "class_budget",
          path: [
            { relationship: "Enrollment", target_entity: "Student", strategy: "elimination" },
          ],
        },
      ],
      bft_tables: [{ name: "test", metrics: ["tuition_paid", "class_budget", "salary"] }],
    };
    const result = estimateTableRows(manifest, manifest.bft_tables[0]);
    // tuition chain: {Student, Class, Professor} — largest
    // class_budget chain: {Class, Student} — subset, removed
    // salary chain: {Professor} — subset, removed
    // Single chain: 180000
    assert.equal(result.rows, 180000);
  });
});

describe("estimateTableRows — reference manifests", () => {
  it("university-ops combined table uses UNION ALL (not cross product)", () => {
    const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
    const combined = m.bft_tables.find((t) => t.name === "monthly_operations")!;
    const result = estimateTableRows(m, combined);
    // Building×Month (60) + Program×Month (36) = 96, not 180
    assert.equal(result.rows, 96);
    assert.ok(result.breakdown.some((b) => b.includes("UNION ALL")));
  });

  it("university-ops facilities-only table is single chain", () => {
    const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
    const facilities = m.bft_tables.find((t) => t.name === "facilities_monthly")!;
    const result = estimateTableRows(m, facilities);
    assert.equal(result.rows, 60);
  });

  it("university-ops admissions-only table is single chain", () => {
    const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
    const admissions = m.bft_tables.find((t) => t.name === "admissions_monthly")!;
    const result = estimateTableRows(m, admissions);
    assert.equal(result.rows, 36);
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
