import * as clack from "@clack/prompts";
import ansiEscapes from "ansi-escapes";
import chalk from "chalk";
import type { Entity, Relationship, MetricDef } from "../../manifest/types.js";
import type { WizardState } from "../state.js";
import {
  introspect,
  detectRole,
  inferMetricType,
  querySampleRows,
  queryDistinctValues,
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
 * Format a column classification tag for display, padded to `width` visible chars.
 */
function classificationTag(
  model: DetectedModel,
  tableName: string,
  col: ColumnInfo,
  pk: string | null,
  width: number,
): string {
  const desig = getColumnDesignation(model, tableName, col, pk);
  if (!desig) return chalk.dim("attr".padEnd(width));
  if (desig === "key") return chalk.yellow("key".padEnd(width));
  if (desig === "additive") return chalk.green("additive".padEnd(width));
  if (desig === "non-additive") return chalk.magenta("non-addit.".padEnd(width));
  if (desig === "metric") return chalk.green("metric?".padEnd(width));
  // FK reference like "~ orders"
  return chalk.cyan(truncate(desig, width).padEnd(width));
}

type PreviewMode = "rows" | "distinct";

interface PreviewData {
  mode: PreviewMode;
  count: number;
  /** Correlated sample rows (mode === "rows"). */
  sampleRows?: Record<string, unknown>[];
  /** Per-column distinct values (mode === "distinct"). */
  distinctValues?: Map<string, unknown[]>;
}

type PreviewAction = "quit" | "count" | "mode" | "edit";

/**
 * Render the preview grid content (no alternate screen enter/exit — caller manages that).
 */
function renderPreviewGrid(
  table: TableInfo,
  model: DetectedModel,
  data: PreviewData,
): void {
  const out = process.stdout;
  const termCols = (out as NodeJS.WriteStream).columns ?? 80;
  const termRows = (out as NodeJS.WriteStream).rows ?? 24;

  // Determine max number of value columns to display
  let numValueCols: number;
  if (data.mode === "rows") {
    numValueCols = data.sampleRows!.length;
  } else {
    numValueCols = 0;
    for (const vals of data.distinctValues!.values()) {
      numValueCols = Math.max(numValueCols, vals.length);
    }
  }

  out.write(ansiEscapes.cursorTo(0, 0));
  out.write(ansiEscapes.eraseScreen);

  // Title
  const modeLabel = data.mode === "rows"
    ? `first ${numValueCols} rows`
    : `${data.count} distinct values per column`;
  out.write(
    chalk.bold(table.name) +
    chalk.dim(` — ${table.rowCount} rows, ${modeLabel}`) +
    "\n",
  );

  if (numValueCols === 0) {
    out.write(chalk.dim("\n  (no data)\n"));
  } else {
    const colNames = table.columns.map((c) => c.name);

    // Build classification tags for width calculation
    const tags = table.columns.map((c) =>
      getColumnDesignation(model, table.name, c, table.pk) || "attr",
    );
    const maxTagLen = Math.max(...tags.map((t) => t.length));

    // Label width = longest column name
    const labelWidth = Math.min(
      Math.max(...colNames.map((n) => n.length)) + 1,
      24,
    );
    const tagWidth = Math.min(maxTagLen + 1, 12);

    // Value cell width = divide remaining space among value columns
    const gap = 2;
    const available = termCols - labelWidth - tagWidth - 5;
    const cellWidth = Math.max(
      6,
      Math.min(14, Math.floor((available - gap * numValueCols) / numValueCols)),
    );

    // Column number header
    const colNums = Array.from({ length: numValueCols }, (_, i) =>
      chalk.dim(String(i + 1).padStart(cellWidth)),
    ).join("  ");
    const headerPad = "".padEnd(labelWidth + tagWidth + 2);
    out.write(`\n  ${headerPad}${colNums}\n`);
    out.write(
      `  ${headerPad}${chalk.dim("─".repeat(numValueCols * (cellWidth + gap) - gap))}\n`,
    );

    // Chunk columns into groups that fit the terminal height
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
        out.write(`\n  ${headerPad}${colNums}\n`);
        out.write(
          `  ${headerPad}${chalk.dim("─".repeat(numValueCols * (cellWidth + gap) - gap))}\n`,
        );
      }

      for (const colIdx of chunks[ci]) {
        const col = table.columns[colIdx];
        const name = col.name;

        const label = truncate(name, labelWidth).padEnd(labelWidth);
        const tag = classificationTag(model, table.name, col, table.pk, tagWidth);

        // Values — either from correlated rows or distinct per-column
        let values: string;
        if (data.mode === "rows") {
          values = data.sampleRows!
            .map((row) => truncate(row[name], cellWidth).padStart(cellWidth))
            .join("  ");
        } else {
          const colVals = data.distinctValues!.get(name) ?? [];
          values = Array.from({ length: numValueCols }, (_, i) =>
            truncate(i < colVals.length ? colVals[i] : "", cellWidth).padStart(cellWidth),
          ).join("  ");
        }

        out.write(`  ${label}  ${tag}  ${values}\n`);
      }
    }
  }

  // Footer with keybindings
  const toggleLabel = data.mode === "rows" ? "distinct values" : "first rows";
  out.write(
    chalk.dim(`\n  r`) + chalk.dim(` change count  `) +
    chalk.dim(`d`) + chalk.dim(` ${toggleLabel}  `) +
    chalk.dim(`e`) + chalk.dim(` edit  `) +
    chalk.dim(`q/esc`) + chalk.dim(` back\n`),
  );
}

/**
 * Read a number from the user inline on the alternate screen.
 * Shows a prompt at the bottom, reads digits, enter to confirm, esc to cancel.
 */
function readNumberInline(prompt: string, current: number): Promise<number | null> {
  const out = process.stdout;
  const input = process.stdin as NodeJS.ReadStream;
  let buf = "";

  out.write(ansiEscapes.eraseLine + ansiEscapes.cursorTo(0));
  out.write(`  ${prompt} (current: ${current}): `);
  out.write(ansiEscapes.cursorShow);

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();

    function onData(chunk: Buffer): void {
      const key = chunk.toString();

      // Esc or Ctrl-C → cancel
      if (key === "\x1b" || key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }

      // Enter → confirm
      if (key === "\r" || key === "\n") {
        cleanup();
        const n = parseInt(buf, 10);
        resolve(isNaN(n) || n < 1 ? null : n);
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          out.write("\b \b");
        }
        return;
      }

      // Digit
      if (/^\d$/.test(key)) {
        buf += key;
        out.write(key);
      }
    }

    function cleanup(): void {
      input.removeListener("data", onData);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      out.write(ansiEscapes.cursorHide);
    }

    input.on("data", onData);
  });
}

/**
 * Show the table preview on the alternate screen.
 * Returns the user's action: quit, change count, or toggle mode.
 */
function showTablePreview(
  table: TableInfo,
  model: DetectedModel,
  data: PreviewData,
): Promise<PreviewAction> {
  const out = process.stdout;
  const input = process.stdin as NodeJS.ReadStream;

  renderPreviewGrid(table, model, data);
  out.write(ansiEscapes.cursorHide);

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();

    function onKey(chunk: Buffer): void {
      const key = chunk.toString().toLowerCase();

      if (key === "q" || key === "\x1b" || key === "\x03") {
        cleanup();
        resolve("quit");
      } else if (key === "r") {
        cleanup();
        resolve("count");
      } else if (key === "d") {
        cleanup();
        resolve("mode");
      } else if (key === "e") {
        cleanup();
        resolve("edit");
      }
      // Ignore other keys
    }

    function cleanup(): void {
      input.removeListener("data", onKey);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      out.write(ansiEscapes.cursorShow);
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

  // Metric — show nature if classified
  const metric = model.metrics.find((m) => m.table === tableName && m.column === col.name);
  if (metric) {
    return metric.nature ?? "metric";
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
 * If targetTable is provided, skip the table selection prompt.
 */
async function editTableDetails(model: DetectedModel, targetTable?: string): Promise<boolean> {
  let tableName: string | symbol;
  if (targetTable) {
    tableName = targetTable;
  } else {
    const allTables = [...model.entities, ...model.junctions, ...model.unclassified];

    tableName = await clack.select({
      message: "Which table to view/edit?",
      options: allTables.map((t) => ({
        value: t.name,
        label: t.name,
        hint: `${t.rowCount} rows`,
      })),
    });
    if (clack.isCancel(tableName)) return true;
  }

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

      case "metric": {
        const nature = await clack.select({
          message: `Is ${col.name} additive (summable)?`,
          options: [
            { value: "additive", label: "Yes — additive", hint: "revenue, headcount" },
            { value: "non-additive", label: "No — non-additive", hint: "rating, percentage" },
          ],
        });
        if (clack.isCancel(nature)) continue;

        // Remove existing entry if any, then add with nature
        model.metrics = model.metrics.filter(
          (m) => !(m.table === table.name && m.column === col.name),
        );
        model.metrics.push({
          table: table.name,
          column: col.name,
          type: col.type,
          nature: nature as "additive" | "non-additive",
        });
        model.allFKs = model.allFKs.filter(
          (f) => !(f.fromTable === table.name && f.fromColumn === col.name),
        );
        if (table.pk === col.name) table.pk = null;
        clack.log.success(`${col.name} → ${nature}`);
        break;
      }

      case "connect": {
        const allTables = [...model.entities, ...model.junctions, ...model.unclassified];
        const target = await clack.select({
          message: `Connect ${colName} to which table?`,
          options: allTables.map((t) => ({
            value: t.name,
            label: t.name,
            hint: t.name === table.name ? "self-join not supported" : undefined,
            disabled: t.name === table.name,
          })),
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
 * Ask the user to classify a single metric as additive/non-additive/skip.
 * Returns null on cancel.
 */
async function askMetricNature(
  m: { table: string; column: string; type: string; nature?: "additive" | "non-additive" },
  model: DetectedModel,
): Promise<boolean | null> {
  const table = model.tables.find((t) => t.name === m.table);
  const seen = new Set<string>();
  const samples: unknown[] = [];
  for (const row of table?.sampleRows ?? []) {
    const v = row[m.column];
    if (v == null) continue;
    const key = String(v);
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(v);
    if (samples.length >= 5) break;
  }
  const sampleHint = samples.length > 0
    ? ` (e.g. ${samples.join(", ")})`
    : "";

  const current = m.nature;
  const nature = await clack.select({
    message: `${m.table}.${m.column}${sampleHint}`,
    options: [
      { value: "additive", label: "Additive", hint: "revenue, headcount" },
      { value: "non-additive", label: "Non-additive", hint: "rating, percentage, per-unit" },
      { value: "skip", label: "Not a metric — remove" },
    ],
    initialValue: current ?? "additive",
  });
  if (clack.isCancel(nature)) return null;

  if (nature === "skip") {
    m.nature = undefined;
  } else {
    m.nature = nature as "additive" | "non-additive";
  }
  return true;
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
    // Remove from classification arrays but keep in model.tables
    // so the table can be re-included via the table selection prompt.
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

/** Track user's preferred preview settings across previews in a session. */
interface PreviewSettings {
  rowCount: number;
  mode: PreviewMode;
}

async function loadPreviewData(
  dbPath: string,
  table: TableInfo,
  mode: PreviewMode,
  count: number,
): Promise<PreviewData> {
  if (mode === "distinct") {
    const colNames = table.columns.map((c) => c.name);
    const distinctValues = await queryDistinctValues(dbPath, table.name, colNames, count);
    return { mode, count, distinctValues };
  }
  const sampleRows = await querySampleRows(dbPath, table.name, count);
  return { mode, count, sampleRows };
}

async function previewTable(model: DetectedModel, dbPath: string, settings: PreviewSettings): Promise<boolean> {
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
  const out = process.stdout;

  let currentCount = settings.rowCount;
  let currentMode = settings.mode;

  out.write(ansiEscapes.enterAlternativeScreen);

  try {
    while (true) {
      const data = await loadPreviewData(dbPath, table, currentMode, currentCount);
      const action = await showTablePreview(table, model, data);

      if (action === "quit") break;

      if (action === "mode") {
        currentMode = currentMode === "rows" ? "distinct" : "rows";
        settings.mode = currentMode;
        continue;
      }

      if (action === "count") {
        const n = await readNumberInline("How many", currentCount);
        if (n != null) {
          currentCount = n;
          settings.rowCount = n;
        }
        continue;
      }

      if (action === "edit") {
        // Leave alt screen for clack prompts, edit, then come back
        out.write(ansiEscapes.exitAlternativeScreen);
        await editTableDetails(model, table.name);
        out.write(ansiEscapes.enterAlternativeScreen);
      }
    }
  } finally {
    out.write(ansiEscapes.exitAlternativeScreen);
  }

  return true;
}

/* ------------------------------------------------------------------ */
/*  Edit loop                                                         */
/* ------------------------------------------------------------------ */

async function editLoop(model: DetectedModel, dbPath: string, settings: PreviewSettings): Promise<boolean> {
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
        if (!(await previewTable(model, dbPath, settings))) return false;
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

export interface DataModelResult {
  ok: boolean;
  /** The detected model, available for draft saving even on cancel. */
  model?: DetectedModel;
}

export async function runDataModelStep(
  state: WizardState,
  dbPath: string,
  savedModel?: DetectedModel,
): Promise<DataModelResult> {
  clack.log.step("Step 1: Discover your data model");

  let model: DetectedModel;

  if (savedModel) {
    model = savedModel;
    clack.log.info(
      `Resuming: ${model.tables.length} tables — ` +
      `${model.entities.length} entities, ` +
      `${model.relationships.length} relationships, ` +
      `${model.metrics.length} metrics`,
    );
  } else {
    const s = clack.spinner();
    s.start("Analyzing database schema...");

    try {
      model = await introspect(dbPath);
    } catch (err) {
      s.stop("Failed to read database");
      clack.log.error(err instanceof Error ? err.message : String(err));
      return { ok: false };
    }

    s.stop(
      `Found ${model.tables.length} tables — ` +
      `${model.entities.length} entities, ` +
      `${model.relationships.length} relationships, ` +
      `${model.metrics.length} metrics detected`,
    );
  }

  // Table selection (default: all included)
  // Shown on first run and on resume — the user can always change which tables are included.
  if (model.tables.length > 0) {
    const currentlyIncluded = new Set([
      ...model.entities.map((t) => t.name),
      ...model.junctions.map((t) => t.name),
      ...model.unclassified.map((t) => t.name),
    ]);

    const include = await clack.multiselect({
      message: "Which tables to include?",
      options: model.tables.map((t) => ({
        value: t.name,
        label: t.name,
        hint: `${t.rowCount} rows, ${t.columns.length} cols`,
      })),
      initialValues: model.tables
        .filter((t) => currentlyIncluded.has(t.name))
        .map((t) => t.name),
    });

    if (clack.isCancel(include)) return { ok: false, model };
    const included = new Set(include as string[]);

    // Rebuild classification arrays from table selection
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

    // Tables that were excluded but re-included need a classification
    for (const t of model.tables) {
      if (!included.has(t.name)) continue;
      const isClassified =
        model.entities.some((e) => e.name === t.name) ||
        model.junctions.some((j) => j.name === t.name) ||
        model.unclassified.some((u) => u.name === t.name);
      if (!isClassified) {
        model.unclassified.push(t);
      }
    }
  }

  // Review and edit
  const previewSettings: PreviewSettings = { rowCount: 5, mode: "rows" as PreviewMode };
  if (!(await editLoop(model, dbPath, previewSettings))) return { ok: false, model };

  // Validation
  if (model.entities.length === 0) {
    clack.log.error("No entities in the model. Need at least one.");
    return { ok: false, model };
  }

  // ── Build state from the confirmed model ──────────────────

  // Show metric classifications and let user accept or walk through
  const metricDefs: Map<string, MetricDef[]> = new Map();

  if (model.metrics.length > 0) {
    const unclassified = model.metrics.filter((m) => !m.nature);
    const classified = model.metrics.filter((m) => m.nature);

    if (unclassified.length > 0) {
      // Some metrics have no guess — must walk through those
      clack.log.message("");
      clack.log.step("Unclassified metrics");
      for (const m of unclassified) {
        const result = await askMetricNature(m, model);
        if (result === null) return { ok: false, model };
      }
    }

    if (classified.length > 0) {
      // Show auto-classifications and offer review
      clack.log.message("");
      clack.log.step("Metric classifications");
      for (const m of classified) {
        const tag = m.nature === "additive" ? "additive" : "non-additive";
        clack.log.message(`  ${m.table}.${m.column} → ${tag}`);
      }

      const review = await clack.select({
        message: `${classified.length} metrics auto-classified. Review?`,
        options: [
          { value: "accept", label: "Looks good" },
          { value: "walk", label: "Walk me through each one" },
        ],
      });
      if (clack.isCancel(review)) return { ok: false, model };

      if (review === "walk") {
        for (const m of classified) {
          const result = await askMetricNature(m, model);
          if (result === null) return { ok: false, model };
        }
      }
    }
  }

  // Remove skipped metrics (nature cleared) and build metricDefs
  model.metrics = model.metrics.filter((m) => m.nature);
  for (const m of model.metrics) {
    const def: MetricDef = {
      name: m.column,
      type: inferMetricType(m.type),
      nature: m.nature!,
    };
    const existing = metricDefs.get(m.table) ?? [];
    existing.push(def);
    metricDefs.set(m.table, existing);
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

  return { ok: true, model };
}
