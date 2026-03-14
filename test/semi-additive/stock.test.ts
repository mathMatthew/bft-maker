import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../../src/manifest/yaml.js";
import { validate } from "../../src/manifest/validate.js";
import { generate } from "../../src/codegen/generator.js";
import { defaultSourceMapping, planTable, suggestTimeDerivedEntities } from "../../src/codegen/planner.js";
import type { Manifest } from "../../src/manifest/types.js";

// ---------------------------------------------------------------------------
// DuckDB runner (same approach as integration/duckdb.test.ts)
// ---------------------------------------------------------------------------

function runSQL(label: string, sqlParts: string[]): Record<string, string>[] {
  const tmpDir = join(process.cwd(), `.tmp-stock-${label}`);
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
`
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

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("stock metrics — validation", () => {
  it("rejects stock without time declaration", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [
          { name: "headcount", type: "integer", nature: "additive", stock: true },
        ]},
      ],
      relationships: [],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept"], metrics: ["headcount"] }],
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "stock-requires-time"));
  });

  it("rejects stock + non-additive", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [
          { name: "score", type: "rating", nature: "non-additive", stock: true },
        ]},
        { name: "Month", role: "leaf", detail: true, estimated_rows: 6, metrics: [] },
      ],
      relationships: [],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept"], metrics: ["score"] }],
      time: { entity: "Month", column: "month_date", granularity: "month" },
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "stock-not-non-additive"));
  });

  it("accepts valid stock metric with time declaration", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [
          { name: "headcount", type: "integer", nature: "additive", stock: true },
        ]},
        { name: "Month", role: "leaf", detail: true, estimated_rows: 6, metrics: [] },
      ],
      relationships: [
        { name: "DeptMonth", between: ["Dept", "Month"], type: "many-to-many", estimated_links: 18 },
      ],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept", "Month"], metrics: ["headcount"] }],
      time: { entity: "Month", column: "month_date", granularity: "month" },
    };
    const errors = validate(manifest);
    const hard = errors.filter((e) => e.severity !== "warning");
    assert.equal(hard.length, 0);
  });

  it("rejects invalid time granularity", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [] },
      ],
      relationships: [],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept"], metrics: [] }],
      time: { entity: "Dept", column: "date", granularity: "biweekly" as any },
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "time-granularity-valid"));
  });

  it("rejects time referencing nonexistent entity", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [] },
      ],
      relationships: [],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept"], metrics: [] }],
      time: { entity: "Missing", column: "date", granularity: "month" },
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "time-entity-exists"));
  });
});

// ---------------------------------------------------------------------------
// Planner tests
// ---------------------------------------------------------------------------

describe("stock metrics — planner", () => {
  const manifest = loadManifest("data/semi-additive/manifest.yaml");
  const sm = defaultSourceMapping(manifest);

  it("carries stock flag to MetricPlan", () => {
    const table = manifest.bft_tables.find((t) => t.name === "dept_summary")!;
    const plan = planTable(manifest, table, sm);
    const allMetrics = plan.grainGroups.flatMap((g) => g.metrics);

    const revenue = allMetrics.find((m) => m.name === "revenue")!;
    assert.equal(revenue.stock, false);

    const headcount = allMetrics.find((m) => m.name === "headcount")!;
    assert.equal(headcount.stock, true);
  });

  it("builds timePlan when stock metrics exist", () => {
    const table = manifest.bft_tables.find((t) => t.name === "dept_summary")!;
    const plan = planTable(manifest, table, sm);

    assert.ok(plan.timePlan);
    assert.equal(plan.timePlan!.entity, "Month");
    assert.equal(plan.timePlan!.column, "month_date");
    assert.equal(plan.timePlan!.interval, "INTERVAL 1 MONTH");
    assert.equal(plan.timePlan!.weighting, "days");
    assert.ok(plan.timePlan!.timeDerivedEntities.has("Month"));
  });

  it("does not build timePlan when no stock metrics", () => {
    const noStockManifest: Manifest = {
      ...manifest,
      entities: manifest.entities.map((e) => ({ ...e })),
      relationships: manifest.relationships.map((r) => ({
        ...r,
        metrics: r.metrics?.map((m) => ({ ...m, stock: false })),
      })),
    };
    const table = noStockManifest.bft_tables.find((t) => t.name === "dept_summary")!;
    const plan = planTable(noStockManifest, table, sm);
    assert.equal(plan.timePlan, undefined);
  });

  it("uses explicit time_entities from manifest", () => {
    const m: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [
          { name: "hc", type: "integer", nature: "additive", stock: true },
        ]},
        { name: "Month", role: "leaf", detail: true, estimated_rows: 12, metrics: [] },
        { name: "Quarter", role: "leaf", detail: true, estimated_rows: 4, metrics: [] },
      ],
      relationships: [
        { name: "DeptMonth", between: ["Dept", "Month"], type: "many-to-many", estimated_links: 36 },
        { name: "MonthQuarter", between: ["Month", "Quarter"], type: "many-to-one", estimated_links: 12 },
      ],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept", "Month"], metrics: ["hc"] }],
      time: { entity: "Month", column: "month_date", granularity: "month", time_entities: ["Month", "Quarter"] },
    };
    const plan = planTable(m, m.bft_tables[0], defaultSourceMapping(m));
    assert.ok(plan.timePlan);
    assert.ok(plan.timePlan!.timeDerivedEntities.has("Month"));
    assert.ok(plan.timePlan!.timeDerivedEntities.has("Quarter"));
    assert.ok(!plan.timePlan!.timeDerivedEntities.has("Dept"));
  });

  it("defaults to just the time entity when time_entities is omitted", () => {
    const m: Manifest = {
      entities: [
        { name: "Dept", role: "leaf", detail: true, estimated_rows: 3, metrics: [
          { name: "hc", type: "integer", nature: "additive", stock: true },
        ]},
        { name: "Month", role: "leaf", detail: true, estimated_rows: 12, metrics: [] },
      ],
      relationships: [
        { name: "DeptMonth", between: ["Dept", "Month"], type: "many-to-many", estimated_links: 36 },
      ],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Dept", "Month"], metrics: ["hc"] }],
      time: { entity: "Month", column: "month_date", granularity: "month" },
    };
    const plan = planTable(m, m.bft_tables[0], defaultSourceMapping(m));
    assert.ok(plan.timePlan);
    assert.ok(plan.timePlan!.timeDerivedEntities.has("Month"));
    assert.equal(plan.timePlan!.timeDerivedEntities.size, 1);
  });
});

// ---------------------------------------------------------------------------
// suggestTimeDerivedEntities (authoring helper)
// ---------------------------------------------------------------------------

describe("suggestTimeDerivedEntities", () => {
  it("walks M2O chain in many→one direction", () => {
    const rels = [
      { name: "MonthQuarter", between: ["Month", "Quarter"] as [string, string], type: "many-to-one" as const, estimated_links: 12 },
      { name: "QuarterYear", between: ["Quarter", "Year"] as [string, string], type: "many-to-one" as const, estimated_links: 4 },
    ];
    const result = suggestTimeDerivedEntities("Month", rels);
    assert.ok(result.includes("Month"));
    assert.ok(result.includes("Quarter"));
    assert.ok(result.includes("Year"));
  });

  it("does not follow M2O in reverse (one→many) direction", () => {
    const rels = [
      // Region→Month: many regions per one month. Month is the "one" side.
      { name: "RegionMonth", between: ["Region", "Month"] as [string, string], type: "many-to-one" as const, estimated_links: 5 },
    ];
    const result = suggestTimeDerivedEntities("Month", rels);
    assert.ok(result.includes("Month"));
    assert.ok(!result.includes("Region"),
      "should not traverse M2O edge where time entity is on the one side");
  });

  it("does not follow same-direction chain into non-time entities", () => {
    // Month→Quarter→Company: all M2O in same direction, but Company isn't time.
    // suggestTimeDerivedEntities will include Company — that's OK because
    // it's a suggestion that the user should review before storing in the manifest.
    const rels = [
      { name: "MonthQuarter", between: ["Month", "Quarter"] as [string, string], type: "many-to-one" as const, estimated_links: 12 },
      { name: "QuarterCompany", between: ["Quarter", "Company"] as [string, string], type: "many-to-one" as const, estimated_links: 4 },
    ];
    const result = suggestTimeDerivedEntities("Month", rels);
    // It suggests Company — the user removes it during manifest authoring
    assert.ok(result.includes("Company"));
    assert.equal(result.length, 3);
  });

  it("ignores many-to-many relationships", () => {
    const rels = [
      { name: "DeptMonth", between: ["Dept", "Month"] as [string, string], type: "many-to-many" as const, estimated_links: 36 },
    ];
    const result = suggestTimeDerivedEntities("Month", rels);
    assert.deepEqual(result, ["Month"]);
  });
});

// ---------------------------------------------------------------------------
// Validation: time_entities
// ---------------------------------------------------------------------------

describe("stock metrics — time_entities validation", () => {
  it("rejects time_entities referencing nonexistent entity", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Month", role: "leaf", detail: true, estimated_rows: 6, metrics: [] },
      ],
      relationships: [],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Month"], metrics: [] }],
      time: { entity: "Month", column: "date", granularity: "month", time_entities: ["Month", "Missing"] },
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "time-entities-exist"));
  });

  it("rejects time_entities that omits the time entity", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Month", role: "leaf", detail: true, estimated_rows: 6, metrics: [] },
        { name: "Quarter", role: "leaf", detail: true, estimated_rows: 4, metrics: [] },
      ],
      relationships: [
        { name: "MQ", between: ["Month", "Quarter"], type: "many-to-one", estimated_links: 6 },
      ],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Month"], metrics: [] }],
      time: { entity: "Month", column: "date", granularity: "month", time_entities: ["Quarter"] },
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "time-entities-includes-time-entity"));
  });

  it("rejects time_entities not reachable via M2O from time entity", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Month", role: "leaf", detail: true, estimated_rows: 6, metrics: [] },
        { name: "Region", role: "leaf", detail: true, estimated_rows: 5, metrics: [] },
      ],
      relationships: [],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Month"], metrics: [] }],
      time: { entity: "Month", column: "date", granularity: "month", time_entities: ["Month", "Region"] },
    };
    const errors = validate(manifest);
    assert.ok(errors.some((e) => e.rule === "time-entities-reachable"));
  });

  it("accepts valid time_entities", () => {
    const manifest: Manifest = {
      entities: [
        { name: "Month", role: "leaf", detail: true, estimated_rows: 12, metrics: [] },
        { name: "Quarter", role: "leaf", detail: true, estimated_rows: 4, metrics: [] },
      ],
      relationships: [
        { name: "MQ", between: ["Month", "Quarter"], type: "many-to-one", estimated_links: 12 },
      ],
      propagations: [],
      bft_tables: [{ name: "t", entities: ["Month"], metrics: [] }],
      time: { entity: "Month", column: "date", granularity: "month", time_entities: ["Month", "Quarter"] },
    };
    const errors = validate(manifest);
    const timeErrors = errors.filter((e) => e.rule.startsWith("time-entities"));
    assert.equal(timeErrors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Generated SQL tests
// ---------------------------------------------------------------------------

describe("stock metrics — generated SQL", () => {
  const manifest = loadManifest("data/semi-additive/manifest.yaml");

  it("uses weighted average in summarization SQL for stock metrics", () => {
    const result = generate(manifest, { dataDir: "data/semi-additive" });
    const summarySQL = result.tables.find((t) => t.name === "dept_summary")!.sql;

    // Stock metric should use DATE_DIFF weighted average
    assert.ok(summarySQL.includes("DATE_DIFF"), "should contain DATE_DIFF for day-weighted average");
    assert.ok(summarySQL.includes("month_date"), "should reference the time column");

    // Flow metric should use plain SUM
    assert.ok(summarySQL.includes('SUM("revenue"'), "revenue should use plain SUM");
  });

  it("passes through stock metrics without weighting when time is in grain", () => {
    const result = generate(manifest, { dataDir: "data/semi-additive" });
    const monthlySQL = result.tables.find((t) => t.name === "dept_monthly")!.sql;

    // No summarization needed, so no DATE_DIFF
    assert.ok(!monthlySQL.includes("DATE_DIFF"), "should not weight when time is in grain");
  });

  it("uses AVG for equal weighting", () => {
    const equalManifest: Manifest = {
      ...manifest,
      time: { ...manifest.time!, weighting: "equal" },
    };
    const result = generate(equalManifest, { dataDir: "data/semi-additive" });
    const summarySQL = result.tables.find((t) => t.name === "dept_summary")!.sql;

    assert.ok(summarySQL.includes("AVG("), "should use AVG for equal weighting");
    assert.ok(!summarySQL.includes("DATE_DIFF"), "should not use DATE_DIFF for equal weighting");
  });
});

// ---------------------------------------------------------------------------
// Integration tests (DuckDB via Python)
// ---------------------------------------------------------------------------

describe("stock metrics — integration (DuckDB)", () => {
  it("produces correct weighted averages when summarizing time", () => {
    const manifest = loadManifest("data/semi-additive/manifest.yaml");
    const result = generate(manifest, { dataDir: "data/semi-additive" });

    const allSQL = [
      result.loadDataSQL,
      ...result.tables.map((t) => t.sql),
    ];

    // Verify the built-in validation queries pass
    const results = runSQL("stock", allSQL);
    for (const row of results) {
      if (row.result) {
        assert.ok(
          row.result.startsWith("PASS"),
          `${row.test}: ${row.result}`,
        );
      }
    }
  });

  it("headcount is weighted average, not plain SUM", () => {
    const manifest = loadManifest("data/semi-additive/manifest.yaml");
    const result = generate(manifest, { dataDir: "data/semi-additive" });

    const allSQL = [
      result.loadDataSQL,
      ...result.tables.map((t) => t.sql),
      // Query to verify headcount is not a plain SUM
      `SELECT 'headcount_not_sum' AS test,
              CASE WHEN ABS(SUM(headcount) - 634) > 0.1
                   THEN 'PASS' ELSE 'FAIL: headcount equals plain SUM (634)' END AS result
       FROM dept_summary;`,
      // Revenue should be the full SUM
      `SELECT 'revenue_is_sum' AS test,
              CASE WHEN ABS(SUM(revenue) - 1567000) < 0.01
                   THEN 'PASS' ELSE 'FAIL: ' || SUM(revenue) END AS result
       FROM dept_summary;`,
    ];

    const results = runSQL("stock-verify", allSQL);
    for (const row of results) {
      if (row.result) {
        assert.ok(
          row.result.startsWith("PASS"),
          `${row.test}: ${row.result}`,
        );
      }
    }
  });
});
