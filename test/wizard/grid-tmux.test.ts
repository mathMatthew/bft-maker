import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  createSession,
  killSession,
  sendKeys,
  capturePane,
  waitForText,
  sleep,
  tmuxAvailable,
  type TmuxSession,
} from "./tmux-helpers.js";

const harnessPath = path.resolve(process.cwd(), "dist/test/wizard/grid-harness.js");

describe("grid tmux integration", { skip: !tmuxAvailable() }, () => {
  let session: TmuxSession;

  async function launchGrid(): Promise<TmuxSession> {
    const s = createSession(`node ${harnessPath}`);
    await waitForText(s, "Strategy Matrix");
    return s;
  }

  after(() => {
    if (session) killSession(session);
  });

  it("renders the grid with entity columns and metric rows", async () => {
    session = await launchGrid();
    const content = capturePane(session);

    // Entity column headers
    assert.ok(content.includes("Student"), "Should show Student column");
    assert.ok(content.includes("Class"), "Should show Class column");
    assert.ok(content.includes("Professor"), "Should show Professor column");

    // Metric row headers
    assert.ok(content.includes("tuition_paid"), "Should show tuition_paid row");
    assert.ok(content.includes("class_budget"), "Should show class_budget row");
    assert.ok(content.includes("salary"), "Should show salary row");

    // Home cells
    assert.ok(content.includes("H"), "Should show H for home cells");

    // Default reserve cells
    assert.ok(content.includes("Rsv"), "Should show Rsv for reserve cells");

    killSession(session);
  });

  it("navigates with arrow keys", async () => {
    session = await launchGrid();

    // Initial cursor should be at (0,0) = tuition_paid × Student (home)
    let content = capturePane(session);
    assert.ok(content.includes("home entity"), "Status should say home");

    // Move right → tuition_paid × Class (reserve)
    sendKeys(session, "Right");
    await sleep(300);
    content = capturePane(session);
    assert.ok(content.includes("placeholder value"), "Status should describe reserve");

    // Move down → class_budget × Class (home)
    sendKeys(session, "Down");
    await sleep(300);
    content = capturePane(session);
    assert.ok(content.includes("class_budget"), "Status should mention class_budget");

    killSession(session);
  });

  it("cycles strategy with space key", async () => {
    session = await launchGrid();

    // Move to tuition_paid × Class (reserve cell)
    sendKeys(session, "Right");
    await sleep(300);

    // Cycle: reserve → elimination
    sendKeys(session, "Space");
    await sleep(300);
    let content = capturePane(session);
    assert.ok(content.includes("Elim"), "Should show Elim after first cycle");

    // Cycle: elimination → allocation
    sendKeys(session, "Space");
    await sleep(300);
    content = capturePane(session);
    assert.ok(content.includes("Alloc"), "Should show Alloc after second cycle");

    // Cycle: allocation → sum_over_sum
    sendKeys(session, "Space");
    await sleep(300);
    content = capturePane(session);
    assert.ok(content.includes("S/S"), "Should show S/S after third cycle");

    // Cycle: sum_over_sum → reserve (back to start)
    sendKeys(session, "Space");
    await sleep(300);
    content = capturePane(session);
    assert.ok(content.includes("Rsv"), "Should show Rsv after full cycle");

    killSession(session);
  });

  it("does not cycle home cells", async () => {
    session = await launchGrid();

    // Cursor starts on tuition_paid × Student (home)
    sendKeys(session, "Space");
    await sleep(300);
    const content = capturePane(session);
    // Should still show home
    assert.ok(content.includes("home entity"), "Home cell should not change");

    killSession(session);
  });

  it("vim keys work for navigation", async () => {
    session = await launchGrid();

    // l = right
    sendKeys(session, "l");
    await sleep(300);
    let content = capturePane(session);
    assert.ok(content.includes("placeholder value"), "l should move right to reserve cell");

    // j = down
    sendKeys(session, "j");
    await sleep(300);

    // h = left
    sendKeys(session, "h");
    await sleep(300);

    // k = up
    sendKeys(session, "k");
    await sleep(300);
    content = capturePane(session);
    // Should be back at (0,0) — tuition_paid × Student
    assert.ok(content.includes("home entity"), "Should be back at home after h,k");

    killSession(session);
  });

  it("q exits the grid and outputs result", async () => {
    session = await launchGrid();

    // Set tuition_paid × Class to elimination before quitting
    sendKeys(session, "Right");
    await sleep(300);
    sendKeys(session, "Space"); // → elimination
    await sleep(300);

    // Quit
    sendKeys(session, "q");
    await sleep(500);

    const content = capturePane(session);
    assert.ok(
      content.includes("__GRID_RESULT__"),
      "Should output grid result JSON after quit",
    );

    // The JSON may wrap across multiple lines in the 80-col tmux pane.
    // Extract everything after __GRID_RESULT__ and join lines.
    const marker = "__GRID_RESULT__";
    const afterMarker = content.slice(content.indexOf(marker) + marker.length);
    const jsonStr = afterMarker.split("\n").map((l) => l.trim()).join("");

    const result = JSON.parse(jsonStr);
    // Row 0 (tuition_paid), Col 1 (Class) should be elimination
    assert.equal(result[0][1].value, "elimination");

    killSession(session);
  });

  it("shows legend with strategy descriptions", async () => {
    session = await launchGrid();
    const content = capturePane(session);

    assert.ok(content.includes("Reserve"), "Legend should include Reserve");
    assert.ok(content.includes("Elim"), "Legend should include Elim");
    assert.ok(content.includes("Alloc"), "Legend should include Alloc");
    assert.ok(content.includes("Sum/Sum"), "Legend should include Sum/Sum");

    killSession(session);
  });
});
