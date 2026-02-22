import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { loadManifest } from "../../src/manifest/yaml.js";
import { generate } from "../../src/codegen/generator.js";
import { defaultSourceMapping, planTable } from "../../src/codegen/planner.js";

describe("planner", () => {
  const manifest = loadManifest("data/university/manifest.yaml");
  const sm = defaultSourceMapping(manifest);

  it("builds correct source mapping", () => {
    assert.equal(sm.entities["Student"].table, "students");
    assert.equal(sm.entities["Student"].idColumn, "student_id");
    assert.equal(sm.entities["Class"].table, "classes");
    assert.equal(sm.relationships["Enrollment"].table, "enrollments");
    assert.deepEqual(sm.relationships["Enrollment"].columns, {
      Student: "student_id",
      Class: "class_id",
    });
  });

  it("plans department_financial with correct strategies", () => {
    const table = manifest.bft_tables.find((t) => t.name === "department_financial")!;
    const plan = planTable(manifest, table, sm);

    assert.equal(plan.tableName, "department_financial");
    assert.deepEqual(plan.entities, ["Student", "Class", "Professor"]);
    assert.equal(plan.joinChain.length, 2);

    // tuition_paid: fully_allocated (allocation to Class and Professor)
    const tuition = plan.metrics.find((m) => m.name === "tuition_paid")!;
    assert.equal(tuition.behavior, "fully_allocated");
    assert.equal(tuition.homeEntity, "Student");

    // class_budget: mixed (elimination to Student, reserve for Professor)
    const budget = plan.metrics.find((m) => m.name === "class_budget")!;
    assert.equal(budget.behavior, "mixed");
    assert.equal(budget.homeEntity, "Class");

    // salary: pure_reserve (no propagation)
    const salary = plan.metrics.find((m) => m.name === "salary")!;
    assert.equal(salary.behavior, "pure_reserve");
    assert.equal(salary.homeEntity, "Professor");
  });

  it("plans student_experience with correct strategies", () => {
    const table = manifest.bft_tables.find((t) => t.name === "student_experience")!;
    const plan = planTable(manifest, table, sm);

    assert.equal(plan.entities.length, 2);
    assert.equal(plan.joinChain.length, 1);

    const tuition = plan.metrics.find((m) => m.name === "tuition_paid")!;
    assert.equal(tuition.behavior, "fully_allocated");

    const satisfaction = plan.metrics.find((m) => m.name === "satisfaction_score")!;
    assert.equal(satisfaction.behavior, "sum_over_sum");

    const budget = plan.metrics.find((m) => m.name === "class_budget")!;
    assert.equal(budget.behavior, "pure_elimination");
  });
});

describe("generator", () => {
  const manifest = loadManifest("data/university/manifest.yaml");

  it("generates SQL for all tables", () => {
    const output = generate(manifest);

    assert.ok(output.loadDataSQL.includes("CREATE OR REPLACE TABLE students"));
    assert.ok(output.loadDataSQL.includes("CREATE OR REPLACE TABLE enrollments"));
    assert.equal(output.tables.length, 2);

    const df = output.tables.find((t) => t.name === "department_financial")!;
    assert.ok(df.sql.includes("CREATE OR REPLACE TABLE df_base"));
    assert.ok(df.sql.includes("CREATE OR REPLACE TABLE df_weighted"));
    assert.ok(df.sql.includes("CREATE OR REPLACE TABLE department_financial"));
    // Multi-hop allocation
    assert.ok(df.sql.includes("enrollment_count"));
    assert.ok(df.sql.includes("assignment_count"));
    // Reserve branch for salary
    assert.ok(df.sql.includes("Reserve placeholder rows for salary"));
    // Mixed branches for class_budget
    assert.ok(df.sql.includes("class_budget elimination data rows"));
    assert.ok(df.sql.includes("class_budget elimination correction rows"));

    const se = output.tables.find((t) => t.name === "student_experience")!;
    assert.ok(se.sql.includes("CREATE OR REPLACE TABLE se_base"));
    assert.ok(se.sql.includes("Elimination correction rows for class_budget"));
    // Sum/Sum weight
    assert.ok(se.sql.includes("satisfaction_score_weight"));
  });

  it("generates valid run script", () => {
    const output = generate(manifest);
    assert.ok(output.runScript.includes("#!/bin/bash"));
    assert.ok(output.runScript.includes("duckdb"));
  });
});
