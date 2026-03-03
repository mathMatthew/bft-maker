import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import {
  introspect,
  querySampleRows,
  queryDistinctValues,
  guessMetricNature,
} from "../../src/wizard/introspect.js";
import {
  saveDraft,
  loadDraft,
  deleteDraft,
  draftPath,
} from "../../src/wizard/draft.js";
import { createInitialState } from "../../src/wizard/state.js";

/* ------------------------------------------------------------------ */
/*  guessMetricNature                                                  */
/* ------------------------------------------------------------------ */

describe("guessMetricNature", () => {
  it("classifies additive names", () => {
    assert.equal(guessMetricNature("quantity"), "additive");
    assert.equal(guessMetricNature("total_amount"), "additive");
    assert.equal(guessMetricNature("revenue"), "additive");
    assert.equal(guessMetricNature("units_sold"), "additive");
    assert.equal(guessMetricNature("headcount"), "additive");
    assert.equal(guessMetricNature("cost"), "additive");
  });

  it("classifies non-additive names", () => {
    assert.equal(guessMetricNature("unit_price"), "non-additive"); // "unit" = per-unit
    assert.equal(guessMetricNature("unit_cost"), "non-additive");
    assert.equal(guessMetricNature("unitRevenue"), "non-additive");
    assert.equal(guessMetricNature("cost_per_unit"), "non-additive");
    assert.equal(guessMetricNature("revenue_per_student"), "non-additive");
    assert.equal(guessMetricNature("costPerUnit"), "non-additive");
    assert.equal(guessMetricNature("PricePerStudent"), "non-additive");
    assert.equal(guessMetricNature("average_score"), "non-additive");
    assert.equal(guessMetricNature("completion_rate"), "non-additive");
    assert.equal(guessMetricNature("pass_pct"), "non-additive");
    assert.equal(guessMetricNature("gpa"), "additive"); // ambiguous, defaults to additive
    assert.equal(guessMetricNature("rating"), "non-additive");
    assert.equal(guessMetricNature("grade"), "non-additive");
    // "units" (plural) is a count, not a per-unit modifier
    assert.equal(guessMetricNature("units_sold"), "additive");
    assert.equal(guessMetricNature("units_in_stock"), "additive");
  });

  it("defaults to additive for ambiguous names", () => {
    assert.equal(guessMetricNature("value"), "additive");
    assert.equal(guessMetricNature("amount"), "additive");
    assert.equal(guessMetricNature("x"), "additive");
  });
});

/* ------------------------------------------------------------------ */
/*  BigInt handling + introspection                                    */
/* ------------------------------------------------------------------ */

const testDbPath = `/tmp/bft-introspect-test-${process.pid}.duckdb`;

describe("introspect", () => {
  before(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }

    const script = `
      const duckdb = require('duckdb');
      const db = new duckdb.Database('${testDbPath}', {}, (err) => {
        if (err) { console.error(err); process.exit(1); }
        const sql = [
          "CREATE TABLE items (item_id INTEGER, name VARCHAR, price DOUBLE, big_count BIGINT, score_per_item DOUBLE)",
          "INSERT INTO items VALUES (1,'A',9.99,9999999999999,3.5),(2,'B',19.99,8888888888888,4.2)",
        ];
        let i = 0;
        function next() {
          if (i >= sql.length) { db.close(() => process.exit(0)); return; }
          db.run(sql[i++], (err) => { if (err) { console.error(err); process.exit(1); } next(); });
        }
        next();
      });
    `;

    execSync(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  });

  after(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath + ".bft-draft.json"); } catch { /* ignore */ }
  });

  it("coerces BigInt values to Number in sample rows", async () => {
    const model = await introspect(testDbPath);
    const items = model.tables.find((t) => t.name === "items")!;

    // big_count is BIGINT — should be coerced to Number
    const bigCountVal = items.sampleRows[0]["big_count"];
    assert.equal(typeof bigCountVal, "number", "BigInt should be coerced to number");
    assert.equal(bigCountVal, 9999999999999);
  });

  it("auto-classifies metric nature using name heuristics", async () => {
    const model = await introspect(testDbPath);

    const price = model.metrics.find((m) => m.column === "price");
    assert.ok(price, "price should be detected as metric");
    assert.equal(price!.nature, "additive");

    const bigCount = model.metrics.find((m) => m.column === "big_count");
    assert.ok(bigCount, "big_count should be detected as metric");
    assert.equal(bigCount!.nature, "additive");

    const scorePer = model.metrics.find((m) => m.column === "score_per_item");
    assert.ok(scorePer, "score_per_item should be detected as metric");
    assert.equal(scorePer!.nature, "non-additive");
  });

  it("querySampleRows handles BigInt columns", async () => {
    const rows = await querySampleRows(testDbPath, "items", 2);
    assert.equal(rows.length, 2);
    assert.equal(typeof rows[0]["big_count"], "number");
  });

  it("queryDistinctValues handles BigInt columns", async () => {
    const result = await queryDistinctValues(testDbPath, "items", ["big_count"], 5);
    const vals = result.get("big_count")!;
    assert.ok(vals.length > 0);
    assert.equal(typeof vals[0], "number");
  });
});

/* ------------------------------------------------------------------ */
/*  Draft round-trip with detected model                               */
/* ------------------------------------------------------------------ */

describe("draft round-trip", () => {
  before(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }

    const script = `
      const duckdb = require('duckdb');
      const db = new duckdb.Database('${testDbPath}', {}, (err) => {
        if (err) { console.error(err); process.exit(1); }
        const sql = [
          "CREATE TABLE items (item_id INTEGER, name VARCHAR, price DOUBLE, big_count BIGINT)",
          "INSERT INTO items VALUES (1,'A',9.99,9999999999999),(2,'B',19.99,8888888888888)",
        ];
        let i = 0;
        function next() {
          if (i >= sql.length) { db.close(() => process.exit(0)); return; }
          db.run(sql[i++], (err) => { if (err) { console.error(err); process.exit(1); } next(); });
        }
        next();
      });
    `;

    execSync(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  });

  after(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath + ".bft-draft.json"); } catch { /* ignore */ }
  });

  it("saves and loads draft with detected model (BigInt-safe)", async () => {
    const model = await introspect(testDbPath);
    const state = createInitialState();

    // This should NOT throw (BigInt values coerced to Number)
    saveDraft(testDbPath, state, "hub", model);

    const fp = draftPath(testDbPath);
    assert.ok(fs.existsSync(fp), "Draft file should exist");

    const loaded = loadDraft(testDbPath);
    assert.ok(loaded, "Draft should load");
    assert.ok(loaded!.detectedModel, "Should have detected model");

    const dm = loaded!.detectedModel!;
    assert.equal(dm.tables.length, model.tables.length);
    assert.equal(dm.entities.length, model.entities.length);
    assert.equal(dm.metrics.length, model.metrics.length);

    // Verify table references are re-linked (same objects in entities and tables)
    const itemsFromTables = dm.tables.find((t) => t.name === "items");
    const itemsFromEntities = dm.entities.find((t) => t.name === "items");
    assert.strictEqual(itemsFromTables, itemsFromEntities, "Should be same object reference");

    // Verify BigInt values survived round-trip
    const bigCountVal = dm.tables[0].sampleRows[0]["big_count"];
    assert.equal(typeof bigCountVal, "number");

    deleteDraft(testDbPath);
    assert.ok(!fs.existsSync(fp), "Draft should be deleted");
  });
});
