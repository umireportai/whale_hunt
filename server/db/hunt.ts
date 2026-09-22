import type { DatabaseSync } from 'node:sqlite';
import type { HuntPhase, ParticipantKind, ConnectionState } from '../../shared/hunt.js';
import { transaction } from './store.js';

export interface HuntRoomRow {
  room_id: string;
  room_code: string;
  max_tracers: 1 | 5;
  phase: 'lobby' | 'setup';
  state_version: number;
  match_id: string | null;
  deadline_at: string | null;
  created_at: string;
}

export interface HuntParticipantRow {
  match_id: string;
  participant_id: string;
  display_name: string;
  role: 'whale' | 'tracer';
  kind: ParticipantKind;
  connection: ConnectionState;
  is_captain: number;
  reconnect_until: string;
}

export interface HuntMatchRow {
  match_id: string;
  room_id: string;
  room_code: string;
  max_tracers: 1 | 5;
  phase: HuntPhase;
  round_index: number;
  state_version: number;
  deadline_at: string;
  reconnect_until: string;
  board_payload: string;
  targets_payload: string;
  plans_payload: string;
  purchases_payload: string;
  scans_payload: string;
  pinned_payload: string;
  suspicions_payload: string;
  final_accusation: string | null;
  reveal_payload: string | null;
  scores_payload: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface HuntCommandRow {
  match_id: string;
  idempotency_key: string;
  actor_id: string;
  kind: string;
  payload: string;
  response: string;
  created_at: string;
}

export interface HuntRoomCommandRow {
  actor_id: string;
  idempotency_key: string;
  operation: string;
  room_id: string;
  payload: string;
  response: string;
  created_at: string;
}

export interface HuntEventRow {
  match_id: string;
  event_index: number;
  round_index: number;
  kind: string;
  visibility: 'shared' | 'private-whale' | 'private-tracer' | 'system';
  actor_id: string | null;
  payload: string;
  created_at: string;
}

/** Creates the persistent Hunt tables. */
export function initializeHuntDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hunt_rooms (
      room_id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL UNIQUE,
      max_tracers INTEGER NOT NULL CHECK(max_tracers IN (1,5)),
      phase TEXT NOT NULL CHECK(phase IN ('lobby','setup')),
      state_version INTEGER NOT NULL,
      match_id TEXT,
      deadline_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hunt_matches (
      match_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL UNIQUE REFERENCES hunt_rooms(room_id),
      room_code TEXT NOT NULL,
      max_tracers INTEGER NOT NULL CHECK(max_tracers IN (1,5)),
      phase TEXT NOT NULL CHECK(phase IN ('lobby','setup','whale-planning','tracer-investigation','round-complete','final-accusation','reveal','finished','voided')),
      round_index INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      deadline_at TEXT NOT NULL,
      reconnect_until TEXT NOT NULL,
      board_payload TEXT NOT NULL,
      targets_payload TEXT NOT NULL,
      plans_payload TEXT NOT NULL,
      purchases_payload TEXT NOT NULL,
      scans_payload TEXT NOT NULL,
      pinned_payload TEXT NOT NULL,
      suspicions_payload TEXT NOT NULL,
      final_accusation TEXT,
      reveal_payload TEXT,
      scores_payload TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS hunt_participants (
      match_id TEXT NOT NULL REFERENCES hunt_matches(match_id),
      participant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('whale','tracer')),
      kind TEXT NOT NULL CHECK(kind IN ('human','computer')),
      connection TEXT NOT NULL CHECK(connection IN ('connected','reconnecting','disconnected','substituted')),
      is_captain INTEGER NOT NULL CHECK(is_captain IN (0,1)),
      reconnect_until TEXT NOT NULL,
      PRIMARY KEY(match_id, participant_id)
    );
    CREATE INDEX IF NOT EXISTS hunt_participants_by_role
      ON hunt_participants(match_id, role, is_captain);
    CREATE TABLE IF NOT EXISTS hunt_commands (
      match_id TEXT NOT NULL REFERENCES hunt_matches(match_id),
      idempotency_key TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(match_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS hunt_room_commands (
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      room_id TEXT NOT NULL REFERENCES hunt_rooms(room_id),
      payload TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS hunt_events (
      match_id TEXT NOT NULL REFERENCES hunt_matches(match_id),
      event_index INTEGER NOT NULL,
      round_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('shared','private-whale','private-tracer','system')),
      actor_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(match_id, event_index)
    );
    CREATE INDEX IF NOT EXISTS hunt_events_by_visibility
      ON hunt_events(match_id, visibility, event_index);
  `);
}

/** Migration alias for startup coordinators that order feature migrations explicitly. */
export const migrateHuntDatabase = initializeHuntDatabase;

export function readHuntRoom(db: DatabaseSync, roomCodeOrId: string): HuntRoomRow | undefined {
  return db
    .prepare(
      `SELECT room_id,room_code,max_tracers,phase,state_version,match_id,deadline_at,created_at
       FROM hunt_rooms WHERE room_id=? OR room_code=?`,
    )
    .get(roomCodeOrId, roomCodeOrId) as unknown as HuntRoomRow | undefined;
}

export function insertHuntRoom(db: DatabaseSync, row: HuntRoomRow): void {
  db.prepare(
    `INSERT INTO hunt_rooms(room_id,room_code,max_tracers,phase,state_version,match_id,deadline_at,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    row.room_id,
    row.room_code,
    row.max_tracers,
    row.phase,
    row.state_version,
    row.match_id,
    row.deadline_at,
    row.created_at,
  );
}

export function updateHuntRoom(db: DatabaseSync, row: HuntRoomRow): void {
  db.prepare(
    `UPDATE hunt_rooms SET phase=?,state_version=?,match_id=?,deadline_at=?
     WHERE room_id=?`,
  ).run(row.phase, row.state_version, row.match_id, row.deadline_at, row.room_id);
}

export function readHuntRoomCommand(
  db: DatabaseSync,
  actorId: string,
  idempotencyKey: string,
): HuntRoomCommandRow | undefined {
  return db
    .prepare(
      `SELECT actor_id,idempotency_key,operation,room_id,payload,response,created_at
       FROM hunt_room_commands WHERE actor_id=? AND idempotency_key=?`,
    )
    .get(actorId, idempotencyKey) as unknown as HuntRoomCommandRow | undefined;
}

export function insertHuntRoomCommand(db: DatabaseSync, row: HuntRoomCommandRow): void {
  db.prepare(
    `INSERT INTO hunt_room_commands(actor_id,idempotency_key,operation,room_id,payload,response,created_at)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(
    row.actor_id,
    row.idempotency_key,
    row.operation,
    row.room_id,
    row.payload,
    row.response,
    row.created_at,
  );
}

export function readHuntParticipants(db: DatabaseSync, matchId: string): HuntParticipantRow[] {
  return db
    .prepare(
      `SELECT match_id,participant_id,display_name,role,kind,connection,is_captain,reconnect_until
       FROM hunt_participants WHERE match_id=? ORDER BY role DESC,is_captain DESC,participant_id`,
    )
    .all(matchId) as unknown as HuntParticipantRow[];
}

export function insertHuntParticipant(db: DatabaseSync, row: HuntParticipantRow): void {
  db.prepare(
    `INSERT INTO hunt_participants
      (match_id,participant_id,display_name,role,kind,connection,is_captain,reconnect_until)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.participant_id,
    row.display_name,
    row.role,
    row.kind,
    row.connection,
    row.is_captain,
    row.reconnect_until,
  );
}

export function readHuntMatch(db: DatabaseSync, matchId: string): HuntMatchRow | undefined {
  return db
    .prepare(
      `SELECT match_id,room_id,room_code,max_tracers,phase,round_index,state_version,
              deadline_at,reconnect_until,board_payload,targets_payload,plans_payload,
              purchases_payload,scans_payload,pinned_payload,suspicions_payload,
              final_accusation,reveal_payload,scores_payload,created_at,completed_at
       FROM hunt_matches WHERE match_id=?`,
    )
    .get(matchId) as unknown as HuntMatchRow | undefined;
}

export function insertHuntMatch(db: DatabaseSync, row: HuntMatchRow): void {
  db.prepare(
    `INSERT INTO hunt_matches
      (match_id,room_id,room_code,max_tracers,phase,round_index,state_version,deadline_at,
       reconnect_until,board_payload,targets_payload,plans_payload,purchases_payload,
       scans_payload,pinned_payload,suspicions_payload,final_accusation,reveal_payload,
       scores_payload,created_at,completed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.room_id,
    row.room_code,
    row.max_tracers,
    row.phase,
    row.round_index,
    row.state_version,
    row.deadline_at,
    row.reconnect_until,
    row.board_payload,
    row.targets_payload,
    row.plans_payload,
    row.purchases_payload,
    row.scans_payload,
    row.pinned_payload,
    row.suspicions_payload,
    row.final_accusation,
    row.reveal_payload,
    row.scores_payload,
    row.created_at,
    row.completed_at,
  );
}

export function updateHuntMatch(db: DatabaseSync, row: HuntMatchRow): void {
  db.prepare(
    `UPDATE hunt_matches SET phase=?,round_index=?,state_version=?,deadline_at=?,
       reconnect_until=?,board_payload=?,targets_payload=?,plans_payload=?,purchases_payload=?,
       scans_payload=?,pinned_payload=?,suspicions_payload=?,final_accusation=?,
       reveal_payload=?,scores_payload=?,completed_at=? WHERE match_id=?`,
  ).run(
    row.phase,
    row.round_index,
    row.state_version,
    row.deadline_at,
    row.reconnect_until,
    row.board_payload,
    row.targets_payload,
    row.plans_payload,
    row.purchases_payload,
    row.scans_payload,
    row.pinned_payload,
    row.suspicions_payload,
    row.final_accusation,
    row.reveal_payload,
    row.scores_payload,
    row.completed_at,
    row.match_id,
  );
}

export function readHuntCommand(
  db: DatabaseSync,
  matchId: string,
  idempotencyKey: string,
): HuntCommandRow | undefined {
  return db
    .prepare(
      `SELECT match_id,idempotency_key,actor_id,kind,payload,response,created_at
       FROM hunt_commands WHERE match_id=? AND idempotency_key=?`,
    )
    .get(matchId, idempotencyKey) as unknown as HuntCommandRow | undefined;
}

export function insertHuntCommand(db: DatabaseSync, row: HuntCommandRow): void {
  db.prepare(
    `INSERT INTO hunt_commands(match_id,idempotency_key,actor_id,kind,payload,response,created_at)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.idempotency_key,
    row.actor_id,
    row.kind,
    row.payload,
    row.response,
    row.created_at,
  );
}

export function readHuntEvents(db: DatabaseSync, matchId: string): HuntEventRow[] {
  return db
    .prepare(
      `SELECT match_id,event_index,round_index,kind,visibility,actor_id,payload,created_at
       FROM hunt_events WHERE match_id=? ORDER BY event_index`,
    )
    .all(matchId) as unknown as HuntEventRow[];
}

export function insertHuntEvent(db: DatabaseSync, row: HuntEventRow): void {
  db.prepare(
    `INSERT INTO hunt_events(match_id,event_index,round_index,kind,visibility,actor_id,payload,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    row.match_id,
    row.event_index,
    row.round_index,
    row.kind,
    row.visibility,
    row.actor_id,
    row.payload,
    row.created_at,
  );
}

/** Runs a feature migration atomically for callers that want explicit ordering. */
export function migrateHuntInTransaction(db: DatabaseSync): void {
  transaction(db, () => initializeHuntDatabase(db));
}
