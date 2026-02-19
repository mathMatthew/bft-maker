import { describe, it } from "node:test";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { validate } from "../../src/manifest/validate.js";
import { loadManifest } from "../../src/manifest/yaml.js";
import type { Manifest } from "../../src/manifest/types.js";

const dataDir = path.resolve(process.cwd(), "data");

function validManifest(): Manifest {
  return {
    entities: [
      {
        name: "Student",
        role: "leaf",
        detail: true,
        estimated_rows: 45000,
        metrics: [
          { name: "tuition_paid", type: "currency", nature: "additive" },
          { name: "satisfaction_score", type: "rating", nature: "non-additive" },
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
    propagations: [
      {
        metric: "tuition_paid",
        path: [
          { relationship: "Enrollment", target_entity: "Class", strategy: "allocation", weight: "enrollment_share" },
          { relationship: "Assignment", target_entity: "Professor", strategy: "allocation", weight: "assignment_share" },
        ],
      },
      {
        metric: "class_budget",
        path: [
          { relationship: "Enrollment", target_entity: "Student", strategy: "elimination" },
        ],
      },
      {
        metric: "satisfaction_score",
        path: [
          { relationship: "Enrollment", target_entity: "Class", strategy: "sum_over_sum", weight: "satisfaction_weight" },
        ],
      },
    ],
    bft_tables: [
      {
        name: "department_financial",
        metrics: ["tuition_paid", "class_budget", "salary"],
      },
      {
        name: "student_advising",
        metrics: ["tuition_paid", "satisfaction_score", "class_budget"],
      },
    ],
  };
}

describe("validate", () => {
  it("passes a valid manifest", () => {
    const errors = validate(validManifest());
    assert.deepStrictEqual(errors, []);
  });

  describe("duplicate names", () => {
    it("catches duplicate entity names", () => {
      const m = validManifest();
      m.entities.push({ ...m.entities[0] });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "no-duplicates" && e.message.includes("Student")));
    });

    it("catches duplicate metric names", () => {
      const m = validManifest();
      m.entities[1].metrics.push({ name: "tuition_paid", type: "currency", nature: "additive" });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "no-duplicates" && e.message.includes("tuition_paid")));
    });

    it("catches duplicate relationship names", () => {
      const m = validManifest();
      m.relationships.push({ ...m.relationships[0] });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "no-duplicates" && e.message.includes("Enrollment")));
    });

    it("catches duplicate table names", () => {
      const m = validManifest();
      m.bft_tables.push({ ...m.bft_tables[0] });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "no-duplicates" && e.message.includes("department_financial")));
    });
  });

  describe("positive cardinalities", () => {
    it("catches zero estimated_rows", () => {
      const m = validManifest();
      m.entities[0].estimated_rows = 0;
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "positive-cardinality" && e.message.includes("Student")));
    });

    it("catches negative estimated_links", () => {
      const m = validManifest();
      m.relationships[0].estimated_links = -5;
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "positive-cardinality" && e.message.includes("Enrollment")));
    });

    it("catches non-integer estimated_rows", () => {
      const m = validManifest();
      m.entities[0].estimated_rows = 45000.5;
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "positive-cardinality" && e.message.includes("Student")));
    });
  });

  describe("relationship entity references", () => {
    it("catches nonexistent entity in relationship", () => {
      const m = validManifest();
      m.relationships[0].between = ["Student", "Course"];
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "relationship-entity-exists" && e.message.includes("Course")));
    });

    it("catches relationship with wrong number of entities in between", () => {
      const m = validManifest();
      (m.relationships[0] as any).between = ["Student", "Class", "Professor"];
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "relationship-between-pair" && e.message.includes("3")));
    });
  });

  describe("propagation paths", () => {
    it("catches nonexistent metric in propagation", () => {
      const m = validManifest();
      m.propagations.push({ metric: "ghost_metric", path: [] });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "propagation-metric-exists" && e.message.includes("ghost_metric")));
    });

    it("catches nonexistent relationship in propagation path", () => {
      const m = validManifest();
      m.propagations.push({
        metric: "salary",
        path: [{ relationship: "FakeRel", target_entity: "Class", strategy: "allocation" }],
      });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "propagation-relationship-exists" && e.message.includes("FakeRel")));
    });

    it("catches nonexistent target entity in propagation path", () => {
      const m = validManifest();
      m.propagations.push({
        metric: "salary",
        path: [{ relationship: "Assignment", target_entity: "FakeEntity", strategy: "allocation" }],
      });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "propagation-entity-exists" && e.message.includes("FakeEntity")));
    });

    it("catches disconnected propagation path", () => {
      const m = validManifest();
      m.propagations.push({
        metric: "salary",
        path: [{ relationship: "Enrollment", target_entity: "Student", strategy: "allocation" }],
      });
      const errors = validate(m);
      // Enrollment connects Student-Class, not Professor-Student
      assert.ok(errors.some((e) => e.rule === "propagation-path-connected"));
    });

    it("catches cycles in propagation path", () => {
      const m = validManifest();
      m.relationships.push({
        name: "Advising",
        between: ["Student", "Professor"],
        type: "many-to-many",
        estimated_links: 5000,
      });
      m.propagations.push({
        metric: "salary",
        path: [
          { relationship: "Assignment", target_entity: "Class", strategy: "allocation" },
          { relationship: "Enrollment", target_entity: "Student", strategy: "allocation" },
          { relationship: "Advising", target_entity: "Professor", strategy: "allocation" },
        ],
      });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "propagation-no-cycle" && e.message.includes("Professor")));
    });

    it("catches non-additive metric with allocation strategy", () => {
      const m = validManifest();
      m.propagations = m.propagations.filter((p) => p.metric !== "satisfaction_score");
      m.propagations.push({
        metric: "satisfaction_score",
        path: [{ relationship: "Enrollment", target_entity: "Class", strategy: "allocation" }],
      });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "non-additive-strategy" && e.message.includes("satisfaction_score")));
    });

    it("allows sum_over_sum on non-additive metric", () => {
      const m = validManifest();
      const errors = validate(m);
      const sErrors = errors.filter((e) => e.rule === "non-additive-strategy" && e.message.includes("satisfaction_score"));
      assert.deepStrictEqual(sErrors, []);
    });
  });

  describe("table metric references", () => {
    it("catches nonexistent metric in table", () => {
      const m = validManifest();
      m.bft_tables[0].metrics.push("nonexistent_metric");
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "table-metric-exists" && e.message.includes("nonexistent_metric")));
    });
  });

  describe("multiple errors", () => {
    it("returns all errors at once", () => {
      const m = validManifest();
      m.entities[0].estimated_rows = -1;
      m.relationships[0].between = ["Student", "Missing"];
      m.propagations.push({ metric: "ghost_metric", path: [] });
      const errors = validate(m);
      assert.ok(errors.length >= 3);
    });
  });

  describe("reference manifests", () => {
    it("university manifest validates", () => {
      const m = loadManifest(path.join(dataDir, "university/manifest.yaml"));
      const errors = validate(m);
      assert.deepStrictEqual(errors, []);
    });

    it("northwind manifest validates", () => {
      const m = loadManifest(path.join(dataDir, "northwind/manifest.yaml"));
      const errors = validate(m);
      assert.deepStrictEqual(errors, []);
    });

    it("university-ops manifest validates (shared dimension)", () => {
      const m = loadManifest(path.join(dataDir, "university-ops/manifest.yaml"));
      const errors = validate(m);
      assert.deepStrictEqual(errors, []);
    });
  });
});
