import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  cellLabel,
  computeColumnLayout,
  computeViewport,
  moveCursor,
  padCenter,
  padRight,
} from "../../src/wizard/grid/layout.js";

/* ------------------------------------------------------------------ */
/*  Cell labels                                                       */
/* ------------------------------------------------------------------ */

describe("cellLabel", () => {
  it("returns correct labels for each cell value", () => {
    assert.equal(cellLabel("home"), "H");
    assert.equal(cellLabel("unreachable"), "·");
    assert.equal(cellLabel("reserve"), "Rsv");
    assert.equal(cellLabel("elimination"), "Elim");
    assert.equal(cellLabel("allocation"), "Alloc");
    assert.equal(cellLabel("sum_over_sum"), "S/S");
  });
});

/* ------------------------------------------------------------------ */
/*  Column layout                                                     */
/* ------------------------------------------------------------------ */

describe("computeColumnLayout", () => {
  it("header width accommodates longest metric name", () => {
    const layout = computeColumnLayout(
      ["short", "very_long_metric_name"],
      ["A", "B"],
    );
    // "very_long_metric_name" is 21 chars + 2 pad = 23
    assert.equal(layout.headerWidth, 23);
  });

  it("header width has minimum of 7 + padding", () => {
    const layout = computeColumnLayout(["m"], ["A"]);
    assert.equal(layout.headerWidth, 9); // 7 + 2 pad
  });

  it("entity columns are wide enough for names", () => {
    const layout = computeColumnLayout(
      ["m"],
      ["ShortEntity", "VeryLongEntityName"],
    );
    // "VeryLongEntityName" is 18 chars + 2 pad = 20
    assert.equal(layout.colWidths[1], 20);
  });

  it("entity columns have minimum width for labels", () => {
    const layout = computeColumnLayout(["m"], ["A"]);
    // MIN_COL_WIDTH = 5, + 2 pad = 7
    assert.equal(layout.colWidths[0], 7);
  });

  it("totalWidth sums header and all columns", () => {
    const layout = computeColumnLayout(["metric"], ["E1", "E2"]);
    assert.equal(layout.totalWidth, layout.headerWidth + layout.colWidths[0] + layout.colWidths[1]);
  });
});

/* ------------------------------------------------------------------ */
/*  Viewport / scrolling                                              */
/* ------------------------------------------------------------------ */

describe("computeViewport", () => {
  const layout = computeColumnLayout(["metric"], ["Entity1", "Entity2", "Entity3"]);

  it("shows all rows/cols when terminal is large enough", () => {
    const vp = computeViewport(50, 200, 3, 3, 0, 0, layout);
    assert.equal(vp.rowOffset, 0);
    assert.equal(vp.colOffset, 0);
    assert.equal(vp.visibleRows, 3);
    assert.equal(vp.visibleCols, 3);
  });

  it("scrolls rows to keep cursor visible", () => {
    const vp = computeViewport(5, 200, 10, 3, 8, 0, layout);
    // With termRows=5, visibleRows = max(1, 5-3) = 2
    // cursor at row 8 → rowOffset = 8-2+1 = 7
    assert.equal(vp.visibleRows, 2);
    assert.ok(vp.rowOffset <= 8);
    assert.ok(vp.rowOffset + vp.visibleRows > 8);
  });

  it("cursor at row 0 has no offset", () => {
    const vp = computeViewport(5, 200, 10, 3, 0, 0, layout);
    assert.equal(vp.rowOffset, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  Cursor movement                                                   */
/* ------------------------------------------------------------------ */

describe("moveCursor", () => {
  it("moves in all four directions", () => {
    const pos = { row: 2, col: 2 };
    assert.deepStrictEqual(moveCursor(pos, "up", 5, 5), { row: 1, col: 2 });
    assert.deepStrictEqual(moveCursor(pos, "down", 5, 5), { row: 3, col: 2 });
    assert.deepStrictEqual(moveCursor(pos, "left", 5, 5), { row: 2, col: 1 });
    assert.deepStrictEqual(moveCursor(pos, "right", 5, 5), { row: 2, col: 3 });
  });

  it("clamps to grid boundaries", () => {
    assert.deepStrictEqual(moveCursor({ row: 0, col: 0 }, "up", 5, 5), { row: 0, col: 0 });
    assert.deepStrictEqual(moveCursor({ row: 0, col: 0 }, "left", 5, 5), { row: 0, col: 0 });
    assert.deepStrictEqual(moveCursor({ row: 4, col: 4 }, "down", 5, 5), { row: 4, col: 4 });
    assert.deepStrictEqual(moveCursor({ row: 4, col: 4 }, "right", 5, 5), { row: 4, col: 4 });
  });
});

/* ------------------------------------------------------------------ */
/*  Padding helpers                                                   */
/* ------------------------------------------------------------------ */

describe("padCenter", () => {
  it("centers text in given width", () => {
    assert.equal(padCenter("Hi", 6), "  Hi  ");
  });

  it("truncates if text exceeds width", () => {
    assert.equal(padCenter("Hello World", 5), "Hello");
  });

  it("handles odd padding", () => {
    const result = padCenter("Hi", 5);
    assert.equal(result.length, 5);
    assert.ok(result.includes("Hi"));
  });
});

describe("padRight", () => {
  it("pads with spaces on the right", () => {
    assert.equal(padRight("Hi", 6), "Hi    ");
  });

  it("truncates if text exceeds width", () => {
    assert.equal(padRight("Hello World", 5), "Hello");
  });
});
