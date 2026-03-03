import { describe, it, before, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import {
  createSession,
  killSession,
  sendKeys,
  sendText,
  waitForText,
  sleep,
  tmuxAvailable,
  type TmuxSession,
} from "./tmux-helpers.js";
import { parseManifest } from "../../src/manifest/yaml.js";
import { validate } from "../../src/manifest/validate.js";

const cliPath = path.resolve(process.cwd(), "dist/src/cli/index.js");
const testDbPath = `/tmp/bft-wizard-test-${process.pid}.duckdb`;

/* ------------------------------------------------------------------ */
/*  Test DB setup — runs in a child process to avoid file lock issues */
/* ------------------------------------------------------------------ */

function createTestDatabase(): void {
  try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(testDbPath + ".bft-draft.json"); } catch { /* ignore */ }

  // Create DB in a child process so the file lock is released when it exits
  const script = `
    const duckdb = require('duckdb');
    const db = new duckdb.Database('${testDbPath}', {}, (err) => {
      if (err) { console.error(err); process.exit(1); }
      const sql = [
        "CREATE TABLE products (product_id INTEGER, name VARCHAR, unit_price DOUBLE, units_sold INTEGER)",
        "INSERT INTO products VALUES (1,'Widget',9.99,100),(2,'Gadget',19.99,50),(3,'Doohickey',4.99,200)",
        "CREATE TABLE regions (region_id INTEGER, name VARCHAR, budget DOUBLE)",
        "INSERT INTO regions VALUES (1,'North',50000),(2,'South',30000)",
        "CREATE TABLE sales (product_id INTEGER, region_id INTEGER, quantity INTEGER)",
        "INSERT INTO sales VALUES (1,1,40),(1,2,60),(2,1,25),(2,2,25),(3,1,100),(3,2,100)",
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
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("wizard end-to-end (db-driven)", { skip: !tmuxAvailable() }, () => {
  let session: TmuxSession | null = null;

  before(() => {
    createTestDatabase();
  });

  afterEach(() => {
    if (session) {
      killSession(session);
      session = null;
    }
  });

  it("auto-detects model and produces valid YAML", async () => {
    const outputPath = `/tmp/bft-wizard-e2e-${process.pid}-${Date.now()}.yaml`;

    session = createSession(
      `node ${cliPath} wizard --db ${testDbPath} --output ${outputPath}`,
      { remainOnExit: true, cols: 120 },
    );

    // ── Step 1: Table selection (all selected by default) ─────

    await waitForText(session, "tables to include", 15000);
    sendKeys(session, "Enter");   // accept all tables

    // ── Review detected model ─────────────────────────────────
    // Auto-detection should find:
    //   entities: products, regions
    //   junction: sales (products ↔ regions)
    //   metrics: unit_price, units_sold on products; budget on regions

    await waitForText(session, "Looks good");
    sendKeys(session, "Enter");   // "Looks good, continue"

    // ── Metric nature questions ───────────────────────────────

    // unit_price: additive?
    await waitForText(session, "additive", 10000);
    sendKeys(session, "Enter");   // Yes

    // units_sold: additive?
    await waitForText(session, "additive");
    sendKeys(session, "Enter");   // Yes

    // budget: additive?
    await waitForText(session, "additive");
    sendKeys(session, "Enter");   // Yes

    // quantity (junction metric on sales): additive?
    await waitForText(session, "additive");
    sendKeys(session, "Enter");   // Yes

    // ── Hub: select Strategy matrix ─────────────────────────────

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Enter");

    // ── Step 2: Strategy matrix ───────────────────────────────

    await waitForText(session, "Strategy Matrix", 10000);
    await sleep(500);

    // Set all foreign cells to elimination
    // Grid: unit_price(H,Rsv), units_sold(H,Rsv), budget(Rsv,H), quantity(H,H)
    sendKeys(session, "Right");   // → unit_price × regions
    await sleep(300);
    sendKeys(session, "Space");   // → elimination
    await sleep(300);
    sendKeys(session, "Down");    // → units_sold × regions
    await sleep(300);
    sendKeys(session, "Space");   // → elimination
    await sleep(300);
    sendKeys(session, "Down");    // → budget × regions (home)
    await sleep(300);
    sendKeys(session, "Left");    // → budget × products
    await sleep(300);
    sendKeys(session, "Space");   // → elimination
    await sleep(300);
    sendKeys(session, "q");

    // ── Hub: select BFT tables ──────────────────────────────
    // Menu: Data model, Strategy matrix, Weights, BFT tables, Save & quit

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Down");    // → Weights
    sendKeys(session, "Down");    // → BFT tables
    sendKeys(session, "Enter");

    // ── Step 4: Tables ────────────────────────────────────────

    await waitForText(session, "Table name", 10000);
    sendText(session, "product_region");
    sendKeys(session, "Enter");

    await waitForText(session, "entities");
    sendKeys(session, "Space");   // products
    sendKeys(session, "Down");
    sendKeys(session, "Space");   // regions
    sendKeys(session, "Enter");

    await waitForText(session, "metrics");
    sendKeys(session, "Space");   // unit_price
    sendKeys(session, "Down");
    sendKeys(session, "Space");   // units_sold
    sendKeys(session, "Down");
    sendKeys(session, "Space");   // budget
    sendKeys(session, "Down");
    sendKeys(session, "Space");   // quantity (junction metric)
    sendKeys(session, "Enter");

    await waitForText(session, "Table name");
    sendKeys(session, "Enter");

    // ── Hub: select Generate manifest ────────────────────────
    // Menu: Data model, Strategy matrix, Weights, BFT tables, Generate manifest, Save & quit

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Down");    // → Weights
    sendKeys(session, "Down");    // → BFT tables
    sendKeys(session, "Down");    // → Generate manifest
    sendKeys(session, "Enter");

    // ── Verify output ─────────────────────────────────────────

    await waitForText(session, "Manifest written", 10000);

    const yaml = fs.readFileSync(outputPath, "utf-8");
    const manifest = parseManifest(yaml);
    const errors = validate(manifest);
    const hard = errors.filter((e) => e.severity !== "warning");
    assert.deepStrictEqual(hard, [], `No hard errors: ${JSON.stringify(hard)}`);

    assert.equal(manifest.entities.length, 2);
    assert.equal(manifest.relationships.length, 1);
    assert.equal(manifest.relationships[0].name, "sales");
    assert.equal(manifest.bft_tables.length, 1);

    fs.unlinkSync(outputPath);
    killSession(session);
    session = null;
  });

  it("handles allocation strategy with weight prompts", async () => {
    const outputPath = `/tmp/bft-wizard-alloc-${process.pid}-${Date.now()}.yaml`;

    session = createSession(
      `node ${cliPath} wizard --db ${testDbPath} --output ${outputPath}`,
      { remainOnExit: true, cols: 120 },
    );

    // ── Step 1: Accept all tables, edit model ────────────────

    await waitForText(session, "tables to include", 15000);
    sendKeys(session, "Enter");   // all tables

    // Edit model: remove units_sold metric via table detail view
    await waitForText(session, "Looks good");
    sendKeys(session, "Down");    // → "Edit table details"
    sendKeys(session, "Enter");

    // Pick products table (first in list)
    await waitForText(session, "Which table");
    sendKeys(session, "Enter");   // products

    // Change a column
    await waitForText(session, "Edit a column");
    sendKeys(session, "Down");    // → "Change a column"
    sendKeys(session, "Enter");

    // Pick units_sold (4th column: product_id, name, unit_price, units_sold)
    await waitForText(session, "Which column");
    sendKeys(session, "Down");    // → name
    sendKeys(session, "Down");    // → unit_price
    sendKeys(session, "Down");    // → units_sold
    sendKeys(session, "Enter");

    // Set to Attribute (first option)
    await waitForText(session, "New role");
    sendKeys(session, "Enter");   // → Attribute

    // Back to menu
    await waitForText(session, "Edit a column");
    sendKeys(session, "Enter");   // → "Back to menu"

    // Accept model
    await waitForText(session, "Looks good");
    sendKeys(session, "Enter");   // "Looks good, continue"

    // ── Metric nature: unit_price, budget, and quantity (junction) ──

    await waitForText(session, "additive", 10000);
    sendKeys(session, "Enter");   // unit_price: Yes

    await waitForText(session, "additive");
    sendKeys(session, "Enter");   // budget: Yes

    await waitForText(session, "additive");
    sendKeys(session, "Enter");   // quantity (junction): Yes

    // ── Hub: select Strategy matrix ─────────────────────────────

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Enter");

    // ── Step 2: Grid ──────────────────────────────────────────

    await waitForText(session, "Strategy Matrix", 10000);
    await sleep(500);

    // Grid: unit_price(H,Rsv), budget(Rsv,H), quantity(H,H)
    // Set unit_price×regions to allocation
    sendKeys(session, "Right");
    await sleep(300);
    sendKeys(session, "Space");   // → elimination
    await sleep(300);
    sendKeys(session, "Space");   // → allocation
    await sleep(300);
    sendKeys(session, "q");

    // ── Hub: select Weights ─────────────────────────────────
    // Menu: Data model, Strategy matrix, Weights, BFT tables, Save & quit

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Down");    // → Weights
    sendKeys(session, "Enter");

    // ── Step 3: Weights ───────────────────────────────────────

    await waitForText(session, "Weight column", 10000);
    sendText(session, "quantity");
    sendKeys(session, "Enter");

    // ── Hub: select BFT tables ──────────────────────────────

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Down");    // → Weights
    sendKeys(session, "Down");    // → BFT tables
    sendKeys(session, "Enter");

    // ── Step 4: Tables ────────────────────────────────────────

    await waitForText(session, "Table name", 10000);
    sendText(session, "sales_analysis");
    sendKeys(session, "Enter");

    await waitForText(session, "entities");
    sendKeys(session, "Space");
    sendKeys(session, "Down");
    sendKeys(session, "Space");
    sendKeys(session, "Enter");

    await waitForText(session, "metrics");
    sendKeys(session, "Space");   // unit_price
    sendKeys(session, "Down");
    sendKeys(session, "Space");   // budget
    sendKeys(session, "Enter");

    await waitForText(session, "Table name");
    sendKeys(session, "Enter");

    // ── Hub: select Generate manifest ────────────────────────

    await waitForText(session, "What next", 10000);
    sendKeys(session, "Down");    // → Strategy matrix
    sendKeys(session, "Down");    // → Weights
    sendKeys(session, "Down");    // → BFT tables
    sendKeys(session, "Down");    // → Generate manifest
    sendKeys(session, "Enter");

    // ── Verify ────────────────────────────────────────────────

    await waitForText(session, "Manifest written", 10000);

    const yaml = fs.readFileSync(outputPath, "utf-8");
    const manifest = parseManifest(yaml);
    const errors = validate(manifest);
    const hard = errors.filter((e) => e.severity !== "warning");
    assert.deepStrictEqual(hard, [], `No hard errors: ${JSON.stringify(hard)}`);

    // Verify allocation
    const allocProp = manifest.propagations.find(
      (p) => p.path.some((e) => e.strategy === "allocation"),
    );
    assert.ok(allocProp, "Should have an allocation propagation");
    assert.equal(allocProp!.path[0].weight, "quantity");

    fs.unlinkSync(outputPath);
    killSession(session);
    session = null;
  });
});
