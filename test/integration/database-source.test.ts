/**
 * Database-backed source integration: prepare a temporary DuckDB from the
 * existing CSV fixture, then run generated SQL against that database without
 * emitting or executing a CSV loader.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../../src/manifest/yaml.js";
import { generate } from "../../src/codegen/generator.js";
import { emitFiles } from "../../src/codegen/emit.js";

function runPython(script: string, args: string[]): string {
  return execFileSync("python3", ["-c", script, ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("database-backed source execution", () => {
  it("materializes, validates, and counts tables in an existing DuckDB", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bft-maker-db-execution-"));
    const databasePath = join(tempDir, "source with spaces.duckdb");
    const sqlDir = join(tempDir, "generated sql");
    const loadSqlPath = join(tempDir, "load.sql");

    try {
      const manifest = loadManifest("data/university/manifest.yaml");
      const csvOutput = generate(manifest, { dataDir: "data/university" });
      writeFileSync(loadSqlPath, csvOutput.loadDataSQL);
      runPython(
        "import duckdb,sys; con=duckdb.connect(sys.argv[1]); con.execute(open(sys.argv[2]).read()); con.close()",
        [databasePath, loadSqlPath],
      );

      const databaseOutput = generate(manifest, { source: "database" });
      const written = emitFiles(databaseOutput, sqlDir);
      assert.equal(written.length, databaseOutput.tables.length + 1);

      const stdout = execFileSync("bash", [join(sqlDir, "run.sh"), databasePath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      assert.match(stdout, /Materialized department_financial: 218 rows/);
      assert.match(stdout, /Materialized student_experience: 100 rows/);
      assert.match(stdout, /Materialized class_summary: 13 rows/);
      assert.match(stdout, /All validations passed\./);

      const counts = runPython(
        [
          "import duckdb,json,sys",
          "con=duckdb.connect(sys.argv[1], read_only=True)",
          "names=['students','department_financial','student_experience','class_summary']",
          "print(json.dumps({name: con.execute('SELECT COUNT(*) FROM \"' + name + '\"').fetchone()[0] for name in names}))",
          "con.close()",
        ].join(";"),
        [databasePath],
      );
      assert.deepEqual(JSON.parse(counts), {
        students: 30,
        department_financial: 218,
        student_experience: 100,
        class_summary: 13,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
