import type { Readable, Writable } from "node:stream";
import type { GridCell } from "../state.js";
import { cycleStrategy } from "../state.js";
import { moveCursor, type CursorPos } from "./layout.js";
import { renderGrid, showCursor, type GridRenderState } from "./renderer.js";

/* ------------------------------------------------------------------ */
/*  Key parsing                                                       */
/* ------------------------------------------------------------------ */

export type Action =
  | { type: "move"; direction: "up" | "down" | "left" | "right" }
  | { type: "cycle" }
  | { type: "quit" }
  | { type: "unknown" };

export function parseKey(data: Buffer): Action {
  const s = data.toString();

  // Escape sequences for arrow keys
  if (s === "\x1b[A" || s === "k") return { type: "move", direction: "up" };
  if (s === "\x1b[B" || s === "j") return { type: "move", direction: "down" };
  if (s === "\x1b[C" || s === "l") return { type: "move", direction: "right" };
  if (s === "\x1b[D" || s === "h") return { type: "move", direction: "left" };

  // Enter or space to cycle
  if (s === "\r" || s === "\n" || s === " ") return { type: "cycle" };

  // q or Ctrl-C to quit
  if (s === "q" || s === "\x03") return { type: "quit" };

  return { type: "unknown" };
}

/* ------------------------------------------------------------------ */
/*  Grid interaction loop                                             */
/* ------------------------------------------------------------------ */

export interface GridInputOptions {
  grid: GridCell[][];
  metricNames: string[];
  entityNames: string[];
  input: Readable;
  output: Writable;
  getTermSize: () => { rows: number; cols: number };
}

/**
 * Run the interactive grid loop. Returns the edited grid when the user
 * presses q or Ctrl-C.
 */
export function runGridLoop(opts: GridInputOptions): Promise<GridCell[][]> {
  const { grid, metricNames, entityNames, input, output, getTermSize } = opts;

  // Deep clone the grid so we don't mutate the caller's data
  const editGrid = grid.map((row) => row.map((cell) => ({ ...cell })));

  let cursor: CursorPos = { row: 0, col: 0 };

  return new Promise((resolve) => {
    // Enter raw mode if this is a TTY
    const tty = input as NodeJS.ReadStream;
    const wasRaw = tty.isRaw ?? false;
    if (typeof tty.setRawMode === "function") {
      tty.setRawMode(true);
    }

    function render(): void {
      const { rows, cols } = getTermSize();
      const state: GridRenderState = {
        grid: editGrid,
        metricNames,
        entityNames,
        cursor,
        termRows: rows,
        termCols: cols,
      };
      renderGrid(state, output);
    }

    function cleanup(): void {
      showCursor(output);
      if (typeof tty.setRawMode === "function") {
        tty.setRawMode(wasRaw);
      }
      input.removeListener("data", onData);
    }

    function onData(data: Buffer): void {
      const action = parseKey(data);

      switch (action.type) {
        case "move":
          cursor = moveCursor(
            cursor,
            action.direction,
            editGrid.length,
            entityNames.length,
          );
          render();
          break;

        case "cycle": {
          const cell = editGrid[cursor.row]?.[cursor.col];
          if (cell) {
            editGrid[cursor.row][cursor.col] = cycleStrategy(cell);
          }
          render();
          break;
        }

        case "quit":
          cleanup();
          resolve(editGrid);
          break;

        case "unknown":
          // Ignore unrecognized keys
          break;
      }
    }

    // Resume stdin — @clack/prompts' readline interface leaves it paused
    input.resume();
    input.on("data", onData);

    // Handle terminal resize
    if (typeof output === "object" && "on" in output) {
      (output as NodeJS.WriteStream).on?.("resize", () => render());
    }

    // Initial render
    render();
  });
}
