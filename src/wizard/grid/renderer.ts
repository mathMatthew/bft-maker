import type { Writable } from "node:stream";
import chalk from "chalk";
import ansiEscapes from "ansi-escapes";
import type { GridCell, CellValue } from "../state.js";
import {
  cellLabel,
  computeColumnLayout,
  computeViewport,
  padCenter,
  padRight,
  type ColumnLayout,
  type CursorPos,
  type Viewport,
} from "./layout.js";

/* ------------------------------------------------------------------ */
/*  Color scheme                                                      */
/* ------------------------------------------------------------------ */

function cellStyle(value: CellValue, isCursor: boolean): (s: string) => string {
  if (isCursor) {
    switch (value) {
      case "home":        return chalk.bgWhite.black;
      case "unreachable": return chalk.bgGray.dim;
      case "reserve":     return chalk.bgBlueBright.white.bold;
      case "elimination": return chalk.bgRedBright.white.bold;
      case "allocation":  return chalk.bgGreenBright.black.bold;
      case "sum_over_sum":return chalk.bgYellowBright.black.bold;
    }
  }
  switch (value) {
    case "home":        return chalk.white.dim;
    case "unreachable": return chalk.gray.dim;
    case "reserve":     return chalk.blue;
    case "elimination": return chalk.red;
    case "allocation":  return chalk.green;
    case "sum_over_sum":return chalk.yellow;
  }
}

/* ------------------------------------------------------------------ */
/*  Grid state for rendering                                          */
/* ------------------------------------------------------------------ */

export interface GridRenderState {
  grid: GridCell[][];
  metricNames: string[];
  entityNames: string[];
  cursor: CursorPos;
  termRows: number;
  termCols: number;
}

/* ------------------------------------------------------------------ */
/*  Renderer                                                          */
/* ------------------------------------------------------------------ */

/**
 * Render the strategy matrix grid to a writable stream.
 * Returns the computed viewport for use by the input handler.
 */
export function renderGrid(
  state: GridRenderState,
  out: Writable,
): Viewport {
  const { grid, metricNames, entityNames, cursor, termRows, termCols } = state;
  const layout = computeColumnLayout(metricNames, entityNames);
  const viewport = computeViewport(
    termRows,
    termCols,
    grid.length,
    entityNames.length,
    cursor.row,
    cursor.col,
    layout,
  );

  // Clear screen and move to top
  out.write(ansiEscapes.clearScreen);
  out.write(ansiEscapes.cursorTo(0, 0));

  // Title
  out.write(chalk.bold("Strategy Matrix"));
  out.write("\n");
  out.write(chalk.dim("  move: arrows/hjkl"));
  out.write(chalk.dim("  cycle: space/enter  done: q"));
  out.write("\n\n");

  // Column headers
  renderColumnHeaders(entityNames, layout, viewport, out);
  out.write("\n");

  // Grid rows
  for (let vi = 0; vi < viewport.visibleRows; vi++) {
    const ri = vi + viewport.rowOffset;
    if (ri >= grid.length) break;
    renderRow(ri, grid[ri], metricNames[ri], entityNames, layout, viewport, cursor, out);
  }

  // Status bar
  out.write("\n\n");
  renderStatusBar(grid, cursor, metricNames, entityNames, viewport, out);

  // Hide cursor
  out.write(ansiEscapes.cursorHide);

  return viewport;
}

/* ------------------------------------------------------------------ */
/*  Row header + column headers                                       */
/* ------------------------------------------------------------------ */

function renderColumnHeaders(
  entityNames: string[],
  layout: ColumnLayout,
  viewport: Viewport,
  out: Writable,
): void {
  let line = padRight("", layout.headerWidth);
  for (let vi = 0; vi < viewport.visibleCols; vi++) {
    const ci = vi + viewport.colOffset;
    if (ci >= entityNames.length) break;
    line += chalk.bold.underline(padCenter(entityNames[ci], layout.colWidths[ci]));
  }

  // Scroll indicators
  if (viewport.colOffset > 0) {
    line += chalk.dim(" ◄");
  }
  if (viewport.colOffset + viewport.visibleCols < entityNames.length) {
    line += chalk.dim(" ►");
  }

  out.write(line + "\n");
}

/* ------------------------------------------------------------------ */
/*  Grid row                                                          */
/* ------------------------------------------------------------------ */

function renderRow(
  rowIdx: number,
  row: GridCell[],
  metricName: string,
  entityNames: string[],
  layout: ColumnLayout,
  viewport: Viewport,
  cursor: CursorPos,
  out: Writable,
): void {
  const isCurrentRow = rowIdx === cursor.row;
  const rowHeader = isCurrentRow
    ? chalk.bold(padRight(metricName, layout.headerWidth))
    : padRight(metricName, layout.headerWidth);

  let line = rowHeader;

  for (let vi = 0; vi < viewport.visibleCols; vi++) {
    const ci = vi + viewport.colOffset;
    if (ci >= row.length) break;

    const cell = row[ci];
    const isCursor = rowIdx === cursor.row && ci === cursor.col;
    const label = cellLabel(cell.value);
    const styled = cellStyle(cell.value, isCursor);
    line += styled(padCenter(label, layout.colWidths[ci]));
  }

  // Row scroll indicator
  if (viewport.rowOffset > 0 && rowIdx === viewport.rowOffset) {
    line += chalk.dim(" ▲");
  }
  if (
    rowIdx === viewport.rowOffset + viewport.visibleRows - 1 &&
    viewport.rowOffset + viewport.visibleRows < row.length
  ) {
    line += chalk.dim(" ▼");
  }

  out.write(line + "\n");
}

/* ------------------------------------------------------------------ */
/*  Status bar                                                        */
/* ------------------------------------------------------------------ */

function renderStatusBar(
  grid: GridCell[][],
  cursor: CursorPos,
  metricNames: string[],
  entityNames: string[],
  _viewport: Viewport,
  out: Writable,
): void {
  const cell = grid[cursor.row]?.[cursor.col];
  if (!cell) return;

  const metric = metricNames[cursor.row];
  const entity = entityNames[cursor.col];

  let desc: string;
  switch (cell.value) {
    case "home":
      desc = `${metric} lives on ${entity} (home entity)`;
      break;
    case "unreachable":
      desc = `${entity} is not reachable from ${metric}'s home`;
      break;
    case "reserve":
      desc = `${metric} on ${entity} rows: show placeholder value`;
      break;
    case "elimination":
      desc = `${metric} on ${entity} rows: exclude from total`;
      break;
    case "allocation":
      desc = `${metric} on ${entity} rows: allocate by weight`;
      break;
    case "sum_over_sum":
      desc = `${metric} on ${entity} rows: weighted average (Σ/Σ)`;
      break;
  }

  out.write(chalk.dim(desc));

  // Strategy legend (two lines for narrow terminals)
  out.write("\n\n");
  out.write(
    chalk.dim("  ") +
    chalk.white.dim("H") + chalk.dim("=Home  ") +
    chalk.blue("Rsv") + chalk.dim("=Reserve  ") +
    chalk.red("Elim") + chalk.dim("=Elim"),
  );
  out.write("\n");
  out.write(
    chalk.dim("  ") +
    chalk.green("Alloc") + chalk.dim("=Alloc  ") +
    chalk.yellow("S/S") + chalk.dim("=Sum/Sum"),
  );
}

/**
 * Show the cursor again — call this when leaving the grid.
 */
export function showCursor(out: Writable): void {
  out.write(ansiEscapes.cursorShow);
}
