import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface StoredRoom {
  code: string;
  state_json: string;
  created_at: number;
  expires_at: number;
  projector_token: string;
}

declare global {
  var deadlineDatabases: Map<string, Database.Database> | undefined;
}

export function getDatabase(): Database.Database {
  const filename = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'game.sqlite');
  const databases = globalThis.deadlineDatabases ??= new Map();
  const existing = databases.get(filename);
  if (existing) return existing;
  if (filename !== ':memory:') {
    const runtimeDirectory = path.dirname(filename);
    // This directory is writable runtime data, never an input to the deployment bundle.
    mkdirSync(/* turbopackIgnore: true */ runtimeDirectory, { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      projector_token TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('host', 'player')),
      actor_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_code, actor_kind, actor_id)
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('host', 'player')),
      actor_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      single_use INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (room_code, actor_kind, actor_id)
    );
    CREATE TABLE IF NOT EXISTS command_receipts (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      actor_key TEXT NOT NULL,
      action_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_code, actor_key, action_id)
    );
    CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at);
    PRAGMA user_version = 1;
  `);
  const columns = db.pragma('table_info(credentials)') as { name: string }[];
  if (!columns.some(column => column.name === 'last_seen_at')) db.exec('ALTER TABLE credentials ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
  databases.set(filename, db);
  return db;
}

export function closeDatabases(): void {
  for (const database of globalThis.deadlineDatabases?.values() ?? []) database.close();
  globalThis.deadlineDatabases?.clear();
}

export function readStoredRoom(db: Database.Database, code: string): StoredRoom | undefined {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as StoredRoom | undefined;
}

export function saveRoom(db: Database.Database, code: string, state: unknown): void {
  db.prepare('UPDATE rooms SET state_json = ? WHERE code = ?').run(JSON.stringify(state), code);
}
