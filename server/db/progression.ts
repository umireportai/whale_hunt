import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './store.js';

export type ProgressionHuntRole = 'whale' | 'tracer' | 'captain';
export type ProgressionMatchKind = 'human' | 'computer' | 'substituted';

export interface ProgressionHuntRow {
  readonly match_id: string;
  readonly player_id: string;
  readonly completed_at: string;
  readonly role: ProgressionHuntRole;
  readonly won: number;
  readonly rules_version: 'hunt-v1';
  readonly match_kind: ProgressionMatchKind;
  readonly max_tracers: 1 | 5;
  readonly final_pair_correct: number;
  readonly correct_pair_before_final: number;
  readonly final_includes_decoy: number;
  readonly finalized_payload: string;
  readonly created_at: string;
}

export interface ProgressionBadgeRow {
  readonly player_id: string;
  readonly badge_id: string;
  readonly earned_at: string;
}

export interface ProgressionShareRow {
  readonly share_id: string;
  readonly owner_player_id: string;
  readonly activity: 'hunt';
  readonly created_at: string;
  readonly public_payload: string;
  readonly target_match_id: string | null;
  readonly role_swap: number;
  readonly practice_only: number;
}

/** Creates the Whale Hunt progression tables. */
export function initializeProgressionDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS progression_hunt_results (
      match_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('whale','tracer','captain')),
      won INTEGER NOT NULL CHECK(won IN (0,1)),
      rules_version TEXT NOT NULL CHECK(rules_version='hunt-v1'),
      match_kind TEXT NOT NULL CHECK(match_kind IN ('human','computer','substituted')),
      max_tracers INTEGER NOT NULL CHECK(max_tracers IN (1,5)),
      final_pair_correct INTEGER NOT NULL CHECK(final_pair_correct IN (0,1)),
      correct_pair_before_final INTEGER NOT NULL CHECK(correct_pair_before_final IN (0,1)),
      final_includes_decoy INTEGER NOT NULL CHECK(final_includes_decoy IN (0,1)),
      finalized_payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(match_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS progression_hunt_player_history
      ON progression_hunt_results(player_id, completed_at DESC);
    CREATE TABLE IF NOT EXISTS progression_badges (
      player_id TEXT NOT NULL,
      badge_id TEXT NOT NULL,
      earned_at TEXT NOT NULL,
      PRIMARY KEY(player_id, badge_id)
    );
    CREATE TABLE IF NOT EXISTS progression_shares (
      share_id TEXT PRIMARY KEY,
      owner_player_id TEXT NOT NULL,
      activity TEXT NOT NULL CHECK(activity IN ('hunt')),
      created_at TEXT NOT NULL,
      public_payload TEXT NOT NULL,
      target_match_id TEXT,
      role_swap INTEGER NOT NULL CHECK(role_swap IN (0,1)),
      practice_only INTEGER NOT NULL CHECK(practice_only IN (0,1))
    );
  `);
}

export const migrateProgressionDatabase = initializeProgressionDatabase;

export function readProgressionHuntResult(
  db: DatabaseSync,
  matchId: string,
  playerId: string,
): ProgressionHuntRow | undefined {
  return db
    .prepare(
      `SELECT match_id,player_id,completed_at,role,won,rules_version,match_kind,max_tracers,
              final_pair_correct,correct_pair_before_final,final_includes_decoy,finalized_payload,created_at
       FROM progression_hunt_results WHERE match_id=? AND player_id=?`,
    )
    .get(matchId, playerId) as unknown as ProgressionHuntRow | undefined;
}

export function readProgressionHuntResults(
  db: DatabaseSync,
  playerId: string,
): ProgressionHuntRow[] {
  return db
    .prepare(
      `SELECT match_id,player_id,completed_at,role,won,rules_version,match_kind,max_tracers,
              final_pair_correct,correct_pair_before_final,final_includes_decoy,finalized_payload,created_at
       FROM progression_hunt_results WHERE player_id=?
       ORDER BY completed_at DESC,match_id`,
    )
    .all(playerId) as unknown as ProgressionHuntRow[];
}

export function insertProgressionHuntResult(db: DatabaseSync, row: ProgressionHuntRow): void {
  db.prepare(
    `INSERT INTO progression_hunt_results
      (match_id,player_id,completed_at,role,won,rules_version,match_kind,max_tracers,
       final_pair_correct,correct_pair_before_final,final_includes_decoy,finalized_payload,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.player_id,
    row.completed_at,
    row.role,
    row.won,
    row.rules_version,
    row.match_kind,
    row.max_tracers,
    row.final_pair_correct,
    row.correct_pair_before_final,
    row.final_includes_decoy,
    row.finalized_payload,
    row.created_at,
  );
}

export function readProgressionBadges(db: DatabaseSync, playerId: string): ProgressionBadgeRow[] {
  return db
    .prepare(
      'SELECT player_id,badge_id,earned_at FROM progression_badges WHERE player_id=? ORDER BY earned_at,badge_id',
    )
    .all(playerId) as unknown as ProgressionBadgeRow[];
}

export function insertProgressionBadge(db: DatabaseSync, row: ProgressionBadgeRow): boolean {
  return (
    db
      .prepare(
        'INSERT OR IGNORE INTO progression_badges(player_id,badge_id,earned_at) VALUES(?,?,?)',
      )
      .run(row.player_id, row.badge_id, row.earned_at).changes === 1
  );
}

export function insertProgressionShare(db: DatabaseSync, row: ProgressionShareRow): void {
  db.prepare(
    `INSERT INTO progression_shares
      (share_id,owner_player_id,activity,created_at,public_payload,target_match_id,role_swap,practice_only)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    row.share_id,
    row.owner_player_id,
    row.activity,
    row.created_at,
    row.public_payload,
    row.target_match_id,
    row.role_swap,
    row.practice_only,
  );
}

export function readProgressionShare(
  db: DatabaseSync,
  shareId: string,
): ProgressionShareRow | undefined {
  return db
    .prepare(
      `SELECT share_id,owner_player_id,activity,created_at,public_payload,target_match_id,
              role_swap,practice_only
       FROM progression_shares WHERE share_id=?`,
    )
    .get(shareId) as unknown as ProgressionShareRow | undefined;
}

export function progressionTransaction<T>(db: DatabaseSync, action: () => T): T {
  return transaction(db, action);
}
