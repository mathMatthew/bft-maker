import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseKey } from "../../src/wizard/grid/input.js";

describe("parseKey", () => {
  it("parses arrow keys", () => {
    assert.deepStrictEqual(parseKey(Buffer.from("\x1b[A")), { type: "move", direction: "up" });
    assert.deepStrictEqual(parseKey(Buffer.from("\x1b[B")), { type: "move", direction: "down" });
    assert.deepStrictEqual(parseKey(Buffer.from("\x1b[C")), { type: "move", direction: "right" });
    assert.deepStrictEqual(parseKey(Buffer.from("\x1b[D")), { type: "move", direction: "left" });
  });

  it("parses vim keys", () => {
    assert.deepStrictEqual(parseKey(Buffer.from("k")), { type: "move", direction: "up" });
    assert.deepStrictEqual(parseKey(Buffer.from("j")), { type: "move", direction: "down" });
    assert.deepStrictEqual(parseKey(Buffer.from("l")), { type: "move", direction: "right" });
    assert.deepStrictEqual(parseKey(Buffer.from("h")), { type: "move", direction: "left" });
  });

  it("parses cycle keys", () => {
    assert.deepStrictEqual(parseKey(Buffer.from(" ")), { type: "cycle" });
    assert.deepStrictEqual(parseKey(Buffer.from("\r")), { type: "cycle" });
    assert.deepStrictEqual(parseKey(Buffer.from("\n")), { type: "cycle" });
  });

  it("parses quit keys", () => {
    assert.deepStrictEqual(parseKey(Buffer.from("q")), { type: "quit" });
    assert.deepStrictEqual(parseKey(Buffer.from("\x03")), { type: "quit" }); // Ctrl-C
  });

  it("returns unknown for other keys", () => {
    assert.deepStrictEqual(parseKey(Buffer.from("x")), { type: "unknown" });
    assert.deepStrictEqual(parseKey(Buffer.from("a")), { type: "unknown" });
  });
});
