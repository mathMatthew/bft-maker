#!/usr/bin/env node

import * as path from "node:path";
import * as process from "node:process";
import { loadManifest, validate } from "../manifest/index.js";
import { generate, emitFiles } from "../codegen/index.js";
import { compileRequest, emitCompiledRequest, loadRequestPlan } from "../request-compiler/index.js";
import { runWizard } from "../wizard/index.js";
import { introspect, type DetectedModel } from "../wizard/introspect.js";

function usage(): never {
  console.error(`Usage:
  bft-maker generate --manifest <path> [--source <csv|database>] [--output <dir>]
  bft-maker compile-request --plan <path> [--output <dir>]
  bft-maker validate --manifest <path>
  bft-maker introspect --db <duckdb-path>
  bft-maker wizard --db <duckdb-path> [--manifest <path>] [--output <path>]`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  command: string;
  manifest: string;
  output: string;
  db: string;
  plan: string;
  source: "csv" | "database";
} {
  const args = argv.slice(2);
  const command = args[0];
  if (!command || !["generate", "compile-request", "validate", "introspect", "wizard"].includes(command)) {
    usage();
  }

  let manifest = "";
  let output = "./out";
  let db = "";
  let plan = "";
  let source: "csv" | "database" = "csv";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) {
      manifest = args[++i];
    } else if (args[i] === "--plan" && args[i + 1]) {
      plan = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === "--db" && args[i + 1]) {
      db = args[++i];
    } else if (args[i] === "--source" && args[i + 1]) {
      const value = args[++i];
      if (value !== "csv" && value !== "database") {
        console.error(`Error: --source must be "csv" or "database", got "${value}"`);
        usage();
      }
      source = value;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      usage();
    }
  }

  if (command !== "wizard" && command !== "introspect" && command !== "compile-request" && !manifest) {
    console.error("Error: --manifest is required");
    usage();
  }

  if (command === "compile-request" && !plan) {
    console.error("Error: --plan is required for compile-request");
    usage();
  }

  if ((command === "wizard" || command === "introspect") && !db) {
    console.error(`Error: --db is required for ${command}`);
    usage();
  }

  return { command, manifest, output, db, plan, source };
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

function formatIntrospectOutput(model: DetectedModel): string {
  const lines: string[] = [];

  lines.push("# Detected Data Model\n");

  lines.push("## Entities");
  for (const e of model.entities) {
    const cols = e.columns.map((c) => `${c.name} (${c.type}${c.isUnique ? ", unique" : ""})`).join(", ");
    lines.push(`  ${e.name}  pk=${e.pk ?? "none"}  rows=${e.rowCount}`);
    lines.push(`    columns: ${cols}`);
  }

  if (model.junctions.length > 0) {
    lines.push("\n## Junction Tables");
    for (const j of model.junctions) {
      const cols = j.columns.map((c) => c.name).join(", ");
      lines.push(`  ${j.name}  rows=${j.rowCount}  columns: ${cols}`);
    }
  }

  if (model.unclassified.length > 0) {
    lines.push("\n## Unclassified Tables");
    for (const u of model.unclassified) {
      lines.push(`  ${u.name}  rows=${u.rowCount}`);
    }
  }

  if (model.relationships.length > 0) {
    lines.push("\n## Many-to-Many Relationships (via junction)");
    for (const r of model.relationships) {
      lines.push(`  ${r.entity1} <-> ${r.entity2}  via ${r.junctionTable}  (${r.fk1Column}, ${r.fk2Column})  rows=${r.rowCount}`);
    }
  }

  if (model.directFKs.length > 0) {
    lines.push("\n## Direct Foreign Keys (M:1)");
    for (const fk of model.directFKs) {
      lines.push(`  ${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}.${fk.toColumn}`);
    }
  }

  if (model.metrics.length > 0) {
    lines.push("\n## Metric Candidates");
    for (const m of model.metrics) {
      lines.push(`  ${m.table}.${m.column}  type=${m.type}  nature=${m.nature ?? "?"}`);
    }
  }

  return lines.join("\n");
}

async function runIntrospect(dbPath: string): Promise<void> {
  const model = await introspect(dbPath);
  console.log(formatIntrospectOutput(model));
}

function runGenerate(
  manifestPath: string,
  outputDir: string,
  source: "csv" | "database",
): void {
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
  const result = generate(manifest, { dataDir, source });
  const written = emitFiles(result, outputDir);

  console.log(`Generated ${written.length} files in ${outputDir}/`);
  for (const f of written) {
    console.log(`  ${f}`);
  }
  if (source === "database") {
    console.log(`Run ${path.join(outputDir, "run.sh")} <database_path> to materialize and count the BFT tables.`);
  }
}

function runCompileRequest(planPath: string, outputDir: string): void {
  const plan = loadRequestPlan(planPath);
  const compiled = compileRequest(plan);
  const written = emitCompiledRequest(compiled, outputDir);
  console.log(`Compiled request "${compiled.metadata.requestId}" into ${outputDir}/`);
  for (const file of written) console.log(`  ${file}`);
}

async function main(): Promise<void> {
  const { command, manifest, output, db, plan, source } = parseArgs(process.argv);
  if (command === "wizard") {
    await runWizard({
      dbPath: db,
      outputPath: output !== "./out" ? output : undefined,
      manifestPath: manifest || undefined,
    });
  } else if (command === "introspect") {
    await runIntrospect(db);
  } else if (command === "validate") {
    runValidate(manifest);
  } else if (command === "compile-request") {
    runCompileRequest(plan, output);
  } else {
    runGenerate(manifest, output, source);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
