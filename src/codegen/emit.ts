import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedOutput } from "./types.js";

/**
 * Write generated SQL to numbered files in the output directory.
 */
export function emitFiles(output: GeneratedOutput, outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });
  const written: string[] = [];

  // 00_load_data.sql
  const loadPath = join(outputDir, "00_load_data.sql");
  writeFileSync(loadPath, output.loadDataSQL);
  written.push(loadPath);

  // Per-table SQL files
  for (let i = 0; i < output.tables.length; i++) {
    const t = output.tables[i];
    const num = String(i + 1).padStart(2, "0");
    const filePath = join(outputDir, `${num}_${t.name}.sql`);
    writeFileSync(filePath, t.sql);
    written.push(filePath);
  }

  // run.sh
  const runPath = join(outputDir, "run.sh");
  writeFileSync(runPath, output.runScript);
  chmodSync(runPath, 0o755);
  written.push(runPath);

  return written;
}
