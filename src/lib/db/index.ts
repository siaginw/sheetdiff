import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "sheetdiff.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const globalForDb = globalThis as unknown as { __sheetdiffDb?: ReturnType<typeof createDb> };

function createDb() {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 30000"); // shared-volume contention: wait, don't throw
  return drizzle(sqlite, { schema });
}

export const db = globalForDb.__sheetdiffDb ?? createDb();
if (!globalForDb.__sheetdiffDb) globalForDb.__sheetdiffDb = db;
