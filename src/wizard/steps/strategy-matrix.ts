import type { WizardState } from "../state.js";
import { initGrid } from "../state.js";
import { runGridLoop } from "../grid/input.js";

/* ------------------------------------------------------------------ */
/*  Step 2: Strategy matrix                                           */
/* ------------------------------------------------------------------ */

export interface StrategyMatrixOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export async function runStrategyMatrixStep(
  state: WizardState,
  opts?: StrategyMatrixOptions,
): Promise<boolean> {
  // Initialize the grid from the data model
  const { grid, metricNames, entityNames } = initGrid(
    state.entities,
    state.relationships,
  );

  // Check if there are any editable cells
  const hasEditable = grid.some((row) =>
    row.some((cell) => cell.value !== "home" && cell.value !== "unreachable"),
  );

  if (!hasEditable) {
    // Nothing to configure — all metrics are on their home entity
    // and nothing is reachable
    state.grid = grid;
    state.metricNames = metricNames;
    state.entityNames = entityNames;
    return true;
  }

  const input = (opts?.input ?? process.stdin) as NodeJS.ReadStream;
  const output = (opts?.output ?? process.stdout) as NodeJS.WriteStream;

  const editedGrid = await runGridLoop({
    grid,
    metricNames,
    entityNames,
    input,
    output,
    getTermSize: () => ({
      rows: (output as NodeJS.WriteStream).rows ?? 24,
      cols: (output as NodeJS.WriteStream).columns ?? 80,
    }),
  });

  state.grid = editedGrid;
  state.metricNames = metricNames;
  state.entityNames = entityNames;

  return true;
}
