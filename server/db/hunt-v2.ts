import type { DatabaseSync } from 'node:sqlite';

export interface HuntV2MatchRow {
  match_id: string;
  player_id: string;
  opponent_id: string;
  player_role: 'whale' | 'tracer';
  phase: string;
  round_index: number;
  state_version: number;
  deadline_at: string | null;
  rounds_payload: string;
  score_whale: number;
  score_tracer: number;
  created_at: string;
  completed_at: string | null;
}

export interface HuntV2CommandRow {
  match_id: string;
  idempotency_key: string;
  actor_id: string;
  payload: string;
  response: string;
  created_at: string;
}

export function initializeHuntV2Database(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hunt_v2_matches (
      match_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      opponent_id TEXT NOT NULL,
      player_role TEXT NOT NULL CHECK(player_role IN ('whale','tracer')),
      phase TEXT NOT NULL CHECK(phase IN ('round_intro','whale_hide','tracer_hunt','round_reveal','match_over')),
      round_index INTEGER NOT NULL CHECK(round_index BETWEEN 1 AND 5),
      state_version INTEGER NOT NULL,
      deadline_at TEXT,
      rounds_payload TEXT NOT NULL,
      score_whale INTEGER NOT NULL DEFAULT 0,
      score_tracer INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS hunt_v2_commands (
      match_id TEXT NOT NULL REFERENCES hunt_v2_matches(match_id),
      idempotency_key TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(match_id, idempotency_key)
    );
  `);
}

export function readHuntV2Match(db: DatabaseSync, matchId: string): HuntV2MatchRow | undefined {
  return db
    .prepare(
      `SELECT match_id,player_id,opponent_id,player_role,phase,round_index,state_version,
              deadline_at,rounds_payload,score_whale,score_tracer,created_at,completed_at
       FROM hunt_v2_matches WHERE match_id=?`,
    )
    .get(matchId) as unknown as HuntV2MatchRow | undefined;
}

export function readActiveHuntV2Matches(db: DatabaseSync): HuntV2MatchRow[] {
  return db
    .prepare(
      "SELECT match_id,player_id,opponent_id,player_role,phase,round_index,state_version,deadline_at,rounds_payload,score_whale,score_tracer,created_at,completed_at FROM hunt_v2_matches WHERE phase <> 'match_over'",
    )
    .all() as unknown as HuntV2MatchRow[];
}

export function insertHuntV2Match(db: DatabaseSync, row: HuntV2MatchRow): void {
  db.prepare(
    `INSERT INTO hunt_v2_matches
      (match_id,player_id,opponent_id,player_role,phase,round_index,state_version,deadline_at,
       rounds_payload,score_whale,score_tracer,created_at,completed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.player_id,
    row.opponent_id,
    row.player_role,
    row.phase,
    row.round_index,
    row.state_version,
    row.deadline_at,
    row.rounds_payload,
    row.score_whale,
    row.score_tracer,
    row.created_at,
    row.completed_at,
  );
}

export function updateHuntV2Match(db: DatabaseSync, row: HuntV2MatchRow): void {
  db.prepare(
    `UPDATE hunt_v2_matches SET opponent_id=?,phase=?,round_index=?,state_version=?,deadline_at=?,
       rounds_payload=?,score_whale=?,score_tracer=?,completed_at=? WHERE match_id=?`,
  ).run(
    row.opponent_id,
    row.phase,
    row.round_index,
    row.state_version,
    row.deadline_at,
    row.rounds_payload,
    row.score_whale,
    row.score_tracer,
    row.completed_at,
    row.match_id,
  );
}

export function readHuntV2Command(
  db: DatabaseSync,
  matchId: string,
  idempotencyKey: string,
): HuntV2CommandRow | undefined {
  return db
    .prepare(
      `SELECT match_id,idempotency_key,actor_id,payload,response,created_at
       FROM hunt_v2_commands WHERE match_id=? AND idempotency_key=?`,
    )
    .get(matchId, idempotencyKey) as unknown as HuntV2CommandRow | undefined;
}

export function insertHuntV2Command(db: DatabaseSync, row: HuntV2CommandRow): void {
  db.prepare(
    `INSERT INTO hunt_v2_commands(match_id,idempotency_key,actor_id,payload,response,created_at)
     VALUES(?,?,?,?,?,?)`,
  ).run(row.match_id, row.idempotency_key, row.actor_id, row.payload, row.response, row.created_at);
}
