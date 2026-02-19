import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { validate } from "../../src/manifest/validate.js";
import type { Manifest } from "../../src/manifest/types.js";

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
          {
            name: "satisfaction_score",
            type: "rating",
            nature: "non-additive",
          },
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
          {
            name: "years_experience",
            type: "integer",
            nature: "non-additive",
          },
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
    metric_clusters: [
      {
        name: "financial_overview",
        metrics: ["tuition_paid", "salary", "class_budget"],
        traversals: [
          {
            metric: "tuition_paid",
            on_foreign_rows: "allocation",
            weight: "enrollment_share",
            weight_source: "Enrollment",
          },
          {
            metric: "salary",
            on_foreign_rows: "allocation",
            weight: "assignment_share",
            weight_source: "Assignment",
          },
          {
            metric: "class_budget",
            on_foreign_rows: "allocation",
            weight: "enrollment_count",
            weight_source: "Enrollment",
          },
        ],
      },
      {
        name: "student_experience",
        metrics: ["tuition_paid", "satisfaction_score"],
        traversals: [],
      },
    ],
    bft_tables: [
      {
        name: "department_financial",
        grain: "Student × Class × Professor",
        grain_entities: ["Student", "Class", "Professor"],
        clusters_served: ["financial_overview"],
        estimated_rows: 180000,
        metrics: [
          {
            metric: "tuition_paid",
            strategy: "allocation",
            weight: "enrollment_share",
            sum_safe: true,
            requires_reserve_rows: false,
          },
          {
            metric: "salary",
            strategy: "allocation",
            weight: "assignment_share",
            sum_safe: true,
            requires_reserve_rows: false,
          },
          {
            metric: "class_budget",
            strategy: "allocation",
            weight: "enrollment_count",
            sum_safe: true,
            requires_reserve_rows: false,
          },
        ],
        reserve_rows: [],
      },
      {
        name: "student_advising",
        grain: "Student × Class",
        grain_entities: ["Student", "Class"],
        clusters_served: ["student_experience"],
        estimated_rows: 120000,
        metrics: [
          {
            metric: "tuition_paid",
            strategy: "direct",
            sum_safe: true,
            requires_reserve_rows: false,
          },
          {
            metric: "satisfaction_score",
            strategy: "sum_over_sum",
            weight_column: "satisfaction_weight",
            sum_safe: false,
            requires_reserve_rows: false,
          },
        ],
        reserve_rows: [],
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
      m.entities[1].metrics.push({
        name: "tuition_paid",
        type: "currency",
        nature: "additive",
      });
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
  });

  describe("cluster metric references", () => {
    it("catches nonexistent metric in cluster", () => {
      const m = validManifest();
      m.metric_clusters[0].metrics.push("nonexistent_metric");
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "cluster-metric-exists" && e.message.includes("nonexistent_metric")));
    });
  });

  describe("traversal rules", () => {
    it("catches missing traversal rule for multi-entity cluster", () => {
      const m = validManifest();
      // Remove one traversal rule from financial_overview
      m.metric_clusters[0].traversals = m.metric_clusters[0].traversals.filter(
        (t) => t.metric !== "salary"
      );
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "traversal-rule-required" && e.message.includes("salary")));
    });

    it("allows no traversals for single-entity cluster", () => {
      const m = validManifest();
      // student_experience has only Student metrics — no traversals needed
      const errors = validate(m);
      const expErrors = errors.filter(
        (e) => e.rule === "traversal-rule-required" && e.path?.includes("student_experience")
      );
      assert.deepStrictEqual(expErrors, []);
    });

    it("catches nonexistent relationship in weight_source", () => {
      const m = validManifest();
      m.metric_clusters[0].traversals[0].weight_source = "FakeRelationship";
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "traversal-relationship-exists" && e.message.includes("FakeRelationship")));
    });
  });

  describe("non-additive strategy constraints", () => {
    it("catches allocation on non-additive metric in traversal", () => {
      const m = validManifest();
      // Add satisfaction_score to financial_overview with allocation strategy
      m.metric_clusters[0].metrics.push("satisfaction_score");
      m.metric_clusters[0].traversals.push({
        metric: "satisfaction_score",
        on_foreign_rows: "allocation",
        weight: "equal_split",
      });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "non-additive-strategy" && e.message.includes("satisfaction_score")));
    });

    it("catches elimination on non-additive metric in table", () => {
      const m = validManifest();
      m.bft_tables[0].metrics.push({
        metric: "years_experience",
        strategy: "elimination",
        sum_safe: true,
        requires_reserve_rows: true,
      });
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "non-additive-strategy" && e.message.includes("years_experience")));
    });

    it("allows sum_over_sum on non-additive metric", () => {
      const m = validManifest();
      // satisfaction_score already uses sum_over_sum in student_advising table
      const errors = validate(m);
      const sErrors = errors.filter(
        (e) => e.rule === "non-additive-strategy" && e.message.includes("satisfaction_score")
      );
      assert.deepStrictEqual(sErrors, []);
    });
  });

  describe("grain connectivity", () => {
    it("catches nonexistent grain entity", () => {
      const m = validManifest();
      m.bft_tables[0].grain_entities.push("FakeEntity");
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "grain-entity-exists" && e.message.includes("FakeEntity")));
    });

    it("catches nonexistent cluster reference in table", () => {
      const m = validManifest();
      m.bft_tables[0].clusters_served.push("fake_cluster");
      const errors = validate(m);
      assert.ok(errors.some((e) => e.rule === "table-cluster-exists" && e.message.includes("fake_cluster")));
    });

    it("catches partially connected grain entities", () => {
      const m = validManifest();
      // Add an entity connected to Student but not Professor
      m.entities.push({
        name: "Advisor",
        role: "leaf",
        detail: true,
        estimated_rows: 200,
        metrics: [],
      });
      m.relationships.push({
        name: "Advising",
        between: ["Student", "Advisor"],
        type: "many-to-many",
        estimated_links: 50000,
      });
      // Make a table with Student, Advisor, and a disconnected entity
      m.bft_tables.push({
        name: "mixed_table",
        grain: "Student × Advisor × Professor",
        grain_entities: ["Student", "Advisor", "Professor"],
        clusters_served: [],
        estimated_rows: 100000,
        metrics: [],
        reserve_rows: [],
      });
      const errors = validate(m);
      // Professor is connected to Student via Class, but Class isn't in grain...
      // So Student-Advisor connected, Professor isolated = partial connectivity
      assert.ok(errors.some((e) => e.rule === "grain-connectivity"));
    });

    it("allows fully connected grain entities", () => {
      const m = validManifest();
      const errors = validate(m);
      const connErrors = errors.filter((e) => e.rule === "grain-connectivity");
      assert.deepStrictEqual(connErrors, []);
    });
  });

  describe("multiple errors", () => {
    it("returns all errors at once", () => {
      const m = validManifest();
      m.entities[0].estimated_rows = -1;
      m.relationships[0].between = ["Student", "Missing"];
      m.metric_clusters[0].metrics.push("ghost_metric");
      const errors = validate(m);
      assert.ok(errors.length >= 3);
    });
  });
});
