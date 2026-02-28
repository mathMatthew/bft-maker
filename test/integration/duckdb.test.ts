/**
 * Integration tests: generate SQL from each fixture manifest,
 * execute through DuckDB, and verify the embedded validation queries pass.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../../src/manifest/yaml.js";
import { generate } from "../../src/codegen/generator.js";

// ---------------------------------------------------------------------------
// DuckDB runner
// ---------------------------------------------------------------------------

function runSQL(label: string, sqlParts: string[]): Record<string, string>[] {
  const tmpDir = join(process.cwd(), `.tmp-integ-${label}`);
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
// Fixture definitions
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  manifestPath: string;
  dataDir: string;
}

const fixtures: Fixture[] = [
  {
    name: "university",
    manifestPath: "data/university/manifest.yaml",
    dataDir: "data/university",
  },
  {
    name: "university-multihop-elim",
    manifestPath: "data/university/manifest-multihop-elim.yaml",
    dataDir: "data/university",
  },
  {
    name: "university-elim-alloc",
    manifestPath: "data/university/manifest-elim-alloc.yaml",
    dataDir: "data/university",
  },
  {
    name: "northwind",
    manifestPath: "data/northwind/manifest.yaml",
    dataDir: "data/northwind",
  },
  {
    name: "single-entity",
    manifestPath: "data/single-entity/manifest.yaml",
    dataDir: "data/single-entity",
  },
  {
    name: "university-ops",
    manifestPath: "data/university-ops/manifest.yaml",
    dataDir: "data/university-ops",
  },
];

// MovieLens excluded from DuckDB integration: no standalone user table
// exists in the dataset (userId only appears in ratings.csv). The manifest
// validates correctly and exercises relationship metrics at scale.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const fixture of fixtures) {
  describe(`integration: ${fixture.name}`, () => {
    const manifest = loadManifest(fixture.manifestPath);
    const output = generate(manifest, { dataDir: fixture.dataDir });

    for (const table of output.tables) {
      it(`${table.name}: all validations pass`, () => {
        const results = runSQL(
          `${fixture.name}-${table.name}`,
          [output.loadDataSQL, table.sql]
        );
        const validations = results.filter((r) => r.test && r.result);
        for (const v of validations) {
          assert.ok(v.result.includes("PASS"), `${v.test}: ${v.result}`);
        }
        assert.ok(
          validations.length >= 1,
          `Expected at least 1 validation check for ${table.name}, got ${validations.length}`
        );
      });

      it(`${table.name}: row count > 0`, () => {
        const results = runSQL(
          `${fixture.name}-${table.name}-cnt`,
          [
            output.loadDataSQL,
            table.sql,
            `SELECT CAST(COUNT(*) AS VARCHAR) AS cnt FROM "${table.name}"`,
          ]
        );
        const countRow = results.find((r) => r.cnt !== undefined);
        assert.ok(countRow, "Expected a count result");
        const cnt = parseInt(countRow!.cnt, 10);
        assert.ok(cnt > 0, `Expected rows > 0, got ${cnt}`);
      });
    }
  });
}
