import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
    assert.deepEqual(plan.bftGrain, ["Student", "Class", "Professor"]);
    assert.equal(plan.bftJoinChain.length, 2);

    const allMetrics = plan.grainGroups.flatMap((g) => g.metrics);

    // tuition_paid: fully_allocated (allocation to Class and Professor)
    const tuition = allMetrics.find((m) => m.name === "tuition_paid")!;
    assert.equal(tuition.behavior, "fully_allocated");
    assert.equal(tuition.home.grain[0], "Student");

    // class_budget: mixed (elimination to Student, reserve for Professor)
    const budget = allMetrics.find((m) => m.name === "class_budget")!;
    assert.equal(budget.behavior, "mixed");
    assert.equal(budget.home.grain[0], "Class");

    // salary: pure_reserve (no propagation)
    const salary = allMetrics.find((m) => m.name === "salary")!;
    assert.equal(salary.behavior, "pure_reserve");
    assert.equal(salary.home.grain[0], "Professor");
  });

  it("plans student_experience with correct strategies", () => {
    const table = manifest.bft_tables.find((t) => t.name === "student_experience")!;
    const plan = planTable(manifest, table, sm);

    assert.equal(plan.bftGrain.length, 2);
    assert.equal(plan.bftJoinChain.length, 1);

    const allMetrics = plan.grainGroups.flatMap((g) => g.metrics);

    const tuition = allMetrics.find((m) => m.name === "tuition_paid")!;
    assert.equal(tuition.behavior, "fully_allocated");

    const satisfaction = allMetrics.find((m) => m.name === "satisfaction_score")!;
    assert.equal(satisfaction.behavior, "sum_over_sum");

    const budget = allMetrics.find((m) => m.name === "class_budget")!;
    assert.equal(budget.behavior, "pure_elimination");
  });
});

describe("generator", () => {
  const manifest = loadManifest("data/university/manifest.yaml");

  it("generates SQL for all tables", () => {
    const output = generate(manifest, { dataDir: "data/university" });

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
    const output = generate(manifest, { dataDir: "data/university" });
    assert.ok(output.runScript.includes("#!/bin/bash"));
    assert.ok(output.runScript.includes("duckdb"));
  });
});

describe("generator DuckDB integration", () => {
  const manifest = loadManifest("data/university/manifest.yaml");
  const output = generate(manifest, { dataDir: "data/university" });

  const tmpDir = join(process.cwd(), ".tmp-test-codegen");

  // Write SQL to temp files and run through DuckDB via Python
  function runSQL(sqlParts: string[]): string {
    mkdirSync(tmpDir, { recursive: true });
    const sqlPath = join(tmpDir, "combined.sql");
    writeFileSync(sqlPath, sqlParts.join("\n\n"));

    const pyScript = join(tmpDir, "run.py");
    writeFileSync(pyScript, `
import duckdb, json
con = duckdb.connect()
sql = open("${sqlPath}").read()
results = []
for stmt in [s.strip() for s in sql.split(';') if s.strip()]:
    lines = [l for l in stmt.split('\\n') if l.strip() and not l.strip().startswith('--')]
    if not lines: continue
    result = con.execute(stmt)
    if lines[0].strip().split()[0].upper() == 'SELECT':
        cols = [d[0] for d in result.description]
        for row in result.fetchall():
            results.append(dict(zip(cols, [str(v) for v in row])))
print(json.dumps(results))
`);
    const out = execSync(`python3 ${pyScript}`, {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    rmSync(tmpDir, { recursive: true, force: true });
    return out;
  }

  it("all validations pass for department_financial", () => {
    const df = output.tables.find((t) => t.name === "department_financial")!;
    const raw = runSQL([output.loadDataSQL, df.sql]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    for (const r of results) {
      assert.ok(r.result.includes("PASS"), `${r.test}: ${r.result}`);
    }
    assert.ok(results.length >= 3, `Expected at least 3 validation checks, got ${results.length}`);
  });

  it("all validations pass for student_experience", () => {
    const se = output.tables.find((t) => t.name === "student_experience")!;
    const raw = runSQL([output.loadDataSQL, se.sql]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    for (const r of results) {
      assert.ok(r.result.includes("PASS"), `${r.test}: ${r.result}`);
    }
    assert.ok(results.length >= 3, `Expected at least 3 validation checks, got ${results.length}`);
  });

  it("department_financial has 218 rows", () => {
    const df = output.tables.find((t) => t.name === "department_financial")!;
    const raw = runSQL([
      output.loadDataSQL,
      df.sql,
      "SELECT CAST(COUNT(*) AS VARCHAR) AS cnt FROM department_financial",
    ]);
    const results = JSON.parse(raw) as Record<string, string>[];
    const countResult = results.find((r) => r.cnt !== undefined);
    assert.equal(countResult?.cnt, "218");
  });

  it("student_experience has 100 rows", () => {
    const se = output.tables.find((t) => t.name === "student_experience")!;
    const raw = runSQL([
      output.loadDataSQL,
      se.sql,
      "SELECT CAST(COUNT(*) AS VARCHAR) AS cnt FROM student_experience",
    ]);
    const results = JSON.parse(raw) as Record<string, string>[];
    const countResult = results.find((r) => r.cnt !== undefined);
    assert.equal(countResult?.cnt, "100");
  });
});
