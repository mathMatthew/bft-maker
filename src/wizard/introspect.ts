import duckdb from "duckdb";

/* ------------------------------------------------------------------ */
/*  Promise wrappers for DuckDB callback API                          */
/* ------------------------------------------------------------------ */

function openDatabase(
  dbPath: string,
  opts: Record<string, string> = {},
): Promise<duckdb.Database> {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(dbPath, opts, (err: Error | null) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function closeDatabase(db: duckdb.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function query(db: duckdb.Database, sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Schema types                                                      */
/* ------------------------------------------------------------------ */

export interface ColumnInfo {
  name: string;
  type: string;
  isNumeric: boolean;
  isUnique: boolean;
}

export interface TableInfo {
  name: string;
  rowCount: number;
  columns: ColumnInfo[];
  /** Detected primary key column (unique, typically *_id or id). */
  pk: string | null;
  /** First few rows of data for preview. */
  sampleRows: Record<string, unknown>[];
}

/** A detected FK: column in `fromTable` references PK of `toTable`. */
export interface FKRef {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/** A detected relationship between two entity tables via a junction. */
export interface DetectedRelationship {
  junctionTable: string;
  entity1: string;
  entity2: string;
  fk1Column: string;
  fk2Column: string;
  rowCount: number;
}

/** Full auto-detected data model. */
export interface DetectedModel {
  tables: TableInfo[];
  /** Tables classified as entities (have a PK, not a junction). */
  entities: TableInfo[];
  /** Tables classified as junctions (2+ FKs to entity PKs). */
  junctions: TableInfo[];
  /** Tables that couldn't be classified. */
  unclassified: TableInfo[];
  /** Detected relationships via junction tables. */
  relationships: DetectedRelationship[];
  /** Direct FK references (M:1) between entity tables. */
  directFKs: FKRef[];
  /** All FK references found. */
  allFKs: FKRef[];
  /** Metric candidates: numeric non-PK non-FK columns. */
  metrics: { table: string; column: string; type: string }[];
}

/* ------------------------------------------------------------------ */
/*  Numeric type detection                                            */
/* ------------------------------------------------------------------ */

const NUMERIC_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
  "FLOAT", "DOUBLE", "DECIMAL", "REAL",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
]);

function isNumericType(duckdbType: string): boolean {
  const base = duckdbType.split("(")[0].toUpperCase().trim();
  return NUMERIC_TYPES.has(base);
}

/* ------------------------------------------------------------------ */
/*  Naming helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Extract the stem from an ID-like column name.
 * Handles: snake_case (`customer_id`), camelCase (`customerID`, `customerId`)
 * Returns lowercase stem or null if not an ID pattern.
 */
function extractIdStem(colName: string): string | null {
  const lower = colName.toLowerCase();

  // snake_case: customer_id → customer
  if (lower.endsWith("_id")) {
    return lower.replace(/_id$/, "");
  }

  // camelCase: customerID → customer, customerId → customer
  // Match when the name ends with "Id" or "ID" (but not the whole name)
  if (colName.length > 2 && /(?:Id|ID)$/.test(colName)) {
    return colName.replace(/(?:Id|ID)$/, "").toLowerCase();
  }

  return null;
}

/**
 * Check if a stem matches a table name, accounting for pluralization.
 */
function stemMatchesTable(stem: string, tableName: string): boolean {
  const tbl = tableName.toLowerCase();
  return (
    tbl === stem ||
    tbl === stem + "s" ||
    tbl === stem + "es" ||
    tbl === stem.replace(/y$/, "ies") ||
    // Also match singular table to plural stem and vice versa
    stem === tbl + "s" ||
    stem === tbl + "es"
  );
}

/**
 * Returns true if a column name looks like an ID/key column,
 * even if we can't match it to a specific table.
 */
function looksLikeId(colName: string): boolean {
  const lower = colName.toLowerCase();
  return lower === "id" || lower.endsWith("_id") || /(?:Id|ID)$/.test(colName);
}

/* ------------------------------------------------------------------ */
/*  PK detection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Detect the primary key column for a table.
 * Priority: column named `id`/`ID`, column named after the table
 * (snake or camelCase), then first unique ID-like column.
 */
function detectPK(table: TableInfo): string | null {
  const { name, columns, rowCount } = table;
  if (rowCount === 0) return null;

  // Unique columns (already computed during introspect)
  const uniqueCols = columns.filter((c) => c.isUnique);

  // Priority 1: column named exactly "id" or "ID"
  const idCol = uniqueCols.find((c) => c.name.toLowerCase() === "id");
  if (idCol) return idCol.name;

  // Priority 2: column named after the table (any casing convention)
  for (const col of uniqueCols) {
    const stem = extractIdStem(col.name);
    if (stem && stemMatchesTable(stem, name)) {
      return col.name;
    }
  }

  // Priority 3: first unique column whose name looks like an ID
  const firstIdLike = uniqueCols.find((c) => looksLikeId(c.name));
  if (firstIdLike) return firstIdLike.name;

  // Priority 4: first unique integer column
  const firstUniqueInt = uniqueCols.find((c) => c.isNumeric);
  if (firstUniqueInt) return firstUniqueInt.name;

  return null;
}

/* ------------------------------------------------------------------ */
/*  FK matching                                                       */
/* ------------------------------------------------------------------ */

/**
 * Match ID-like columns to PKs in other tables.
 * Handles both snake_case (customer_id) and camelCase (customerID).
 * Does NOT skip PK columns — a column can be both a table's PK and
 * a FK to another table (common in junction tables with composite keys).
 */
function detectFKs(tables: TableInfo[]): FKRef[] {
  const pkByTable = new Map<string, string>();
  for (const t of tables) {
    if (t.pk) pkByTable.set(t.name, t.pk);
  }

  const refs: FKRef[] = [];

  for (const table of tables) {
    for (const col of table.columns) {
      const stem = extractIdStem(col.name);
      if (!stem) continue;

      // Try to match to another table's PK
      for (const [otherTable, otherPK] of pkByTable) {
        if (otherTable === table.name) continue;

        if (stemMatchesTable(stem, otherTable)) {
          refs.push({
            fromTable: table.name,
            fromColumn: col.name,
            toTable: otherTable,
            toColumn: otherPK,
          });
          break;
        }
      }
    }
  }

  return refs;
}

/* ------------------------------------------------------------------ */
/*  Table classification                                              */
/* ------------------------------------------------------------------ */

/**
 * Classify tables as entities, junctions, or unclassified.
 *
 * Junction: has 2+ FK columns AND does not have its own independent PK
 * (i.e., the PK is either absent or is itself a FK to another table).
 * Examples: order_details (orderID+productID), employee_territories.
 *
 * Entity: has its own non-FK PK, even if it also has FK columns.
 * Examples: orders (orderID is its own PK, not a FK), products.
 */
function classifyTables(
  tables: TableInfo[],
  fks: FKRef[],
): { entities: TableInfo[]; junctions: TableInfo[]; unclassified: TableInfo[] } {
  // FK columns per table
  const fksByTable = new Map<string, Set<string>>();
  for (const fk of fks) {
    if (!fksByTable.has(fk.fromTable)) fksByTable.set(fk.fromTable, new Set());
    fksByTable.get(fk.fromTable)!.add(fk.fromColumn);
  }

  const entities: TableInfo[] = [];
  const junctions: TableInfo[] = [];
  const unclassified: TableInfo[] = [];

  for (const table of tables) {
    const fkCols = fksByTable.get(table.name);
    const fkCount = fkCols?.size ?? 0;

    // A junction has 2+ FKs and no independent PK
    // (PK is absent, or PK is one of the FK columns)
    const pkIsFK = table.pk != null && (fkCols?.has(table.pk) ?? false);
    const hasOwnPK = table.pk != null && !pkIsFK;

    if (fkCount >= 2 && !hasOwnPK) {
      // Pure join table — clear the PK since it's composite
      table.pk = null;
      junctions.push(table);
    } else if (table.pk || fkCount === 0) {
      entities.push(table);
    } else {
      unclassified.push(table);
    }
  }

  return { entities, junctions, unclassified };
}

/* ------------------------------------------------------------------ */
/*  Role detection (leaf vs bridge)                                   */
/* ------------------------------------------------------------------ */

/**
 * Detect whether an entity is a leaf or bridge.
 * Bridge: referenced by 2+ junction tables.
 */
export function detectRole(
  entityName: string,
  relationships: DetectedRelationship[],
): "leaf" | "bridge" {
  let refCount = 0;
  for (const rel of relationships) {
    if (rel.entity1 === entityName || rel.entity2 === entityName) {
      refCount++;
    }
  }
  return refCount >= 2 ? "bridge" : "leaf";
}

/* ------------------------------------------------------------------ */
/*  Metric detection                                                  */
/* ------------------------------------------------------------------ */

function detectMetrics(
  tables: TableInfo[],
  fks: FKRef[],
): { table: string; column: string; type: string }[] {
  // Columns to exclude: PKs, FK columns, and anything that looks like an ID
  const fkCols = new Set(fks.map((fk) => `${fk.fromTable}.${fk.fromColumn}`));

  const metrics: { table: string; column: string; type: string }[] = [];

  for (const table of tables) {
    for (const col of table.columns) {
      if (!col.isNumeric) continue;
      if (col.name === table.pk) continue;
      if (fkCols.has(`${table.name}.${col.name}`)) continue;
      // Exclude columns that look like IDs even if we couldn't match them
      if (looksLikeId(col.name)) continue;
      metrics.push({ table: table.name, column: col.name, type: col.type });
    }
  }

  return metrics;
}

/* ------------------------------------------------------------------ */
/*  Map DuckDB type to manifest metric type                           */
/* ------------------------------------------------------------------ */

export function inferMetricType(
  duckdbType: string,
): "currency" | "integer" | "float" | "percentage" | "score" | "rating" {
  const base = duckdbType.split("(")[0].toUpperCase().trim();
  if (base === "DECIMAL" || base === "DOUBLE" || base === "FLOAT" || base === "REAL") {
    return "float";
  }
  return "integer";
}

/* ------------------------------------------------------------------ */
/*  Main introspect + auto-detect                                     */
/* ------------------------------------------------------------------ */

export async function introspect(dbPath: string): Promise<DetectedModel> {
  const db = await openDatabase(dbPath, { access_mode: "READ_ONLY" });

  try {
    const tableRows = await query(
      db,
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'main' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );

    const tables: TableInfo[] = [];

    for (const row of tableRows) {
      const tableName = row.table_name as string;

      const cols = await query(
        db,
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'main' AND table_name = '${tableName}'
         ORDER BY ordinal_position`,
      );

      const countResult = await query(db, `SELECT COUNT(*)::INTEGER AS cnt FROM "${tableName}"`);
      const rowCount = (countResult[0]?.cnt as number) ?? 0;

      // Check uniqueness for each column
      const columns: ColumnInfo[] = [];
      for (const c of cols) {
        const colName = c.column_name as string;
        const colType = c.data_type as string;

        let isUnique = false;
        if (rowCount > 0) {
          const uniqResult = await query(
            db,
            `SELECT (COUNT(DISTINCT "${colName}") = COUNT(*))::BOOLEAN AS is_unique FROM "${tableName}"`,
          );
          isUnique = uniqResult[0]?.is_unique === true;
        }

        columns.push({
          name: colName,
          type: colType,
          isNumeric: isNumericType(colType),
          isUnique,
        });
      }

      // Load sample rows for preview
      const sampleRows = await query(db, `SELECT * FROM "${tableName}" LIMIT 5`);

      tables.push({ name: tableName, rowCount, columns, pk: null, sampleRows });
    }

    // Detect PKs
    for (const table of tables) {
      table.pk = detectPK(table);
    }

    // Detect FKs
    const allFKs = detectFKs(tables);

    // Classify tables
    const { entities, junctions, unclassified } = classifyTables(tables, allFKs);

    // Build relationships from junction tables
    const relationships: DetectedRelationship[] = [];
    for (const jt of junctions) {
      const jtFKs = allFKs.filter((fk) => fk.fromTable === jt.name);
      if (jtFKs.length >= 2) {
        relationships.push({
          junctionTable: jt.name,
          entity1: jtFKs[0].toTable,
          entity2: jtFKs[1].toTable,
          fk1Column: jtFKs[0].fromColumn,
          fk2Column: jtFKs[1].fromColumn,
          rowCount: jt.rowCount,
        });
      }
    }

    // Detect direct FK references between entity tables
    const entityNames = new Set(entities.map((e) => e.name));
    const directFKs = allFKs.filter(
      (fk) => entityNames.has(fk.fromTable) && entityNames.has(fk.toTable),
    );

    // Detect metrics on all tables (junction tables like order_details
    // often carry the most important metrics: quantity, price, etc.)
    const metrics = detectMetrics(tables, allFKs);

    return {
      tables,
      entities,
      junctions,
      unclassified,
      relationships,
      directFKs,
      allFKs,
      metrics,
    };
  } finally {
    await closeDatabase(db);
  }
}
