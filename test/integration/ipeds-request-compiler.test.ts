/**
 * Acceptance test for the first semantic-query request.
 *
 * The fixture is a resolved compiler request, not a legacy bft-maker manifest.
 * It runs against the accepted local IPEDS DuckDB build when that build is
 * present.  The independently written reference query remains the correctness
 * oracle until the semantic-query materializer switches to compiled SQL.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileRequest,
  loadRequestPlan,
} from "../../src/request-compiler/index.js";

const DATABASE = resolve(process.cwd(), "../semantic-query/data/ipeds.duckdb");
const PLAN_PATH = resolve(process.cwd(), "data/ipeds/request-plan.yaml");

const REFERENCE_SQL = String.raw`
WITH eligible AS (
    SELECT
        iy.unitid,
        iy.institution_name,
        g.label AS jurisdiction
    FROM institution_year iy
    JOIN geography g
      ON g.geography_id = iy.jurisdiction_geography_id
    WHERE iy.collection_year = 2022
      AND iy.control_code = '1'
      AND g.label = 'Colorado'
),
degrees AS (
    SELECT
        e.jurisdiction,
        e.unitid,
        e.institution_name,
        p2.cip_code AS cip_2_digit_code,
        p2.title AS cip_2_digit_title,
        sum(c.award_count)::BIGINT AS degrees_awarded
    FROM completion_observation c
    JOIN reporting_period period
      ON period.period_id = c.period_id
     AND period.period_type = 'completions'
     AND period.reporting_year = 2022
    JOIN eligible e ON e.unitid = c.unitid
    JOIN program p6 ON p6.program_id = c.program_id
    JOIN program p4 ON p4.program_id = p6.parent_program_id
    JOIN program p2 ON p2.program_id = p4.parent_program_id
    WHERE c.major_number = 1
    GROUP BY ALL
),
enrollment AS (
    SELECT e.unitid, sum(o.headcount)::BIGINT AS fall_enrollment
    FROM enrollment_observation o
    JOIN reporting_period period
      ON period.period_id = o.period_id
     AND period.period_type = 'fall'
     AND period.reporting_year = 2022
    JOIN eligible e ON e.unitid = o.unitid
    GROUP BY e.unitid
),
revenue AS (
    SELECT e.unitid, sum(o.amount)::BIGINT AS total_revenue
    FROM finance_observation o
    JOIN reporting_period period
      ON period.period_id = o.period_id
     AND period.period_type = 'fiscal'
     AND period.reporting_year = 2022
    JOIN eligible e ON e.unitid = o.unitid
    JOIN finance_source_variable source_variable
      ON source_variable.source_variable_id = o.source_variable_id
    JOIN finance_measure measure
      ON measure.finance_measure_id = source_variable.canonical_measure_id
     AND measure.canonical_name = 'total_revenue'
    GROUP BY e.unitid
),
reserve AS (
    SELECT
        e.jurisdiction,
        e.unitid,
        e.institution_name,
        '<Unallocated>'::VARCHAR AS cip_2_digit_code,
        '<Unallocated>'::VARCHAR AS cip_2_digit_title,
        NULL::BIGINT AS degrees_awarded,
        enrollment.fall_enrollment,
        revenue.total_revenue
    FROM eligible e
    LEFT JOIN enrollment USING (unitid)
    LEFT JOIN revenue USING (unitid)
    WHERE enrollment.fall_enrollment IS NOT NULL
       OR revenue.total_revenue IS NOT NULL
),
program_rows AS (
    SELECT
        jurisdiction,
        unitid,
        institution_name,
        cip_2_digit_code,
        cip_2_digit_title,
        degrees_awarded,
        NULL::BIGINT AS fall_enrollment,
        NULL::BIGINT AS total_revenue
    FROM degrees
)
SELECT
    2022::INTEGER AS reporting_year,
    jurisdiction,
    unitid,
    institution_name,
    cip_2_digit_code,
    cip_2_digit_title,
    degrees_awarded,
    fall_enrollment,
    total_revenue
FROM (
    SELECT * FROM program_rows
    UNION ALL
    SELECT * FROM reserve
)
`;

interface AcceptanceResult {
  compiledMinusReference: string;
  referenceMinusCompiled: string;
  countSql: string;
  schema: [string, string][];
  summary: Record<string, string>;
  directTotals: Record<string, string>;
}

function runAcceptance(materializationSql: string, countSql: string): AcceptanceResult {
  const directory = mkdtempSync(join(tmpdir(), "bft-ipeds-acceptance-"));
  const inputPath = join(directory, "input.json");
  const runnerPath = join(directory, "run.py");
  writeFileSync(
    inputPath,
    JSON.stringify({
      database: DATABASE,
      materializationSql,
      countSql,
      referenceSql: REFERENCE_SQL,
    }),
  );
  writeFileSync(
    runnerPath,
    String.raw`
import duckdb
import json
import sys

request = json.load(open(sys.argv[1], encoding="utf-8"))

def query(sql):
    result = connection.execute(sql)
    columns = [item[0] for item in result.description]
    row = result.fetchone()
    return {name: str(value) for name, value in zip(columns, row, strict=True)}

def scalar(sql):
    return str(connection.execute(sql).fetchone()[0])

def select_sql(sql):
    return sql.strip().removesuffix(";")

connection = duckdb.connect(request["database"], read_only=True)
connection.execute("CREATE TEMP VIEW compiled_result AS " + select_sql(request["materializationSql"]))
connection.execute("CREATE TEMP VIEW reference_result AS " + select_sql(request["referenceSql"]))

summary = query("""
SELECT
    count(*) AS row_count,
    count(*) FILTER (WHERE cip_2_digit_code = '<Unallocated>') AS reserve_rows,
    count(*) FILTER (WHERE cip_2_digit_code <> '<Unallocated>') AS program_rows,
    count(DISTINCT unitid) AS institutions,
    count(*) FILTER (
        WHERE cip_2_digit_code = '<Unallocated>' AND degrees_awarded IS NOT NULL
    ) AS reserve_degrees_nonnull,
    count(*) FILTER (
        WHERE cip_2_digit_code <> '<Unallocated>'
          AND (fall_enrollment IS NOT NULL OR total_revenue IS NOT NULL)
    ) AS program_reserve_metrics_nonnull,
    count(fall_enrollment) FILTER (
        WHERE cip_2_digit_code = '<Unallocated>'
    ) AS reserve_enrollment_nonnull,
    count(total_revenue) FILTER (
        WHERE cip_2_digit_code = '<Unallocated>'
    ) AS reserve_revenue_nonnull,
    coalesce(sum(degrees_awarded), 0) AS degrees_awarded,
    coalesce(sum(fall_enrollment), 0) AS fall_enrollment,
    coalesce(sum(total_revenue), 0) AS total_revenue,
    count(*) FILTER (WHERE reporting_year <> 2022) AS wrong_year,
    count(*) FILTER (WHERE jurisdiction <> 'Colorado') AS wrong_jurisdiction,
    (
        SELECT count(*)
        FROM (
            SELECT unitid, cip_2_digit_code
            FROM compiled_result
            GROUP BY ALL
            HAVING count(*) > 1
        ) duplicates
    ) AS duplicate_keys
FROM compiled_result
""")

direct_totals = query("""
WITH eligible AS (
    SELECT iy.unitid
    FROM institution_year iy
    JOIN geography g ON g.geography_id = iy.jurisdiction_geography_id
    WHERE iy.collection_year = 2022
      AND iy.control_code = '1'
      AND g.label = 'Colorado'
)
SELECT
    (
        SELECT sum(c.award_count)::BIGINT
        FROM completion_observation c
        JOIN reporting_period p ON p.period_id = c.period_id
        JOIN eligible e ON e.unitid = c.unitid
        WHERE p.period_type = 'completions'
          AND p.reporting_year = 2022
          AND c.major_number = 1
    ) AS degrees_awarded,
    (
        SELECT sum(o.headcount)::BIGINT
        FROM enrollment_observation o
        JOIN reporting_period p ON p.period_id = o.period_id
        JOIN eligible e ON e.unitid = o.unitid
        WHERE p.period_type = 'fall' AND p.reporting_year = 2022
    ) AS fall_enrollment,
    (
        SELECT sum(o.amount)::BIGINT
        FROM finance_observation o
        JOIN reporting_period p ON p.period_id = o.period_id
        JOIN eligible e ON e.unitid = o.unitid
        JOIN finance_source_variable v USING (source_variable_id)
        JOIN finance_measure m ON m.finance_measure_id = v.canonical_measure_id
        WHERE p.period_type = 'fiscal'
          AND p.reporting_year = 2022
          AND m.canonical_name = 'total_revenue'
    ) AS total_revenue
""")

output = {
    "compiledMinusReference": scalar(
        "SELECT count(*) FROM (SELECT * FROM compiled_result EXCEPT ALL SELECT * FROM reference_result)"
    ),
    "referenceMinusCompiled": scalar(
        "SELECT count(*) FROM (SELECT * FROM reference_result EXCEPT ALL SELECT * FROM compiled_result)"
    ),
    "countSql": scalar(request["countSql"]),
    "schema": [list(row[:2]) for row in connection.execute("DESCRIBE compiled_result").fetchall()],
    "summary": summary,
    "directTotals": direct_totals,
}
print(json.dumps(output))
`,
  );

  try {
    return JSON.parse(
      execFileSync("python3", [runnerPath, inputPath], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ) as AcceptanceResult;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe(
  "IPEDS request compiler acceptance",
  { skip: !existsSync(DATABASE) && `accepted database not present: ${DATABASE}` },
  () => {
    it("matches the accepted 530-row reference result and reconciled totals", () => {
      const compiled = compileRequest(loadRequestPlan(PLAN_PATH));
      const result = runAcceptance(compiled.materializationSql, compiled.countSql);

      assert.equal(result.compiledMinusReference, "0");
      assert.equal(result.referenceMinusCompiled, "0");
      assert.equal(result.countSql, "530");
      assert.deepEqual(result.schema, [
        ["reporting_year", "INTEGER"],
        ["jurisdiction", "VARCHAR"],
        ["unitid", "INTEGER"],
        ["institution_name", "VARCHAR"],
        ["cip_2_digit_code", "VARCHAR"],
        ["cip_2_digit_title", "VARCHAR"],
        ["degrees_awarded", "BIGINT"],
        ["fall_enrollment", "BIGINT"],
        ["total_revenue", "BIGINT"],
      ]);
      assert.deepEqual(result.summary, {
        row_count: "530",
        reserve_rows: "34",
        program_rows: "496",
        institutions: "34",
        reserve_degrees_nonnull: "0",
        program_reserve_metrics_nonnull: "0",
        reserve_enrollment_nonnull: "32",
        reserve_revenue_nonnull: "30",
        degrees_awarded: "66881",
        fall_enrollment: "279621",
        total_revenue: "9349362105",
        wrong_year: "0",
        wrong_jurisdiction: "0",
        duplicate_keys: "0",
      });
      assert.deepEqual(result.directTotals, {
        degrees_awarded: "66881",
        fall_enrollment: "279621",
        total_revenue: "9349362105",
      });
    });
  },
);
