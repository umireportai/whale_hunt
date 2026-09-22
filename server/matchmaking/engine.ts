import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EnqueueHuntCommand, HuntQueueEntryView } from '../../shared/hunt.js';
import type { CommandMeta } from '../../shared/game-rules.js';
import { transaction } from '../db/store.js';
import {
  initializeMatchmakingDatabase,
  insertHuntQueueCommand,
  insertHuntQueueEntry,
  readActiveHuntQueueForPlayer,
  readHuntQueueCommand,
  readHuntQueueEntry,
  readWaitingHuntQueue,
  updateHuntQueueEntry,
  type HuntQueueRow,
  type MatchmakingRole,
} from './store.js';

export interface MatchmakingQueueRequest extends EnqueueHuntCommand {
  readonly role?: MatchmakingRole;
  readonly playComputersNow?: boolean;
}

export interface MatchmakingRosterEntry {
  readonly queueId: string;
  readonly playerId: string;
  readonly role: MatchmakingRole;
}

export interface MatchCreated {
  readonly matchId: string;
  readonly roomCode: string;
}

export interface MatchmakingEngineOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly queueTimeoutMs?: number;
  readonly createMatch: (
    roster: readonly MatchmakingRosterEntry[],
    maxTracers: 1 | 5,
    now: Date,
  ) => MatchCreated;
}

export type MatchmakingErrorCode =
  'INVALID_COMMAND' | 'NOT_FOUND' | 'FORBIDDEN' | 'IDEMPOTENCY_CONFLICT' | 'QUEUE_ALREADY_ACTIVE';

export class MatchmakingError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(
    readonly code: MatchmakingErrorCode,
    message: string,
    statusCode = code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 409,
  ) {
    super(message);
    this.name = 'MatchmakingError';
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function json(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  if (typeof value === 'object' && value) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${json(item)}`)
      .join(',')}}`;
  }
  throw new MatchmakingError(
    'INVALID_COMMAND',
    'Queue commands must contain finite JSON values.',
    400,
  );
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160)
    throw new MatchmakingError('INVALID_COMMAND', `${label} is required.`, 400);
  return value;
}

function clockDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new MatchmakingError('INVALID_COMMAND', 'A valid matchmaking clock is required.', 500);
  return value;
}

function queueView(row: HuntQueueRow): HuntQueueEntryView {
  return {
    queueId: row.queue_id,
    status: row.status,
    maxTracers: row.max_tracers,
    queuedAt: row.queued_at,
    ...(row.room_code ? { roomCode: row.room_code } : {}),
    ...(row.match_id ? { matchId: row.match_id } : {}),
  };
}

function ageMs(row: HuntQueueRow, now: number): number {
  const queuedAt = Date.parse(row.queued_at);
  return Number.isFinite(queuedAt) ? Math.max(0, now - queuedAt) : Number.MAX_SAFE_INTEGER;
}

/** Owns persisted queue claims and invokes match creation inside the same SQLite transaction. */
export class MatchmakingEngine {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly queueTimeoutMs: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: MatchmakingEngineOptions,
  ) {
    initializeMatchmakingDatabase(db);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 8_000;
  }

  enqueue(playerId: string, command: MatchmakingQueueRequest): HuntQueueEntryView {
    const actorId = text(playerId, 'Player identity');
    const key = text(command?.idempotencyKey, 'Idempotency key');
    if (command.expectedStateVersion < 1 || !Number.isInteger(command.expectedStateVersion))
      throw new MatchmakingError('INVALID_COMMAND', 'A queue version is required.', 400);
    if (command.maxTracers !== 1 && command.maxTracers !== 5)
      throw new MatchmakingError('INVALID_COMMAND', 'A Hunt queue needs one or five tracers.', 400);
    const role = command.role ?? 'whale';
    if (role !== 'whale' && role !== 'tracer')
      throw new MatchmakingError('INVALID_COMMAND', 'A queue role must be whale or tracer.', 400);
    const playComputersNow = command.playComputersNow === true;
    const payload = json({
      expectedStateVersion: command.expectedStateVersion,
      maxTracers: command.maxTracers,
      playComputersNow,
      role,
    });
    const queueId = transaction(this.db, () => {
      const prior = readHuntQueueCommand(this.db, actorId, key);
      if (prior) {
        if (prior.operation !== 'enqueue' || prior.payload !== payload)
          throw new MatchmakingError(
            'IDEMPOTENCY_CONFLICT',
            'The queue key was used with another command.',
          );
        return prior.queue_id;
      }
      if (readActiveHuntQueueForPlayer(this.db, actorId))
        throw new MatchmakingError(
          'QUEUE_ALREADY_ACTIVE',
          'This player already has a Hunt queue membership.',
        );
      const now = clockDate(this.clock).toISOString();
      const row: HuntQueueRow = {
        queue_id: this.idFactory(),
        player_id: actorId,
        role,
        max_tracers: command.maxTracers,
        status: 'queued',
        play_computers_now: playComputersNow ? 1 : 0,
        queued_at: now,
        status_version: 1,
        match_id: null,
        room_code: null,
        cancelled_at: null,
      };
      insertHuntQueueEntry(this.db, row);
      insertHuntQueueCommand(this.db, {
        actor_id: actorId,
        idempotency_key: key,
        operation: 'enqueue',
        queue_id: row.queue_id,
        payload,
        response: json(queueView(row)),
        created_at: now,
      });
      return row.queue_id;
    });
    this.processQueue();
    return this.status(queueId, actorId);
  }

  status(queueId: string, playerId: string): HuntQueueEntryView {
    const id = text(queueId, 'Queue id');
    const actorId = text(playerId, 'Player identity');
    this.processQueue();
    const row = readHuntQueueEntry(this.db, id);
    if (!row) throw new MatchmakingError('NOT_FOUND', 'Hunt queue entry not found.', 404);
    if (row.player_id !== actorId)
      throw new MatchmakingError('FORBIDDEN', 'This queue entry belongs to another player.', 403);
    return queueView(row);
  }

  cancel(queueId: string, playerId: string, command: CommandMeta): HuntQueueEntryView {
    const id = text(queueId, 'Queue id');
    const actorId = text(playerId, 'Player identity');
    const key = text(command?.idempotencyKey, 'Idempotency key');
    if (command.expectedStateVersion < 1 || !Number.isInteger(command.expectedStateVersion))
      throw new MatchmakingError('INVALID_COMMAND', 'A queue version is required.', 400);
    const payload = json(command);
    transaction(this.db, () => {
      const prior = readHuntQueueCommand(this.db, actorId, key);
      if (prior) {
        if (prior.operation !== 'cancel' || prior.payload !== payload || prior.queue_id !== id)
          throw new MatchmakingError(
            'IDEMPOTENCY_CONFLICT',
            'The queue key was used with another command.',
          );
        return;
      }
      const row = readHuntQueueEntry(this.db, id);
      if (!row) throw new MatchmakingError('NOT_FOUND', 'Hunt queue entry not found.', 404);
      if (row.player_id !== actorId)
        throw new MatchmakingError('FORBIDDEN', 'This queue entry belongs to another player.', 403);
      const now = clockDate(this.clock).toISOString();
      const next =
        row.status === 'queued'
          ? {
              ...row,
              status: 'cancelled' as const,
              status_version: row.status_version + 1,
              cancelled_at: now,
            }
          : row;
      if (next !== row) updateHuntQueueEntry(this.db, next);
      insertHuntQueueCommand(this.db, {
        actor_id: actorId,
        idempotency_key: key,
        operation: 'cancel',
        queue_id: id,
        payload,
        response: json(queueView(next)),
        created_at: now,
      });
    });
    return this.statusWithoutProcessing(id, actorId);
  }

  /** Claims all due and fully staffed compatible entries until no claim remains. */
  processQueue(at = clockDate(this.clock)): readonly MatchCreated[] {
    return transaction(this.db, () => {
      const created: MatchCreated[] = [];
      const remaining = readWaitingHuntQueue(this.db);
      while (remaining.length) {
        const selected = this.selectRoster(remaining, at);
        if (!selected) break;
        const result = this.options.createMatch(selected.entries, selected.maxTracers, at);
        for (const entry of selected.entries) {
          const row = readHuntQueueEntry(this.db, entry.queueId);
          if (!row || row.status !== 'queued')
            throw new MatchmakingError(
              'QUEUE_ALREADY_ACTIVE',
              'A queue claim changed during matchmaking.',
            );
          updateHuntQueueEntry(this.db, {
            ...row,
            status: 'matched',
            status_version: row.status_version + 1,
            match_id: result.matchId,
            room_code: result.roomCode,
          });
        }
        created.push(result);
        const selectedIds = new Set(selected.entries.map((entry) => entry.queueId));
        for (let index = remaining.length - 1; index >= 0; index -= 1)
          if (selectedIds.has(remaining[index]!.queue_id)) remaining.splice(index, 1);
      }
      return created;
    });
  }

  private statusWithoutProcessing(queueId: string, playerId: string): HuntQueueEntryView {
    const row = readHuntQueueEntry(this.db, queueId);
    if (!row) throw new MatchmakingError('NOT_FOUND', 'Hunt queue entry not found.', 404);
    if (row.player_id !== playerId)
      throw new MatchmakingError('FORBIDDEN', 'This queue entry belongs to another player.', 403);
    return queueView(row);
  }

  private selectRoster(
    rows: readonly HuntQueueRow[],
    now: Date,
  ): { readonly entries: readonly MatchmakingRosterEntry[]; readonly maxTracers: 1 | 5 } | null {
    for (const candidate of rows) {
      const modeRows = rows.filter((row) => row.max_tracers === candidate.max_tracers);
      const opposite = modeRows.filter((row) => row.role !== candidate.role);
      const due =
        candidate.play_computers_now === 1 ||
        ageMs(candidate, now.getTime()) >= this.queueTimeoutMs;
      let selected: HuntQueueRow[] = [];
      if (candidate.play_computers_now === 1) {
        selected = [candidate];
      } else if (candidate.max_tracers === 1 && opposite.length) {
        selected = [candidate, opposite[0]!];
      } else {
        const whales = modeRows.filter((row) => row.role === 'whale');
        const tracers = modeRows.filter((row) => row.role === 'tracer');
        if (whales.length && tracers.length >= candidate.max_tracers) {
          selected = [whales[0]!, ...tracers.slice(0, candidate.max_tracers)];
        } else if (due) {
          const whale = whales[0];
          const selectedTracers = tracers.slice(0, candidate.max_tracers);
          if (candidate.role === 'whale') selected = [candidate, ...selectedTracers];
          else selected = [...(whale ? [whale] : []), ...selectedTracers];
          if (!selected.some((row) => row.queue_id === candidate.queue_id))
            selected.push(candidate);
        }
      }
      if (!selected.length) continue;
      const unique = [...new Map(selected.map((row) => [row.queue_id, row])).values()];
      if (!unique.some((row) => row.role === 'whale') && candidate.role === 'whale') continue;
      return {
        maxTracers: candidate.max_tracers,
        entries: unique.map((row) => ({
          queueId: row.queue_id,
          playerId: row.player_id,
          role: row.role,
        })),
      };
    }
    return null;
  }
}

export { initializeMatchmakingDatabase, queueView };
