import type { Database } from "bun:sqlite";
import * as migration001 from "./migrations/001_initial_schema";

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const migrations: Migration[] = [migration001];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = db.query("SELECT version FROM _migrations ORDER BY version").all() as Array<{
    version: number;
  }>;
  const appliedVersions = new Set(applied.map((m) => m.version));

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)").run(
          migration.version,
          migration.name,
        );
      })();
    }
  }
}
