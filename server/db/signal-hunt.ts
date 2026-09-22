import type { DatabaseSync } from 'node:sqlite';

export interface SignalHuntAttemptRow {
  attempt_id: string;
  player_id: string;
  case_id: string;
  phase: string;
  state_version: number;
  scans_payload: string;
  selected_asset_id: string | null;
  result_payload: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SignalHuntCommandRow {
  attempt_id: string;
  idempotency_key: string;
  actor_id: string;
  payload: string;
  response: string;
  created_at: string;
}

export function initializeSignalHuntDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_hunt_attempts (
      attempt_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('investigate','result')),
      state_version INTEGER NOT NULL,
      scans_payload TEXT NOT NULL,
      selected_asset_id TEXT,
      result_payload TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS signal_hunt_commands (
      attempt_id TEXT NOT NULL REFERENCES signal_hunt_attempts(attempt_id),
      idempotency_key TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(attempt_id, idempotency_key)
    );
  `);
}

export function readSignalHuntAttempt(
  db: DatabaseSync,
  attemptId: string,
): SignalHuntAttemptRow | undefined {
  return db
    .prepare(
      `SELECT attempt_id,player_id,case_id,phase,state_version,scans_payload,
              selected_asset_id,result_payload,created_at,completed_at
       FROM signal_hunt_attempts WHERE attempt_id=?`,
    )
    .get(attemptId) as unknown as SignalHuntAttemptRow | undefined;
}

export function insertSignalHuntAttempt(db: DatabaseSync, row: SignalHuntAttemptRow): void {
  db.prepare(
    `INSERT INTO signal_hunt_attempts
      (attempt_id,player_id,case_id,phase,state_version,scans_payload,selected_asset_id,
       result_payload,created_at,completed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.attempt_id,
    row.player_id,
    row.case_id,
    row.phase,
    row.state_version,
    row.scans_payload,
    row.selected_asset_id,
    row.result_payload,
    row.created_at,
    row.completed_at,
  );
}

export function updateSignalHuntAttempt(db: DatabaseSync, row: SignalHuntAttemptRow): void {
  db.prepare(
    `UPDATE signal_hunt_attempts SET phase=?,state_version=?,scans_payload=?,
       selected_asset_id=?,result_payload=?,completed_at=? WHERE attempt_id=?`,
  ).run(
    row.phase,
    row.state_version,
    row.scans_payload,
    row.selected_asset_id,
    row.result_payload,
    row.completed_at,
    row.attempt_id,
  );
}

export function readSignalHuntCommand(
  db: DatabaseSync,
  attemptId: string,
  idempotencyKey: string,
): SignalHuntCommandRow | undefined {
  return db
    .prepare(
      `SELECT attempt_id,idempotency_key,actor_id,payload,response,created_at
       FROM signal_hunt_commands WHERE attempt_id=? AND idempotency_key=?`,
    )
    .get(attemptId, idempotencyKey) as unknown as SignalHuntCommandRow | undefined;
}

export function insertSignalHuntCommand(db: DatabaseSync, row: SignalHuntCommandRow): void {
  db.prepare(
    `INSERT INTO signal_hunt_commands(attempt_id,idempotency_key,actor_id,payload,response,created_at)
     VALUES(?,?,?,?,?,?)`,
  ).run(
    row.attempt_id,
    row.idempotency_key,
    row.actor_id,
    row.payload,
    row.response,
    row.created_at,
  );
}
