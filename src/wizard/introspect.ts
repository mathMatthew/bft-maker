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
/*  PK detection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Detect the primary key column for a table.
 * Priority: column named `id`, column named `tablename_id`,
 * then any unique integer column that's first.
 */
function detectPK(table: TableInfo): string | null {
  const { name, columns, rowCount } = table;
  if (rowCount === 0) return null;

  // Unique columns (already computed during introspect)
  const uniqueCols = columns.filter((c) => c.isUnique);

  // Priority 1: column named exactly "id"
  const idCol = uniqueCols.find((c) => c.name.toLowerCase() === "id");
  if (idCol) return idCol.name;

  // Priority 2: column named tablename_id (singular or plural stem)
  const tblLower = name.toLowerCase();
  for (const col of uniqueCols) {
    const colLower = col.name.toLowerCase();
    if (!colLower.endsWith("_id")) continue;
    const stem = colLower.replace(/_id$/, "");
    if (
      tblLower === stem ||
      tblLower === stem + "s" ||
      tblLower === stem + "es" ||
      tblLower === stem.replace(/y$/, "ies")
    ) {
      return col.name;
    }
  }

  // Priority 3: first unique integer column
  const firstUniqueInt = uniqueCols.find((c) => c.isNumeric);
  if (firstUniqueInt) return firstUniqueInt.name;

  return null;
}

/* ------------------------------------------------------------------ */
/*  FK matching                                                       */
/* ------------------------------------------------------------------ */

/**
 * Match _id columns to PKs in other tables.
 * Uses name matching: column `foo_id` matches table `foo` or `foos`.
 */
function detectFKs(tables: TableInfo[]): FKRef[] {
  const pkByTable = new Map<string, string>();
  for (const t of tables) {
    if (t.pk) pkByTable.set(t.name, t.pk);
  }

  const refs: FKRef[] = [];

  for (const table of tables) {
    for (const col of table.columns) {
      const colLower = col.name.toLowerCase();
      if (!colLower.endsWith("_id")) continue;

      // Skip if this is the table's own PK
      if (col.name === table.pk) continue;

      const stem = colLower.replace(/_id$/, "");

      // Try to match to another table's PK
      for (const [otherTable, otherPK] of pkByTable) {
        if (otherTable === table.name) continue;
        const otherLower = otherTable.toLowerCase();

        // Match stem to table name: student → students, class → classes, etc.
        if (
          otherLower === stem ||
          otherLower === stem + "s" ||
          otherLower === stem + "es" ||
          otherLower === stem.replace(/y$/, "ies")
        ) {
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
 * A junction table has 2+ FK references to entity PKs and typically
 * no PK of its own (or its PK is composite).
 */
function classifyTables(
  tables: TableInfo[],
  fks: FKRef[],
): { entities: TableInfo[]; junctions: TableInfo[]; unclassified: TableInfo[] } {
  // Count outgoing FKs per table
  const fkCountByTable = new Map<string, number>();
  for (const fk of fks) {
    fkCountByTable.set(fk.fromTable, (fkCountByTable.get(fk.fromTable) ?? 0) + 1);
  }

  const entities: TableInfo[] = [];
  const junctions: TableInfo[] = [];
  const unclassified: TableInfo[] = [];

  for (const table of tables) {
    const fkCount = fkCountByTable.get(table.name) ?? 0;

    if (fkCount >= 2) {
      // 2+ FKs out → junction table
      junctions.push(table);
    } else if (table.pk) {
      // Has a PK → entity
      entities.push(table);
    } else if (fkCount === 0) {
      // No PK, no FKs → entity (just no detected PK)
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
  // Columns to exclude: PKs and FK columns
  const fkCols = new Set(fks.map((fk) => `${fk.fromTable}.${fk.fromColumn}`));

  const metrics: { table: string; column: string; type: string }[] = [];

  for (const table of tables) {
    for (const col of table.columns) {
      if (!col.isNumeric) continue;
      if (col.name === table.pk) continue;
      if (fkCols.has(`${table.name}.${col.name}`)) continue;
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

      tables.push({ name: tableName, rowCount, columns, pk: null });
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

    // Detect metrics
    const metrics = detectMetrics(entities, allFKs);

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
