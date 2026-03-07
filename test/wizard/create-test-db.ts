/**
 * Helper to create a DuckDB database file from CSV fixtures.
 * Used by wizard integration tests.
 */
import duckdb from "duckdb";
import * as path from "node:path";

function openDb(dbPath: string): Promise<duckdb.Database> {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(dbPath, {}, (err: Error | null) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function closeDb(db: duckdb.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function exec(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Create a DuckDB database file from CSV files in a data directory.
 * Each CSV file becomes a table (filename without extension).
 */
export async function createTestDb(
  dbPath: string,
  dataDir: string,
  csvFiles: string[],
): Promise<void> {
  const db = await openDb(dbPath);

  try {
    for (const csvFile of csvFiles) {
      const tableName = path.basename(csvFile, ".csv");
      const csvPath = path.join(dataDir, csvFile);
      await exec(
        db,
        `CREATE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${csvPath}')`,
      );
    }
  } finally {
    await closeDb(db);
  }
}
