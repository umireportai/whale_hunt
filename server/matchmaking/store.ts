import type { DatabaseSync } from 'node:sqlite';
import type { HuntQueueStatus } from '../../shared/hunt.js';

export type MatchmakingRole = 'whale' | 'tracer';
export type BotPersonality =
  'flow-analyst' | 'timing-analyst' | 'concentration-analyst' | 'skeptic' | 'coordinator';

export interface HuntQueueRow {
  readonly queue_id: string;
  readonly player_id: string;
  readonly role: MatchmakingRole;
  readonly max_tracers: 1 | 5;
  readonly status: HuntQueueStatus;
  readonly play_computers_now: number;
  readonly queued_at: string;
  readonly status_version: number;
  readonly match_id: string | null;
  readonly room_code: string | null;
  readonly cancelled_at: string | null;
}

export interface HuntQueueCommandRow {
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly operation: 'enqueue' | 'cancel';
  readonly queue_id: string;
  readonly payload: string;
  readonly response: string;
  readonly created_at: string;
}

export interface HuntBotStateRow {
  readonly match_id: string;
  readonly participant_id: string;
  readonly seed: string;
  readonly difficulty: 'standard';
  readonly personality: BotPersonality;
  readonly decision_index: number;
  readonly primary_units: number;
  readonly secondary_units: number;
  readonly decoy_units: number;
  readonly last_command_key: string | null;
}

/** Creates the queue and computer-opponent state tables. */
export function initializeMatchmakingDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hunt_queue_entries (
      queue_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('whale','tracer')),
      max_tracers INTEGER NOT NULL CHECK(max_tracers IN (1,5)),
      status TEXT NOT NULL CHECK(status IN ('queued','matched','cancelled','expired')),
      play_computers_now INTEGER NOT NULL CHECK(play_computers_now IN (0,1)),
      queued_at TEXT NOT NULL,
      status_version INTEGER NOT NULL,
      match_id TEXT,
      room_code TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS hunt_queue_waiting
      ON hunt_queue_entries(max_tracers,status,queued_at,queue_id);
    CREATE UNIQUE INDEX IF NOT EXISTS hunt_queue_one_active_player
      ON hunt_queue_entries(player_id) WHERE status='queued';
    CREATE TABLE IF NOT EXISTS hunt_queue_commands (
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('enqueue','cancel')),
      queue_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS hunt_bot_state (
      match_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      seed TEXT NOT NULL,
      difficulty TEXT NOT NULL CHECK(difficulty IN ('standard')),
      personality TEXT NOT NULL CHECK(personality IN ('flow-analyst','timing-analyst','concentration-analyst','skeptic','coordinator')),
      decision_index INTEGER NOT NULL,
      primary_units INTEGER NOT NULL,
      secondary_units INTEGER NOT NULL,
      decoy_units INTEGER NOT NULL,
      last_command_key TEXT,
      PRIMARY KEY(match_id,participant_id)
    );
  `);
}

export function readHuntQueueEntry(db: DatabaseSync, queueId: string): HuntQueueRow | undefined {
  return db
    .prepare(
      `SELECT queue_id,player_id,role,max_tracers,status,play_computers_now,
              queued_at,status_version,match_id,room_code,cancelled_at
       FROM hunt_queue_entries WHERE queue_id=?`,
    )
    .get(queueId) as unknown as HuntQueueRow | undefined;
}

export function readWaitingHuntQueue(db: DatabaseSync): HuntQueueRow[] {
  return db
    .prepare(
      `SELECT queue_id,player_id,role,max_tracers,status,play_computers_now,
              queued_at,status_version,match_id,room_code,cancelled_at
       FROM hunt_queue_entries WHERE status='queued'
       ORDER BY queued_at,queue_id`,
    )
    .all() as unknown as HuntQueueRow[];
}

export function readActiveHuntQueueForPlayer(
  db: DatabaseSync,
  playerId: string,
): HuntQueueRow | undefined {
  return db
    .prepare(
      `SELECT queue_id,player_id,role,max_tracers,status,play_computers_now,
              queued_at,status_version,match_id,room_code,cancelled_at
       FROM hunt_queue_entries WHERE player_id=? AND status='queued' LIMIT 1`,
    )
    .get(playerId) as unknown as HuntQueueRow | undefined;
}

export function insertHuntQueueEntry(db: DatabaseSync, row: HuntQueueRow): void {
  db.prepare(
    `INSERT INTO hunt_queue_entries
      (queue_id,player_id,role,max_tracers,status,play_computers_now,queued_at,
       status_version,match_id,room_code,cancelled_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.queue_id,
    row.player_id,
    row.role,
    row.max_tracers,
    row.status,
    row.play_computers_now,
    row.queued_at,
    row.status_version,
    row.match_id,
    row.room_code,
    row.cancelled_at,
  );
}

export function updateHuntQueueEntry(db: DatabaseSync, row: HuntQueueRow): void {
  db.prepare(
    `UPDATE hunt_queue_entries SET status=?,status_version=?,match_id=?,room_code=?,cancelled_at=?
     WHERE queue_id=?`,
  ).run(
    row.status,
    row.status_version,
    row.match_id,
    row.room_code,
    row.cancelled_at,
    row.queue_id,
  );
}

export function readHuntQueueCommand(
  db: DatabaseSync,
  actorId: string,
  idempotencyKey: string,
): HuntQueueCommandRow | undefined {
  return db
    .prepare(
      `SELECT actor_id,idempotency_key,operation,queue_id,payload,response,created_at
       FROM hunt_queue_commands WHERE actor_id=? AND idempotency_key=?`,
    )
    .get(actorId, idempotencyKey) as unknown as HuntQueueCommandRow | undefined;
}

export function insertHuntQueueCommand(db: DatabaseSync, row: HuntQueueCommandRow): void {
  db.prepare(
    `INSERT INTO hunt_queue_commands
      (actor_id,idempotency_key,operation,queue_id,payload,response,created_at)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(
    row.actor_id,
    row.idempotency_key,
    row.operation,
    row.queue_id,
    row.payload,
    row.response,
    row.created_at,
  );
}

export function readHuntBotState(
  db: DatabaseSync,
  matchId: string,
  participantId: string,
): HuntBotStateRow | undefined {
  return db
    .prepare(
      `SELECT match_id,participant_id,seed,difficulty,personality,decision_index,
              primary_units,secondary_units,decoy_units,last_command_key
       FROM hunt_bot_state WHERE match_id=? AND participant_id=?`,
    )
    .get(matchId, participantId) as unknown as HuntBotStateRow | undefined;
}

export function readHuntBotStates(db: DatabaseSync, matchId: string): HuntBotStateRow[] {
  return db
    .prepare(
      `SELECT match_id,participant_id,seed,difficulty,personality,decision_index,
              primary_units,secondary_units,decoy_units,last_command_key
       FROM hunt_bot_state WHERE match_id=? ORDER BY participant_id`,
    )
    .all(matchId) as unknown as HuntBotStateRow[];
}

export function insertHuntBotState(db: DatabaseSync, row: HuntBotStateRow): void {
  db.prepare(
    `INSERT INTO hunt_bot_state
      (match_id,participant_id,seed,difficulty,personality,decision_index,
       primary_units,secondary_units,decoy_units,last_command_key)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.participant_id,
    row.seed,
    row.difficulty,
    row.personality,
    row.decision_index,
    row.primary_units,
    row.secondary_units,
    row.decoy_units,
    row.last_command_key,
  );
}

export function updateHuntBotState(db: DatabaseSync, row: HuntBotStateRow): void {
  db.prepare(
    `UPDATE hunt_bot_state SET decision_index=?,primary_units=?,secondary_units=?,
       decoy_units=?,last_command_key=? WHERE match_id=? AND participant_id=?`,
  ).run(
    row.decision_index,
    row.primary_units,
    row.secondary_units,
    row.decoy_units,
    row.last_command_key,
    row.match_id,
    row.participant_id,
  );
}
