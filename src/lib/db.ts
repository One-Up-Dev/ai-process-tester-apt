import { Database } from "bun:sqlite";

let _db: Database | null = null;

export function getDatabase(path?: string): Database {
  if (!_db) {
    _db = new Database(path ?? "apt.db");
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function createTestDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
