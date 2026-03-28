/**
 * Numeric correctness tests for BFT strategy implementations.
 *
 * These tests go beyond "validation queries pass" — they verify that specific
 * values in the output tables are mathematically correct for each strategy:
 *   - Allocation: per-entity SUM invariant + spot check
 *   - Elimination: per-entity SUM invariant + correction row value
 *   - Sum/Sum: companion weights sum to 1.0 per home entity
 *   - Junction metric passthrough: value at natural grain is unchanged
 *   - Reserve: full value on reserve rows, zero on combination rows
 *   - Multi-hop allocation: SUM invariant survives two hops
 *
 * Data: data/university/manifest.yaml + CSV fixtures
 *
 * Key facts used in spot checks:
 *   Student 1 (Alice): tuition_paid=13000, enrolled in classes 4,10,5 (3 classes)
 *   Class 4 (English Comp): class_budget=49000, 9 students enrolled (IDs 1,2,3,4,5,8,10,19,23)
 *   Enrollment (student 1, class 4): enrollment_grade=92.5
 *   Professor 1 (Dr. Smith): salary=74000
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../../src/manifest/yaml.js";
import { generate } from "../../src/codegen/generator.js";

// ---------------------------------------------------------------------------
// DuckDB runner (same approach as integration/duckdb.test.ts)
// ---------------------------------------------------------------------------

function runSQL(label: string, sqlParts: string[]): Record<string, string>[] {
  const tmpDir = join(process.cwd(), `.tmp-correctness-${label}`);
  mkdirSync(tmpDir, { recursive: true });
  const sqlPath = join(tmpDir, "combined.sql");
  writeFileSync(sqlPath, sqlParts.join("\n\n"));

  const pyScript = join(tmpDir, "run.py");
  writeFileSync(
    pyScript,
    `
import duckdb, json, sys
con = duckdb.connect()
sql = open(sys.argv[1]).read()
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
`,
  );
  try {
    const out = execSync(`python3 ${JSON.stringify(pyScript)} ${JSON.stringify(sqlPath)}`, {
      encoding: "utf-8",
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(out) as Record<string, string>[];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertAllPass(results: Record<string, string>[]): void {
  const checks = results.filter((r) => r.test && r.result);
  assert.ok(checks.length >= 1, "Expected at least one test/result row");
  for (const row of checks) {
    assert.ok(row.result.startsWith("PASS"), `${row.test}: ${row.result}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const manifest = loadManifest("data/university/manifest.yaml");
const output = generate(manifest, { dataDir: "data/university" });
const seSQL = output.tables.find((t) => t.name === "student_experience")!.sql;
const dfSQL = output.tables.find((t) => t.name === "department_financial")!.sql;

// ---------------------------------------------------------------------------
// student_experience correctness
// ---------------------------------------------------------------------------

describe("correctness: student_experience", () => {
  it("allocation: per-student SUM of tuition_paid equals original", () => {
    const results = runSQL("se-alloc-sum", [
      output.loadDataSQL,
      seSQL,
      `SELECT 'allocation_per_student_sum' AS test,
              CASE WHEN COUNT(*) = 0 THEN 'PASS'
                   ELSE 'FAIL: ' || COUNT(*) || ' students with wrong tuition sum' END AS result
       FROM (
         SELECT se."student_id", SUM(se."tuition_paid") AS bft_sum, s."tuition_paid" AS original
         FROM "student_experience" se
         JOIN "students" s ON se."student_id" = s."student_id"
         GROUP BY se."student_id", s."tuition_paid"
         HAVING ABS(SUM(se."tuition_paid") - s."tuition_paid") > 0.01
       )`,
    ]);
    assertAllPass(results);
  });

  it("allocation: Alice (student 1) gets tuition_paid/3 per class (3 enrollments)", () => {
    const results = runSQL("se-alloc-spot", [
      output.loadDataSQL,
      seSQL,
      `SELECT 'allocation_spot_check' AS test,
              CASE WHEN ABS("tuition_paid" - 13000.0 / 3) < 0.01
                   THEN 'PASS' ELSE 'FAIL: ' || "tuition_paid" END AS result
       FROM "student_experience"
       WHERE "student_id" = 1 AND "class_id" = 4`,
    ]);
    assertAllPass(results);
  });

  it("elimination: per-class SUM of class_budget equals original", () => {
    const results = runSQL("se-elim-sum", [
      output.loadDataSQL,
      seSQL,
      `SELECT 'elimination_per_class_sum' AS test,
              CASE WHEN COUNT(*) = 0 THEN 'PASS'
                   ELSE 'FAIL: ' || COUNT(*) || ' classes with wrong budget sum' END AS result
       FROM (
         SELECT se."class_id", SUM(se."class_budget") AS bft_sum, c."class_budget" AS original
         FROM "student_experience" se
         JOIN "classes" c ON se."class_id" = c."class_id"
         GROUP BY se."class_id", c."class_budget"
         HAVING ABS(SUM(se."class_budget") - c."class_budget") > 0.01
       )`,
    ]);
    assertAllPass(results);
  });

  it("elimination: correction row for class 4 offsets 9-student fan-out", () => {
    // Class 4 has 9 enrolled students. Correction = 49000 * (1 - 9) = -392000.
    const results = runSQL("se-elim-correction", [
      output.loadDataSQL,
      seSQL,
      `SELECT 'elimination_correction_class4' AS test,
              CASE WHEN ABS("class_budget" - (49000.0 * (1 - 9))) < 0.01
                   THEN 'PASS' ELSE 'FAIL: ' || "class_budget" END AS result
       FROM "student_experience"
       WHERE "student_id" IS NULL AND "class_id" = 4`,
    ]);
    assertAllPass(results);
  });

  it("sum/sum: satisfaction_score_weight sums to 1.0 per student", () => {
    const results = runSQL("se-sos-weights", [
      output.loadDataSQL,
      seSQL,
      `SELECT 'sumoversum_weights_per_student' AS test,
              CASE WHEN COUNT(*) = 0 THEN 'PASS'
                   ELSE 'FAIL: ' || COUNT(*) || ' students with bad satisfaction weights' END AS result
       FROM (
         SELECT "student_id", ABS(SUM("satisfaction_score_weight") - 1.0) AS err
         FROM "student_experience"
         WHERE "student_id" IS NOT NULL
         GROUP BY "student_id"
         HAVING ABS(SUM("satisfaction_score_weight") - 1.0) > 0.001
       )`,
    ]);
    assertAllPass(results);
  });

  it("junction metric: enrollment_grade passes through at natural grain unchanged", () => {
    // enrollment (student 1, class 4) has grade 92.5 in the source CSV
    const results = runSQL("se-junction", [
      output.loadDataSQL,
      seSQL,
      `SELECT 'junction_metric_passthrough' AS test,
              CASE WHEN ABS("enrollment_grade" - 92.5) < 0.01
                   THEN 'PASS' ELSE 'FAIL: ' || "enrollment_grade" END AS result
       FROM "student_experience"
       WHERE "student_id" = 1 AND "class_id" = 4`,
    ]);
    assertAllPass(results);
  });
});

// ---------------------------------------------------------------------------
// department_financial correctness
// ---------------------------------------------------------------------------

describe("correctness: department_financial", () => {
  it("multi-hop allocation: per-student SUM of tuition_paid equals original", () => {
    const results = runSQL("df-alloc-sum", [
      output.loadDataSQL,
      dfSQL,
      `SELECT 'df_allocation_per_student_sum' AS test,
              CASE WHEN COUNT(*) = 0 THEN 'PASS'
                   ELSE 'FAIL: ' || COUNT(*) || ' students with wrong tuition sum' END AS result
       FROM (
         SELECT df."student_id", SUM(df."tuition_paid") AS bft_sum, s."tuition_paid" AS original
         FROM "department_financial" df
         JOIN "students" s ON df."student_id" = s."student_id"
         GROUP BY df."student_id", s."tuition_paid"
         HAVING ABS(SUM(df."tuition_paid") - s."tuition_paid") > 0.01
       )`,
    ]);
    assertAllPass(results);
  });

  it("reserve: each professor's salary appears correctly on their reserve row", () => {
    // Reserve rows have student_id IS NULL AND class_id IS NULL
    const results = runSQL("df-reserve-values", [
      output.loadDataSQL,
      dfSQL,
      `SELECT 'reserve_salary_values' AS test,
              CASE WHEN COUNT(*) = 0 THEN 'PASS'
                   ELSE 'FAIL: ' || COUNT(*) || ' professors with wrong reserve salary' END AS result
       FROM (
         SELECT df."professor_id", df."salary" AS bft_salary, p."salary" AS original
         FROM "department_financial" df
         JOIN "professors" p ON df."professor_id" = p."professor_id"
         WHERE df."student_id" IS NULL AND df."class_id" IS NULL
         AND ABS(df."salary" - p."salary") > 0.01
       )`,
    ]);
    assertAllPass(results);
  });

  it("reserve: salary is zero on all combination rows", () => {
    // Combination rows have real student_id and professor_id; salary must be 0 there
    const results = runSQL("df-reserve-zeros", [
      output.loadDataSQL,
      dfSQL,
      `SELECT 'reserve_salary_zero_on_combos' AS test,
              CASE WHEN COUNT(*) = 0 THEN 'PASS'
                   ELSE 'FAIL: ' || COUNT(*) || ' combination rows with non-zero salary' END AS result
       FROM "department_financial"
       WHERE "student_id" IS NOT NULL AND "professor_id" IS NOT NULL
         AND ABS("salary") > 0.001`,
    ]);
    assertAllPass(results);
  });
});
