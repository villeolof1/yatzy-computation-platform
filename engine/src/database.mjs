import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ensureDir } from './util/fs.mjs';

export function openRunDatabase(runDir) {
  ensureDir(runDir);
  const db = new DatabaseSync(path.join(runDir, 'run.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      completed_units REAL NOT NULL DEFAULT 0,
      total_units REAL NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      active_ms INTEGER NOT NULL DEFAULT 0,
      detail_json TEXT NOT NULL DEFAULT '{}',
      error_json TEXT
    );
    CREATE TABLE IF NOT EXISTS layers (
      layer INTEGER PRIMARY KEY,
      state_count INTEGER NOT NULL,
      completed_states INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      completed_chunks INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      checksum TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      build_id TEXT NOT NULL,
      layer INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      start_pos INTEGER NOT NULL,
      state_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      checksum TEXT,
      duration_ms INTEGER,
      aggregate_json TEXT,
      completed_at TEXT,
      PRIMARY KEY(build_id, layer, ordinal)
    );
    CREATE TABLE IF NOT EXISTS verification_checks (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      required INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS simulation_runs (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      game_count INTEGER NOT NULL,
      completed_games INTEGER NOT NULL DEFAULT 0,
      seed TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      output_path TEXT,
      summary_json TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS simulation_batches (
      simulation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      start_game INTEGER NOT NULL,
      game_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      checksum TEXT,
      duration_ms INTEGER,
      aggregate_json TEXT,
      trace_path TEXT,
      PRIMARY KEY(simulation_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER,
      sha256 TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      level TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

export function setMeta(db, key, value) {
  db.prepare(`INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
}
export function getMeta(db, key, fallback = null) {
  const row = db.prepare(`SELECT value FROM metadata WHERE key=?`).get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function addEvent(db, level, code, message, detail = {}) {
  db.prepare(`INSERT INTO events(created_at,level,code,message,detail_json) VALUES (?,?,?,?,?)`).run(new Date().toISOString(), level, code, message, JSON.stringify(detail));
}
export function checkpointDb(db) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
