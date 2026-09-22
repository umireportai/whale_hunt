import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { initializeHuntDatabase } from './hunt.js';
import { initializeHuntV2Database } from './hunt-v2.js';
import { initializeSignalHuntDatabase } from './signal-hunt.js';
import { initializeMatchmakingDatabase } from '../matchmaking/store.js';
import { initializeProgressionDatabase } from './progression.js';

export const SCHEMA_VERSION = 2;

/** Ordered database setup shared by the API and migration CLI. */
export function initializeGameDatabases(db: DatabaseSync): void {
  initializeHuntDatabase(db);
  initializeHuntV2Database(db);
  initializeSignalHuntDatabase(db);
  initializeMatchmakingDatabase(db);
  initializeProgressionDatabase(db);
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error('This database requires a newer Whale Hunt release.');
  }
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    transaction(db, () => {
      const migrationVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      if (migrationVersion > SCHEMA_VERSION)
        throw new Error('This database requires a newer Whale Hunt release.');
      db.exec(
        'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
      );
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  initializeGameDatabases(db);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
