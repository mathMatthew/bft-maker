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

    // tuition_paid: allocation to Class and Professor, no reserve dims
    const tuition = allMetrics.find((m) => m.name === "tuition_paid")!;
    assert.equal(tuition.home.grain[0], "Student");
    assert.equal(tuition.reserveDimensions.length, 0);
    assert.ok(tuition.propagatedDimensions.every((d) => d.strategy === "allocation" || d.strategy === "reserve"));

    // class_budget: elimination to Student, reserve for Professor
    const budget = allMetrics.find((m) => m.name === "class_budget")!;
    assert.equal(budget.home.grain[0], "Class");
    assert.ok(budget.propagatedDimensions.some((d) => d.strategy === "elimination"));
    assert.ok(budget.reserveDimensions.length > 0);

    // salary: no propagation (all foreign entities are reserve)
    const salary = allMetrics.find((m) => m.name === "salary")!;
    assert.equal(salary.home.grain[0], "Professor");
    assert.ok(salary.reserveDimensions.length > 0);
  });

  it("plans student_experience with correct strategies", () => {
    const table = manifest.bft_tables.find((t) => t.name === "student_experience")!;
    const plan = planTable(manifest, table, sm);

    assert.equal(plan.bftGrain.length, 2);
    assert.equal(plan.bftJoinChain.length, 1);

    const allMetrics = plan.grainGroups.flatMap((g) => g.metrics);

    const tuition = allMetrics.find((m) => m.name === "tuition_paid")!;
    assert.equal(tuition.reserveDimensions.length, 0);

    const satisfaction = allMetrics.find((m) => m.name === "satisfaction_score")!;
    assert.equal(satisfaction.nature, "non-additive");

    const budget = allMetrics.find((m) => m.name === "class_budget")!;
    assert.ok(budget.propagatedDimensions.some((d) => d.strategy === "elimination"));
    assert.equal(budget.reserveDimensions.length, 0);
  });

  it("plans class_summary with summarization and correct grain", () => {
    const table = manifest.bft_tables.find((t) => t.name === "class_summary")!;
    const plan = planTable(manifest, table, sm);

    assert.deepEqual(plan.bftGrain, ["Class", "Professor"]);
    assert.ok(plan.grainGroups.length > 0);
    assert.ok(
      plan.grainGroups.some((g) => g.needsSummarization),
      "Expected at least one grain group with needsSummarization=true"
    );

    const allMetrics = plan.grainGroups.flatMap((g) => g.metrics);

    // tuition_paid: home is Student, which is not in BFT grain → needs summarization
    const tuition = allMetrics.find((m) => m.name === "tuition_paid")!;
    assert.ok(tuition.summarizeOut.length > 0, "tuition_paid should summarize out Student");
    assert.ok(tuition.summarizeOut.includes("Student"));

    // enrollment_grade: home is junction [Student, Class], Student summarized out
    const grade = allMetrics.find((m) => m.name === "enrollment_grade")!;
    assert.ok(grade.summarizeOut.includes("Student"));
  });

  it("plans enrollment_grade junction metric at natural grain in student_experience", () => {
    const table = manifest.bft_tables.find((t) => t.name === "student_experience")!;
    const plan = planTable(manifest, table, sm);

    const allMetrics = plan.grainGroups.flatMap((g) => g.metrics);
    const grade = allMetrics.find((m) => m.name === "enrollment_grade")!;

    // enrollment_grade lives on the Enrollment junction (Student × Class)
    assert.deepEqual(grade.home.grain, ["Student", "Class"]);
    assert.equal(grade.home.kind, "relationship");
    assert.equal(grade.home.name, "Enrollment");

    // In student_experience (Student × Class), enrollment_grade is at its natural grain.
    // No propagation needed beyond the BFT grain — no allocation/elimination dims.
    const nonReserveDims = grade.propagatedDimensions.filter((d) => d.strategy !== "reserve");
    assert.equal(nonReserveDims.length, 0, "enrollment_grade should have no propagated (non-reserve) dims in student_experience");
    assert.equal(grade.reserveDimensions.length, 0, "enrollment_grade should have no reserve dims in student_experience");
  });
});

describe("generator", () => {
  const manifest = loadManifest("data/university/manifest.yaml");

  it("generates SQL for all tables", () => {
    const output = generate(manifest, { dataDir: "data/university" });

    assert.ok(output.loadDataSQL.includes('CREATE OR REPLACE TABLE "students"'));
    assert.ok(output.loadDataSQL.includes('CREATE OR REPLACE TABLE "enrollments"'));
    assert.equal(output.tables.length, 3);

    const df = output.tables.find((t) => t.name === "department_financial")!;
    assert.ok(df.sql.includes('CREATE OR REPLACE TABLE "df_base"'));
    assert.ok(df.sql.includes('CREATE OR REPLACE TABLE "df_weighted"'));
    assert.ok(df.sql.includes('CREATE OR REPLACE TABLE "department_financial"'));
    // Multi-hop allocation
    assert.ok(df.sql.includes("enrollment_count"));
    assert.ok(df.sql.includes("assignment_count"));
    // Reserve branch for salary
    assert.ok(df.sql.includes("Reserve placeholder rows for salary"));
    // Propagation + correction branches for class_budget
    assert.ok(df.sql.includes("class_budget propagation data rows"));
    assert.ok(df.sql.includes("class_budget elimination correction (hop 0)"));

    const se = output.tables.find((t) => t.name === "student_experience")!;
    assert.ok(se.sql.includes('CREATE OR REPLACE TABLE "se_base"'));
    assert.ok(se.sql.includes("class_budget elimination correction (hop 0)"));
    // Sum/Sum weight
    assert.ok(se.sql.includes("satisfaction_score_weight"));
    // Junction metric
    assert.ok(se.sql.includes("enrollment_grade"));

    const cs = output.tables.find((t) => t.name === "class_summary")!;
    assert.ok(cs.sql.includes('CREATE OR REPLACE TABLE "cs_base"'));
    // Summarization step
    assert.ok(cs.sql.includes("Summarize to BFT grain"));
    assert.ok(cs.sql.includes('CREATE OR REPLACE TABLE "cs_summarized"'));
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
    try {
      const out = execSync(`python3 ${pyScript}`, {
        encoding: "utf-8",
        cwd: process.cwd(),
      });
      return out;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("all validations pass for class_summary", () => {
    const cs = output.tables.find((t) => t.name === "class_summary")!;
    const raw = runSQL([output.loadDataSQL, cs.sql]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    for (const r of results) {
      assert.ok(r.result.includes("PASS"), `${r.test}: ${r.result}`);
    }
    assert.ok(results.length >= 2, `Expected at least 2 validation checks, got ${results.length}`);
  });

  it("class_summary has correct row count", () => {
    const cs = output.tables.find((t) => t.name === "class_summary")!;
    const raw = runSQL([
      output.loadDataSQL,
      cs.sql,
      "SELECT CAST(COUNT(*) AS VARCHAR) AS cnt FROM class_summary",
    ]);
    const results = JSON.parse(raw) as Record<string, string>[];
    const countResult = results.find((r) => r.cnt !== undefined);
    // Class × Professor via Assignment = 13 rows
    assert.equal(countResult?.cnt, "13");
  });

  it("student_experience enrollment_grade SUM matches source junction table", () => {
    const se = output.tables.find((t) => t.name === "student_experience")!;
    const raw = runSQL([
      output.loadDataSQL,
      se.sql,
      `SELECT 'grade_sum' AS test,
              CASE WHEN ABS(SUM(enrollment_grade) - (SELECT SUM(enrollment_grade) FROM enrollments)) < 0.01
                   THEN 'PASS' ELSE 'FAIL: bft=' || SUM(enrollment_grade) || ' src=' || (SELECT SUM(enrollment_grade) FROM enrollments) END AS result
       FROM student_experience`,
    ]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    const gradeResult = results.find((r) => r.test === "grade_sum");
    assert.ok(gradeResult?.result.includes("PASS"), `grade sum: ${gradeResult?.result}`);
  });

  it("class_summary enrollment_grade SUM matches source junction table", () => {
    const cs = output.tables.find((t) => t.name === "class_summary")!;
    const raw = runSQL([
      output.loadDataSQL,
      cs.sql,
      `SELECT 'grade_sum' AS test,
              CASE WHEN ABS(SUM(enrollment_grade) - (SELECT SUM(enrollment_grade) FROM enrollments)) < 0.01
                   THEN 'PASS' ELSE 'FAIL: bft=' || SUM(enrollment_grade) || ' src=' || (SELECT SUM(enrollment_grade) FROM enrollments) END AS result
       FROM class_summary`,
    ]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    const gradeResult = results.find((r) => r.test === "grade_sum");
    assert.ok(gradeResult?.result.includes("PASS"), `grade sum: ${gradeResult?.result}`);
  });
});

describe("multi-hop elimination", () => {
  const manifest = loadManifest("data/university/manifest-multihop-elim.yaml");
  const output = generate(manifest, { dataDir: "data/university" });

  const tmpDir = join(process.cwd(), ".tmp-test-multihop");

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
    try {
      const out = execSync(`python3 ${pyScript}`, {
        encoding: "utf-8",
        cwd: process.cwd(),
      });
      return out;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("generates two elimination correction branches (one per hop)", () => {
    const pi = output.tables.find((t) => t.name === "professor_impact")!;
    assert.ok(pi.sql.includes("salary elimination correction (hop 0)"));
    assert.ok(pi.sql.includes("salary elimination correction (hop 1)"));
  });

  it("hop 0 correction anchors at Professor, hop 1 at Professor+Class", () => {
    const pi = output.tables.find((t) => t.name === "professor_impact")!;
    // Hop 0: GROUP BY professor columns + salary
    assert.ok(pi.sql.includes('GROUP BY "professor_id", "professor_name", "salary"'));
    // Hop 1: GROUP BY professor + class columns + salary
    assert.ok(pi.sql.includes('GROUP BY "professor_id", "professor_name", "class_id", "class_name", "salary"'));
  });

  it("SUM(salary) matches source professors table", () => {
    const pi = output.tables.find((t) => t.name === "professor_impact")!;
    const raw = runSQL([output.loadDataSQL, pi.sql]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    for (const r of results) {
      assert.ok(r.result.includes("PASS"), `${r.test}: ${r.result}`);
    }
  });
});

describe("elimination + allocation composition", () => {
  const manifest = loadManifest("data/university/manifest-elim-alloc.yaml");
  const output = generate(manifest, { dataDir: "data/university" });

  const tmpDir = join(process.cwd(), ".tmp-test-elim-alloc");

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
    try {
      const out = execSync(`python3 ${pyScript}`, {
        encoding: "utf-8",
        cwd: process.cwd(),
      });
      return out;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("generates elimination correction and allocation weight", () => {
    const t = output.tables.find((t) => t.name === "elim_alloc_test")!;
    // Elimination correction for hop 0 (Professor → Class)
    assert.ok(t.sql.includes("salary elimination correction (hop 0)"));
    // Allocation weight for hop 1 (Class → Student)
    assert.ok(t.sql.includes("enrollment_count"));
    // No hop 1 correction (allocation doesn't generate correction rows)
    assert.ok(!t.sql.includes("hop 1"));
  });

  it("allocation weight partitions by home + prior elimination hop", () => {
    const t = output.tables.find((t) => t.name === "elim_alloc_test")!;
    // Weight should partition by professor_id (home) + class_id (prior elim hop)
    assert.ok(t.sql.includes('PARTITION BY "professor_id", "class_id"'));
  });

  it("all validations pass — SUM(salary) matches source", () => {
    const t = output.tables.find((t) => t.name === "elim_alloc_test")!;
    const raw = runSQL([output.loadDataSQL, t.sql]);
    const results = JSON.parse(raw) as { test: string; result: string }[];
    for (const r of results) {
      assert.ok(r.result.includes("PASS"), `${r.test}: ${r.result}`);
    }
    assert.ok(results.length >= 2, `Expected at least 2 validation checks, got ${results.length}`);
  });
});
