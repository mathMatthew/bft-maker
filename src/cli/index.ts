#!/usr/bin/env node

import * as path from "node:path";
import * as process from "node:process";
import { loadManifest, validate } from "../manifest/index.js";
import { generate, emitFiles } from "../codegen/index.js";

function usage(): never {
  console.error(`Usage:
  bft-maker generate --manifest <path> [--output <dir>]
  bft-maker validate --manifest <path>`);
  process.exit(1);
}

function parseArgs(argv: string[]): { command: string; manifest: string; output: string } {
  const args = argv.slice(2);
  const command = args[0];
  if (!command || !["generate", "validate"].includes(command)) {
    usage();
  }

  let manifest = "";
  let output = "./out";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) {
      manifest = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      usage();
    }
  }

  if (!manifest) {
    console.error("Error: --manifest is required");
    usage();
  }

  return { command, manifest, output };
}

function runValidate(manifestPath: string): void {
  const manifest = loadManifest(manifestPath);
  const errors = validate(manifest);

  if (errors.length === 0) {
    console.log("Manifest is valid.");
    return;
  }

  const warnings = errors.filter((e) => e.severity === "warning");
  const hard = errors.filter((e) => e.severity !== "warning");

  for (const w of warnings) {
    console.warn(`warning: ${w.message}`);
  }
  for (const e of hard) {
    console.error(`error: ${e.message}`);
  }

  if (hard.length > 0) {
    console.error(`\n${hard.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  } else {
    console.log(`Valid with ${warnings.length} warning(s).`);
  }
}

function runGenerate(manifestPath: string, outputDir: string): void {
  const manifest = loadManifest(manifestPath);
  const errors = validate(manifest);

  const hard = errors.filter((e) => e.severity !== "warning");
  if (hard.length > 0) {
    for (const e of hard) {
      console.error(`error: ${e.message}`);
    }
    console.error(`\nManifest has ${hard.length} error(s). Fix them before generating.`);
    process.exit(1);
  }

  const warnings = errors.filter((e) => e.severity === "warning");
  for (const w of warnings) {
    console.warn(`warning: ${w.message}`);
  }

  const dataDir = path.dirname(path.resolve(manifestPath));
  const result = generate(manifest, { dataDir });
  const written = emitFiles(result, outputDir);

  console.log(`Generated ${written.length} files in ${outputDir}/`);
  for (const f of written) {
    console.log(`  ${f}`);
  }
}

try {
  const { command, manifest, output } = parseArgs(process.argv);
  if (command === "validate") {
    runValidate(manifest);
  } else {
    runGenerate(manifest, output);
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
}
