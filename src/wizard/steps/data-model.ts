import * as clack from "@clack/prompts";
import ansiEscapes from "ansi-escapes";
import chalk from "chalk";
import type { Entity, Relationship, MetricDef } from "../../manifest/types.js";
import type { WizardState } from "../state.js";
import {
  introspect,
  detectRole,
  inferMetricType,
  type ColumnInfo,
  type DetectedModel,
  type DetectedRelationship,
  type TableInfo,
} from "../introspect.js";

/* ------------------------------------------------------------------ */
/*  Display helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Truncate a string to width, adding ellipsis if needed.
 */
function truncate(v: unknown, width: number): string {
  const s = v == null ? "" : String(v);
  if (s.length > width) return s.slice(0, width - 1) + "…";
  return s;
}

/**
 * Render a transposed table preview on the alternate screen.
 * Columns go down, sample rows go across as numbered columns.
 * Groups columns into chunks that fit the terminal height.
 * Waits for any keypress to return.
 */
function showTablePreview(table: TableInfo): Promise<void> {
  const out = process.stdout;
  const input = process.stdin as NodeJS.ReadStream;
  const termCols = (out as NodeJS.WriteStream).columns ?? 80;
  const termRows = (out as NodeJS.WriteStream).rows ?? 24;
  const numSamples = table.sampleRows.length;

  out.write(ansiEscapes.enterAlternativeScreen);
  out.write(ansiEscapes.cursorTo(0, 0));

  // Title
  out.write(
    chalk.bold(table.name) +
    chalk.dim(` — ${table.rowCount} rows, showing first ${numSamples}`) +
    "\n",
  );

  if (numSamples === 0) {
    out.write(chalk.dim("\n  (no data)\n"));
  } else {
    const colNames = table.columns.map((c) => c.name);
    const colTypes = table.columns.map((c) => c.type);

    // Label width = longest column name + type tag
    const labelWidth = Math.min(
      Math.max(...colNames.map((n) => n.length)) + 1,
      24,
    );

    // Value cell width = divide remaining space among sample columns
    const gap = 2; // space between value cells
    const available = termCols - labelWidth - 3; // 3 for left margin + separator
    const cellWidth = Math.max(
      6,
      Math.min(14, Math.floor((available - gap * numSamples) / numSamples)),
    );

    // Row number header
    const rowNums = Array.from({ length: numSamples }, (_, i) =>
      chalk.dim(String(i + 1).padStart(cellWidth)),
    ).join("  ");
    out.write(`\n  ${"".padEnd(labelWidth)}  ${rowNums}\n`);
    out.write(
      `  ${"".padEnd(labelWidth)}  ${chalk.dim("─".repeat(numSamples * (cellWidth + gap) - gap))}\n`,
    );

    // Chunk columns into groups that fit the terminal height
    // Reserve lines for: title(1) + header(2) + footer(2) + chunk separator(1)
    const linesPerChunk = termRows - 6;
    const chunks: number[][] = [];
    for (let i = 0; i < colNames.length; i += linesPerChunk) {
      chunks.push(
        Array.from(
          { length: Math.min(linesPerChunk, colNames.length - i) },
          (_, j) => i + j,
        ),
      );
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      if (ci > 0) {
        // For subsequent chunks, clear and redraw header
        out.write(`\n  ${"".padEnd(labelWidth)}  ${rowNums}\n`);
        out.write(
          `  ${"".padEnd(labelWidth)}  ${chalk.dim("─".repeat(numSamples * (cellWidth + gap) - gap))}\n`,
        );
      }

      for (const colIdx of chunks[ci]) {
        const name = colNames[colIdx];
        const type = colTypes[colIdx];
        const isPK = name === table.pk;

        // Label: column name with type hint
        let label = name;
        if (isPK) label += chalk.yellow("*");
        label = truncate(label, labelWidth).padEnd(labelWidth);

        // Values
        const values = table.sampleRows
          .map((row) => {
            const v = truncate(row[name], cellWidth);
            return v.padStart(cellWidth);
          })
          .join("  ");

        const typeHint = chalk.dim(` ${type}`);
        out.write(`  ${label}  ${values}${typeHint}\n`);
      }
    }
  }

  out.write(chalk.dim("\n  Press any key to return.  * = primary key\n"));
  out.write(ansiEscapes.cursorHide);

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();

    function onKey(): void {
      input.removeListener("data", onKey);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      out.write(ansiEscapes.cursorShow);
      out.write(ansiEscapes.exitAlternativeScreen);
      resolve();
    }

    input.on("data", onKey);
  });
}

function showModel(model: DetectedModel): void {
  clack.log.message("");

  // Entities — compact two-column format
  if (model.entities.length > 0) {
    clack.log.step("Entities");
    for (const e of model.entities) {
      const role = detectRole(e.name, model.relationships);
      const metrics = model.metrics
        .filter((m) => m.table === e.name)
        .map((m) => m.column);
      const metricStr = metrics.length > 0 ? metrics.join(", ") : "none";
      clack.log.message(`  ${e.name} (${role}, ${e.rowCount} rows)`);
      if (metrics.length > 0) {
        clack.log.message(`    metrics: ${metricStr}`);
      }
    }
  }

  // Relationships
  if (model.relationships.length > 0) {
    clack.log.message("");
    clack.log.step("Relationships");
    for (const r of model.relationships) {
      const junctionMetrics = model.metrics
        .filter((m) => m.table === r.junctionTable)
        .map((m) => m.column);
      clack.log.message(`  ${r.entity1} ↔ ${r.entity2}`);
      clack.log.message(`    via ${r.junctionTable} (${r.rowCount} links)`);
      if (junctionMetrics.length > 0) {
        clack.log.message(`    metrics: ${junctionMetrics.join(", ")}`);
      }
    }
  }

  // Direct FKs (many-to-one)
  if (model.directFKs.length > 0) {
    clack.log.message("");
    clack.log.step("Direct references");
    for (const fk of model.directFKs) {
      clack.log.message(`  ${fk.fromTable}.${fk.fromColumn}`);
      clack.log.message(`    → ${fk.toTable}.${fk.toColumn}`);
    }
  }

  // Unclassified
  if (model.unclassified.length > 0) {
    clack.log.message("");
    clack.log.step("Unclassified tables");
    for (const t of model.unclassified) {
      clack.log.message(`  ${t.name} (${t.rowCount} rows)`);
    }
  }

  clack.log.message("");
}

/* ------------------------------------------------------------------ */
/*  Table detail view                                                 */
/* ------------------------------------------------------------------ */

/**
 * Get the display designation for a column.
 * Returns: "key", "~ tablename", "metric", or "".
 */
function getColumnDesignation(
  model: DetectedModel,
  tableName: string,
  col: ColumnInfo,
  pk: string | null,
): string {
  if (col.name === pk) return "key";

  // Outgoing connection (FK from this column to another table)
  const fk = model.allFKs.find(
    (f) => f.fromTable === tableName && f.fromColumn === col.name,
  );
  if (fk) {
    const suffix = fk.toColumn !== col.name ? ` (${fk.toColumn})` : "";
    return `~ ${fk.toTable}${suffix}`;
  }

  // Metric
  if (model.metrics.some((m) => m.table === tableName && m.column === col.name)) {
    return "metric";
  }

  return "";
}

/**
 * Show column-level detail for a table.
 */
function showTableDetail(model: DetectedModel, table: TableInfo): void {
  const maxNameLen = Math.max(...table.columns.map((c) => c.name.length));
  const maxTypeLen = Math.max(...table.columns.map((c) => c.type.length));

  clack.log.message("");
  clack.log.step(`${table.name} (${table.rowCount} rows)`);

  for (const col of table.columns) {
    const name = col.name.padEnd(maxNameLen);
    const type = col.type.padEnd(maxTypeLen);
    const desig = getColumnDesignation(model, table.name, col, table.pk);

    if (desig) {
      clack.log.message(`  ${name}  ${type}  ${desig}`);
    } else {
      clack.log.message(`  ${name}  ${type}`);
    }

    // Show incoming connections on key columns
    if (col.name === table.pk) {
      const incoming = model.allFKs
        .filter((fk) => fk.toTable === table.name && fk.toColumn === col.name)
        .map((fk) => fk.fromTable);
      if (incoming.length > 0) {
        clack.log.message(`    ~ ${incoming.join(", ")}`);
      }
    }
  }

  clack.log.message("");
}

/**
 * Edit columns within a single table.
 */
async function editTableDetails(model: DetectedModel): Promise<boolean> {
  const allTables = [...model.entities, ...model.junctions, ...model.unclassified];

  const tableName = await clack.select({
    message: "Which table to view/edit?",
    options: allTables.map((t) => ({
      value: t.name,
      label: t.name,
      hint: `${t.rowCount} rows`,
    })),
  });
  if (clack.isCancel(tableName)) return true;

  const table = model.tables.find((t) => t.name === tableName)!;

  while (true) {
    showTableDetail(model, table);

    const action = await clack.select({
      message: "Edit a column or go back?",
      options: [
        { value: "back", label: "Back to menu" },
        { value: "edit", label: "Change a column" },
      ],
    });
    if (clack.isCancel(action) || action === "back") return true;

    // Pick which column
    const colName = await clack.select({
      message: "Which column?",
      options: table.columns.map((c) => {
        const desig = getColumnDesignation(model, table.name, c, table.pk);
        return {
          value: c.name,
          label: c.name,
          hint: desig || "attribute",
        };
      }),
    });
    if (clack.isCancel(colName)) continue;

    const col = table.columns.find((c) => c.name === colName)!;

    // Build designation options
    const opts: { value: string; label: string; hint?: string }[] = [
      { value: "attribute", label: "Attribute", hint: "no special role" },
      { value: "key", label: "Key", hint: "identifies rows" },
    ];
    if (col.isNumeric) {
      opts.push({ value: "metric", label: "Metric", hint: "BFT number" });
    }
    opts.push({ value: "connect", label: "Connect to table" });

    const newDesig = await clack.select({
      message: `New role for ${colName}`,
      options: opts,
    });
    if (clack.isCancel(newDesig)) continue;

    switch (newDesig) {
      case "key":
        table.pk = col.name;
        // Remove from metrics and FKs
        model.metrics = model.metrics.filter(
          (m) => !(m.table === table.name && m.column === col.name),
        );
        model.allFKs = model.allFKs.filter(
          (f) => !(f.fromTable === table.name && f.fromColumn === col.name),
        );
        clack.log.success(`${col.name} → key`);
        break;

      case "metric":
        if (!model.metrics.some((m) => m.table === table.name && m.column === col.name)) {
          model.metrics.push({ table: table.name, column: col.name, type: col.type });
        }
        model.allFKs = model.allFKs.filter(
          (f) => !(f.fromTable === table.name && f.fromColumn === col.name),
        );
        if (table.pk === col.name) table.pk = null;
        clack.log.success(`${col.name} → metric`);
        break;

      case "connect": {
        const targetTables = model.tables.filter((t) => t.name !== table.name);
        const target = await clack.select({
          message: `Connect ${colName} to which table?`,
          options: targetTables.map((t) => ({ value: t.name, label: t.name })),
        });
        if (clack.isCancel(target)) continue;

        const targetTable = model.tables.find((t) => t.name === target)!;
        let targetCol = targetTable.pk;

        // If no PK or user might want a different column, ask
        if (!targetCol) {
          const picked = await clack.select({
            message: `Which column on ${target}?`,
            options: targetTable.columns.map((c) => ({
              value: c.name,
              label: `${c.name} (${c.type})`,
            })),
          });
          if (clack.isCancel(picked)) continue;
          targetCol = picked as string;
        }

        // Remove old FK for this column
        model.allFKs = model.allFKs.filter(
          (f) => !(f.fromTable === table.name && f.fromColumn === col.name),
        );
        model.allFKs.push({
          fromTable: table.name,
          fromColumn: col.name,
          toTable: target as string,
          toColumn: targetCol,
        });
        model.metrics = model.metrics.filter(
          (m) => !(m.table === table.name && m.column === col.name),
        );
        if (table.pk === col.name) table.pk = null;
        clack.log.success(`${col.name} ~ ${target}`);
        break;
      }

      case "attribute":
        model.metrics = model.metrics.filter(
          (m) => !(m.table === table.name && m.column === col.name),
        );
        model.allFKs = model.allFKs.filter(
          (f) => !(f.fromTable === table.name && f.fromColumn === col.name),
        );
        if (table.pk === col.name) table.pk = null;
        clack.log.success(`${col.name} → attribute`);
        break;
    }

    // Rebuild derived data after any change
    rebuildDerivedData(model);
  }
}

/**
 * Re-derive directFKs and relationships from allFKs
 * and current table classifications.
 */
function rebuildDerivedData(model: DetectedModel): void {
  const entityNames = new Set(model.entities.map((e) => e.name));

  // Rebuild directFKs (entity-to-entity)
  model.directFKs = model.allFKs.filter(
    (fk) => entityNames.has(fk.fromTable) && entityNames.has(fk.toTable),
  );

  // Rebuild relationships from junction tables
  model.relationships = [];
  for (const jt of model.junctions) {
    const jtFKs = model.allFKs.filter((fk) => fk.fromTable === jt.name);
    if (jtFKs.length >= 2) {
      model.relationships.push({
        junctionTable: jt.name,
        entity1: jtFKs[0].toTable,
        entity2: jtFKs[1].toTable,
        fk1Column: jtFKs[0].fromColumn,
        fk2Column: jtFKs[1].fromColumn,
        rowCount: jt.rowCount,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Reclassify table                                                  */
/* ------------------------------------------------------------------ */

async function reclassifyTable(model: DetectedModel): Promise<boolean> {
  const allTables = [
    ...model.entities.map((t) => ({ name: t.name, current: "entity" })),
    ...model.junctions.map((t) => ({ name: t.name, current: "junction" })),
    ...model.unclassified.map((t) => ({ name: t.name, current: "unclassified" })),
  ];

  const tableName = await clack.select({
    message: "Which table to reclassify?",
    options: allTables.map((t) => ({
      value: t.name,
      label: t.name,
      hint: `currently: ${t.current}`,
    })),
  });
  if (clack.isCancel(tableName)) return true;

  const newClass = await clack.select({
    message: `Reclassify ${tableName} as`,
    options: [
      { value: "entity", label: "Entity" },
      { value: "junction", label: "Junction", hint: "links two entities" },
      { value: "exclude", label: "Exclude from model" },
    ],
  });
  if (clack.isCancel(newClass)) return true;

  const table = model.tables.find((t) => t.name === tableName)!;

  // Remove from current classification
  model.entities = model.entities.filter((t) => t.name !== tableName);
  model.junctions = model.junctions.filter((t) => t.name !== tableName);
  model.unclassified = model.unclassified.filter((t) => t.name !== tableName);

  if (newClass === "exclude") {
    model.tables = model.tables.filter((t) => t.name !== tableName);
    model.allFKs = model.allFKs.filter(
      (fk) => fk.fromTable !== tableName && fk.toTable !== tableName,
    );
    model.metrics = model.metrics.filter((m) => m.table !== tableName);
    clack.log.success(`Excluded ${tableName}`);
  } else if (newClass === "junction") {
    model.junctions.push(table);
    clack.log.success(`${tableName} → junction`);
  } else {
    model.entities.push(table);
    clack.log.success(`${tableName} → entity`);
  }

  rebuildDerivedData(model);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Preview table                                                     */
/* ------------------------------------------------------------------ */

async function previewTable(model: DetectedModel): Promise<boolean> {
  const allTables = [...model.entities, ...model.junctions, ...model.unclassified];

  const tableName = await clack.select({
    message: "Which table to preview?",
    options: allTables.map((t) => ({
      value: t.name,
      label: t.name,
      hint: `${t.rowCount} rows`,
    })),
  });
  if (clack.isCancel(tableName)) return true;

  const table = model.tables.find((t) => t.name === tableName)!;
  await showTablePreview(table);

  return true;
}

/* ------------------------------------------------------------------ */
/*  Edit loop                                                         */
/* ------------------------------------------------------------------ */

async function editLoop(model: DetectedModel): Promise<boolean> {
  while (true) {
    showModel(model);

    const action = await clack.select({
      message: "What would you like to change?",
      options: [
        { value: "done", label: "Looks good, continue" },
        { value: "detail", label: "Edit table details", hint: "columns & connections" },
        { value: "reclassify", label: "Reclassify a table", hint: "entity / junction / exclude" },
        { value: "preview", label: "Preview a table", hint: "see sample rows" },
      ],
    });

    if (clack.isCancel(action)) return false;

    switch (action) {
      case "done":
        return true;
      case "preview":
        if (!(await previewTable(model))) return false;
        break;
      case "detail":
        if (!(await editTableDetails(model))) return false;
        break;
      case "reclassify":
        if (!(await reclassifyTable(model))) return false;
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Step 1 runner                                                     */
/* ------------------------------------------------------------------ */

export async function runDataModelStep(
  state: WizardState,
  dbPath: string,
): Promise<boolean> {
  clack.log.step("Step 1: Discover your data model");

  const s = clack.spinner();
  s.start("Analyzing database schema...");

  let model: DetectedModel;
  try {
    model = await introspect(dbPath);
  } catch (err) {
    s.stop("Failed to read database");
    clack.log.error(err instanceof Error ? err.message : String(err));
    return false;
  }

  s.stop(
    `Found ${model.tables.length} tables — ` +
    `${model.entities.length} entities, ` +
    `${model.relationships.length} relationships, ` +
    `${model.metrics.length} metrics detected`,
  );

  // Table selection (default: all included)
  if (model.tables.length > 0) {
    const include = await clack.multiselect({
      message: "Which tables to include? (all selected by default)",
      options: model.tables.map((t) => ({
        value: t.name,
        label: t.name,
        hint: `${t.rowCount} rows, ${t.columns.length} cols`,
      })),
      initialValues: model.tables.map((t) => t.name),
    });

    if (clack.isCancel(include)) return false;
    const included = new Set(include as string[]);

    // Remove excluded tables from the model
    if (included.size < model.tables.length) {
      model.tables = model.tables.filter((t) => included.has(t.name));
      model.entities = model.entities.filter((t) => included.has(t.name));
      model.junctions = model.junctions.filter((t) => included.has(t.name));
      model.unclassified = model.unclassified.filter((t) => included.has(t.name));
      model.relationships = model.relationships.filter(
        (r) =>
          included.has(r.junctionTable) &&
          included.has(r.entity1) &&
          included.has(r.entity2),
      );
      model.directFKs = model.directFKs.filter(
        (fk) => included.has(fk.fromTable) && included.has(fk.toTable),
      );
      model.metrics = model.metrics.filter((m) => included.has(m.table));
    }
  }

  // Review and edit
  if (!(await editLoop(model))) return false;

  // Validation
  if (model.entities.length === 0) {
    clack.log.error("No entities in the model. Need at least one.");
    return false;
  }

  // ── Build state from the confirmed model ──────────────────

  // Ask additive/non-additive for each metric
  const metricDefs: Map<string, MetricDef[]> = new Map();

  if (model.metrics.length > 0) {
    clack.log.message("");
    clack.log.step("Metric details");

    for (const m of model.metrics) {
      // Show sample values to help the user decide
      const table = model.tables.find((t) => t.name === m.table);
      const samples = table?.sampleRows
        .map((row) => row[m.column])
        .filter((v) => v != null)
        .slice(0, 5) ?? [];
      const sampleHint = samples.length > 0
        ? ` (samples: ${samples.join(", ")})`
        : "";

      const nature = await clack.select({
        message: `Is ${m.table}.${m.column} additive?${sampleHint}`,
        options: [
          { value: "additive", label: "Yes — additive", hint: "revenue, headcount" },
          { value: "non-additive", label: "No — non-additive", hint: "rating, percentage" },
          { value: "skip", label: "Not a metric — remove" },
        ],
      });
      if (clack.isCancel(nature)) return false;

      if (nature === "skip") continue;

      const def: MetricDef = {
        name: m.column,
        type: inferMetricType(m.type),
        nature: nature as MetricDef["nature"],
      };

      const existing = metricDefs.get(m.table) ?? [];
      existing.push(def);
      metricDefs.set(m.table, existing);
    }
  }

  // Build entities
  for (const entity of model.entities) {
    const role = detectRole(entity.name, model.relationships);
    state.entities.push({
      name: entity.name,
      role,
      detail: true,
      estimated_rows: entity.rowCount,
      metrics: metricDefs.get(entity.name) ?? [],
      source_table: entity.name,
    });
  }

  // Build relationships (with junction table metrics)
  for (const rel of model.relationships) {
    state.relationships.push({
      name: rel.junctionTable,
      between: [rel.entity1, rel.entity2],
      type: "many-to-many",
      estimated_links: rel.rowCount,
      source_table: rel.junctionTable,
      metrics: metricDefs.get(rel.junctionTable),
    });
  }

  // Summary
  clack.log.message("");
  const relMetrics = state.relationships.reduce((n, r) => n + (r.metrics?.length ?? 0), 0);
  const totalMetrics = state.entities.reduce((n, e) => n + e.metrics.length, 0) + relMetrics;
  clack.log.step(
    `Data model: ${state.entities.length} entities, ` +
    `${state.relationships.length} relationships, ` +
    `${totalMetrics} metrics`,
  );
  clack.log.message("");

  return true;
}
