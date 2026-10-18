import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, settingDefaults } from './config.js';

export const db = new DatabaseSync(path.join(config.configDir, 'streamarr.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('movies','shows','other')),
  paths TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_scan INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  type TEXT NOT NULL,              -- movie | show | season | episode | video
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  show_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  path_key TEXT,                   -- folder path for shows, file path for playables
  title TEXT NOT NULL,
  sort_title TEXT,
  original_title TEXT,
  year INTEGER,
  overview TEXT,
  tagline TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  rating REAL,
  runtime INTEGER,
  season_number INTEGER,
  episode_number INTEGER,
  premiere_date TEXT,
  poster TEXT,
  backdrop TEXT,
  thumb TEXT,
  logo TEXT,
  cast_json TEXT NOT NULL DEFAULT '[]',
  tmdb_id INTEGER,
  metadata_state TEXT NOT NULL DEFAULT 'pending', -- pending | done | none
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_library ON items(library_id, type);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_show ON items(show_id);
CREATE INDEX IF NOT EXISTS idx_items_added ON items(added_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_pathkey ON items(library_id, type, path_key) WHERE path_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  container TEXT,
  duration REAL,
  bitrate INTEGER,
  video TEXT,          -- JSON
  audio TEXT NOT NULL DEFAULT '[]',
  subtitles TEXT NOT NULL DEFAULT '[]',
  chapters TEXT NOT NULL DEFAULT '[]',
  trickplay TEXT,      -- JSON: { interval, cols, rows, width, height, sheets }
  probed_at INTEGER
);

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  watched INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id, updated_at);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  mode TEXT,
  started_at INTEGER NOT NULL,
  stalls INTEGER NOT NULL DEFAULT 0,
  client TEXT
);
`);

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export const all = (sql, ...params) => stmt(sql).all(...params);
export const get = (sql, ...params) => stmt(sql).get(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- Settings ----
let settingsCache = null;
export function getSettings() {
  if (!settingsCache) {
    const rows = all('SELECT key, value FROM settings');
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    settingsCache = { ...settingDefaults, ...stored };
  }
  return settingsCache;
}
export function setSettings(patch) {
  tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
    }
  });
  settingsCache = null;
  return getSettings();
}

export function getSecret() {
  const row = get("SELECT value FROM settings WHERE key = '_secret'");
  if (row) return JSON.parse(row.value);
  const secret = crypto.randomBytes(48).toString('base64url');
  run("INSERT INTO settings (key, value) VALUES ('_secret', ?)", JSON.stringify(secret));
  return secret;
}

export const json = (v, fallback = null) => {
  if (v == null) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
