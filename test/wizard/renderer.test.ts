import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";
import { renderGrid, type GridRenderState } from "../../src/wizard/grid/renderer.js";
import { initGrid } from "../../src/wizard/state.js";
import type { Entity, Relationship } from "../../src/manifest/types.js";

/* ------------------------------------------------------------------ */
/*  String capture stream                                             */
/* ------------------------------------------------------------------ */

class StringWritable extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get output(): string {
    return this.chunks.join("");
  }

  /** Strip ANSI escape codes for text-based assertions. */
  get plainText(): string {
    // eslint-disable-next-line no-control-regex
    return this.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  }
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

function twoEntitySetup(): { entities: Entity[]; relationships: Relationship[] } {
  return {
    entities: [
      {
        name: "Product",
        role: "leaf",
        detail: true,
        estimated_rows: 100,
        metrics: [{ name: "revenue", type: "currency", nature: "additive" }],
      },
      {
        name: "Region",
        role: "leaf",
        detail: true,
        estimated_rows: 10,
        metrics: [{ name: "budget", type: "currency", nature: "additive" }],
      },
    ],
    relationships: [
      {
        name: "Sales",
        between: ["Product", "Region"],
        type: "many-to-many",
        estimated_links: 500,
      },
    ],
  };
}

function makeRenderState(
  entities: Entity[],
  relationships: Relationship[],
  cursor = { row: 0, col: 0 },
): { state: GridRenderState; stream: StringWritable } {
  const { grid, metricNames, entityNames } = initGrid(entities, relationships);
  const stream = new StringWritable();
  const state: GridRenderState = {
    grid,
    metricNames,
    entityNames,
    cursor,
    termRows: 24,
    termCols: 80,
  };
  return { state, stream };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("renderGrid", () => {
  it("writes output to the stream", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);

    assert.ok(stream.output.length > 0);
  });

  it("includes entity names in column headers", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("Product"));
    assert.ok(text.includes("Region"));
  });

  it("includes metric names in row headers", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("revenue"));
    assert.ok(text.includes("budget"));
  });

  it("shows H for home cells", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("H"));
  });

  it("shows Rsv for reserve cells", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("Rsv"));
  });

  it("shows title and controls hint", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("Strategy Matrix"));
    assert.ok(text.includes("arrows"));
  });

  it("shows status bar with cell description", () => {
    const { entities, relationships } = twoEntitySetup();
    // Cursor on revenue × Product (home cell)
    const { state, stream } = makeRenderState(entities, relationships, { row: 0, col: 0 });

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("revenue"));
    assert.ok(text.includes("Product"));
    assert.ok(text.includes("home"));
  });

  it("shows legend", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    renderGrid(state, stream);
    const text = stream.plainText;

    assert.ok(text.includes("Reserve"));
    assert.ok(text.includes("Elim"));
    assert.ok(text.includes("Alloc"));
    assert.ok(text.includes("Sum/Sum"));
  });

  it("returns computed viewport", () => {
    const { entities, relationships } = twoEntitySetup();
    const { state, stream } = makeRenderState(entities, relationships);

    const viewport = renderGrid(state, stream);

    assert.equal(viewport.rowOffset, 0);
    assert.equal(viewport.colOffset, 0);
    assert.ok(viewport.visibleRows >= 2);
    assert.ok(viewport.visibleCols >= 2);
  });
});
