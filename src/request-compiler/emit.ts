import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompiledRequest } from "./types.js";

export function emitCompiledRequest(compiled: CompiledRequest, outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });
  const materializationPath = join(outputDir, "materialization.sql");
  const countPath = join(outputDir, "count.sql");
  const metadataPath = join(outputDir, "metadata.json");
  writeFileSync(materializationPath, compiled.materializationSql + "\n", "utf8");
  writeFileSync(countPath, compiled.countSql + "\n", "utf8");
  writeFileSync(metadataPath, JSON.stringify(compiled.metadata, null, 2) + "\n", "utf8");
  return [materializationPath, countPath, metadataPath];
}
