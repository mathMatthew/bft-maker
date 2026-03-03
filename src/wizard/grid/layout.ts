import type { CellValue } from "../state.js";

/* ------------------------------------------------------------------ */
/*  Display labels                                                    */
/* ------------------------------------------------------------------ */

const CELL_LABELS: Record<string, string> = {
  home: "H",
  unreachable: "·",
  reserve: "Rsv",
  elimination: "Elim",
  allocation: "Alloc",
  sum_over_sum: "S/S",
};

export function cellLabel(value: CellValue): string {
  return CELL_LABELS[value] ?? value;
}

/* ------------------------------------------------------------------ */
/*  Column widths                                                     */
/* ------------------------------------------------------------------ */

/** Minimum column width — enough for the widest cell label. */
const MIN_COL_WIDTH = 5; // "Alloc" = 5 chars
const COL_PAD = 2;       // padding on each side

export interface ColumnLayout {
  /** Width of the metric name (row header) column. */
  headerWidth: number;
  /** Width of each entity column (index matches entityNames). */
  colWidths: number[];
  /** Total width of the grid including row headers. */
  totalWidth: number;
}

/**
 * Compute column widths from metric and entity names.
 * Each column is wide enough for the entity name header or the widest
 * cell label, plus padding.
 */
export function computeColumnLayout(
  metricNames: string[],
  entityNames: string[],
): ColumnLayout {
  const headerWidth = Math.max(
    7, // "Metric" label
    ...metricNames.map((n) => n.length),
  ) + COL_PAD;

  const maxLabel = Math.max(...Object.values(CELL_LABELS).map((l) => l.length));

  const colWidths = entityNames.map((name) =>
    Math.max(MIN_COL_WIDTH, name.length, maxLabel) + COL_PAD,
  );

  const totalWidth = headerWidth + colWidths.reduce((a, b) => a + b, 0);

  return { headerWidth, colWidths, totalWidth };
}

/* ------------------------------------------------------------------ */
/*  Viewport / scrolling                                              */
/* ------------------------------------------------------------------ */

export interface Viewport {
  /** First visible row index. */
  rowOffset: number;
  /** First visible column index. */
  colOffset: number;
  /** Number of visible rows (not counting header). */
  visibleRows: number;
  /** Number of visible columns (not counting row header). */
  visibleCols: number;
}

/**
 * Compute the viewport given terminal dimensions, grid dimensions,
 * and the current cursor position. The cursor is always visible.
 */
export function computeViewport(
  termRows: number,
  termCols: number,
  gridRows: number,
  gridCols: number,
  cursorRow: number,
  cursorCol: number,
  layout: ColumnLayout,
): Viewport {
  // Reserve lines: 1 for column header, 2 for top/bottom chrome
  const maxVisibleRows = Math.max(1, termRows - 3);
  const visibleRows = Math.min(maxVisibleRows, gridRows);

  // Compute how many entity columns fit in the remaining width
  const availWidth = termCols - layout.headerWidth;
  let visibleCols = 0;
  let usedWidth = 0;
  for (let i = 0; i < gridCols; i++) {
    // We'll calculate from offset 0 first, then adjust
    if (usedWidth + layout.colWidths[i] <= availWidth) {
      usedWidth += layout.colWidths[i];
      visibleCols++;
    } else {
      break;
    }
  }
  visibleCols = Math.max(1, visibleCols);

  // Scroll to keep cursor in view
  let rowOffset = 0;
  if (cursorRow >= visibleRows) {
    rowOffset = cursorRow - visibleRows + 1;
  }
  rowOffset = Math.min(rowOffset, Math.max(0, gridRows - visibleRows));

  let colOffset = 0;
  if (cursorCol >= visibleCols) {
    colOffset = cursorCol - visibleCols + 1;
  }
  // Recalculate visibleCols from the actual offset
  visibleCols = 0;
  usedWidth = 0;
  for (let i = colOffset; i < gridCols; i++) {
    if (usedWidth + layout.colWidths[i] <= availWidth) {
      usedWidth += layout.colWidths[i];
      visibleCols++;
    } else {
      break;
    }
  }
  visibleCols = Math.max(1, visibleCols);

  colOffset = Math.min(colOffset, Math.max(0, gridCols - visibleCols));

  return { rowOffset, colOffset, visibleRows, visibleCols };
}

/* ------------------------------------------------------------------ */
/*  Cursor movement                                                   */
/* ------------------------------------------------------------------ */

export interface CursorPos {
  row: number;
  col: number;
}

export function moveCursor(
  pos: CursorPos,
  direction: "up" | "down" | "left" | "right",
  gridRows: number,
  gridCols: number,
): CursorPos {
  switch (direction) {
    case "up":
      return { ...pos, row: Math.max(0, pos.row - 1) };
    case "down":
      return { ...pos, row: Math.min(gridRows - 1, pos.row + 1) };
    case "left":
      return { ...pos, col: Math.max(0, pos.col - 1) };
    case "right":
      return { ...pos, col: Math.min(gridCols - 1, pos.col + 1) };
  }
}

/* ------------------------------------------------------------------ */
/*  Padding helpers                                                   */
/* ------------------------------------------------------------------ */

export function padCenter(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

export function padRight(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}
