import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  FinalAccusationCommand,
  FinishInvestigationCommand,
  HuntCommand,
  HuntMatchView,
  HuntParticipantView,
  HuntReveal,
  HuntAssetIdentity,
  HuntRole,
  HuntRoomView,
  PinEvidenceCommand,
  PurchaseScanCommand,
  SelectHuntTargetsCommand,
  SubmitSuspicionCommand,
  SubmitWhalePlanCommand,
} from '../../../shared/hunt.js';
import { HUNT_RULES, type OpaqueId } from '../../../shared/game-rules.js';
import type { EvidenceAvailability } from '../../../shared/evidence.js';
import {
  initializeHuntDatabase,
  insertHuntCommand,
  insertHuntEvent,
  insertHuntMatch,
  insertHuntParticipant,
  insertHuntRoom,
  insertHuntRoomCommand,
  readHuntCommand,
  readHuntEvents,
  readHuntMatch,
  readHuntParticipants,
  readHuntRoom,
  readHuntRoomCommand,
  updateHuntMatch,
  updateHuntRoom,
  type HuntCommandRow,
  type HuntEventRow,
  type HuntMatchRow,
  type HuntParticipantRow,
  type HuntRoomCommandRow,
  type HuntRoomRow,
} from '../../db/hunt.js';
import { transaction } from '../../db/store.js';
import type { CompiledHuntBoard } from '../../evidence/types.js';
import { createEventRecord, applyPlan, resolveScan } from './evidence.js';
import { HuntRuleError, resolveFinal, validateSuspicion, validateWhalePlan } from './lifecycle.js';
import { HUNT_ENGINE_RULES, scanDefinitionFor } from './rules.js';
import { createSyntheticHuntBoard } from './synthetic.js';
import type {
  HuntEventRecord,
  HuntFinalResolution,
  HuntMatchScores,
  HuntPlanRecord,
  HuntReconstruction,
  HuntStateSnapshot,
  HuntSuspicionRecord,
  HuntTargetPair,
} from './types.js';

export type HuntErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_PHASE'
  | 'INVALID_ROLE'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'STALE_STATE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_COMMAND'
  | 'INVALID_TARGETS'
  | 'INVALID_PLAN'
  | 'INSUFFICIENT_SCANS'
  | 'TIMEOUT'
  | 'VOIDED'
  | 'ALREADY_COMPLETE';

/** Typed domain error used by the Hunt engine and route registrar. */
export class HuntError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly stateVersion?: number;

  constructor(
    readonly code: HuntErrorCode,
    message: string,
    statusCode = defaultStatus(code),
    stateVersion?: number,
  ) {
    super(message);
    this.name = 'HuntError';
    this.statusCode = statusCode;
    this.retryable = code === 'STALE_STATE';
    this.stateVersion = stateVersion;
  }
}

function defaultStatus(code: HuntErrorCode): number {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'FORBIDDEN' || code === 'INVALID_ROLE') return 403;
  if (code === 'INVALID_COMMAND' || code === 'INVALID_TARGETS' || code === 'INVALID_PLAN')
    return 400;
  return 409;
}

export interface HuntEngineOptions {
  readonly clock?: () => Date;
  readonly boardFor?: (roomId: OpaqueId) => CompiledHuntBoard;
  readonly idFactory?: () => OpaqueId;
  readonly roomCodeFor?: (roomId: OpaqueId) => string;
}

interface TransitionEvent {
  readonly roundIndex: number;
  readonly kind: string;
  readonly visibility: HuntEventRow['visibility'];
  readonly actorId: string | null;
  readonly payload: unknown;
}

interface Transition {
  readonly state: HuntStateSnapshot;
  readonly events: readonly TransitionEvent[];
  readonly response?: HuntMatchView | HuntReveal;
}

interface MutationResult {
  readonly response?: HuntMatchView | HuntReveal;
  readonly timeout?: { readonly stateVersion: number };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new HuntError('INVALID_COMMAND', 'Commands must contain finite JSON values.', 400);
}

function requireText(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HuntError('INVALID_COMMAND', `${label} is required.`, 400);
  return value;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored Hunt ${label} is malformed.`);
  }
}

function optionalJson<T>(value: string | null): T | null {
  return value === null ? null : parseJson<T>(value, 'state');
}

function eventRecords(rows: readonly HuntEventRow[]): HuntReconstruction['events'] {
  return rows.map((row) => ({
    eventIndex: row.event_index,
    roundIndex: row.round_index,
    kind: row.kind,
    visibility: row.visibility,
    actorId: row.actor_id,
    payload: parseJson(row.payload, 'event'),
    createdAt: row.created_at,
  }));
}

function participantView(row: HuntParticipantRow): HuntParticipantView {
  if (row.kind === 'computer')
    return {
      participantId: row.participant_id,
      displayName: row.display_name,
      role: row.role,
      kind: 'computer',
      computerLabel: 'Computer',
      connection: row.connection,
      isCaptain: row.is_captain === 1,
    };
  return {
    participantId: row.participant_id,
    displayName: row.display_name,
    role: row.role,
    kind: 'human',
    connection: row.connection,
    isCaptain: row.is_captain === 1,
  };
}

function targetPair(value: SelectHuntTargetsCommand | FinalAccusationCommand): HuntTargetPair {
  return {
    primaryAssetId: value.primaryAssetId,
    secondaryAssetId: value.secondaryAssetId,
  };
}

function targetIds(board: CompiledHuntBoard): readonly OpaqueId[] {
  return board.assets.map((asset) => asset.caseId);
}

function currentRoundScans(state: HuntStateSnapshot): readonly OpaqueId[] {
  return state.scans
    .filter((scan) => scan.roundIndex === state.roundIndex)
    .map((scan) => scan.clue.clueId)
    .filter((scanId, index, values) => values.indexOf(scanId) === index);
}

function eventIndex(rows: readonly HuntEventRow[]): number {
  return rows.length ? Math.max(...rows.map((row) => row.event_index)) + 1 : 0;
}

function stateFromRow(row: HuntMatchRow, rows: readonly HuntEventRow[]): HuntStateSnapshot {
  const board = parseJson<CompiledHuntBoard>(row.board_payload, 'board');
  const purchases = parseJson<HuntEventRecord['simulated']>(row.purchases_payload, 'purchases');
  return {
    matchId: row.match_id,
    roomId: row.room_id,
    roomCode: row.room_code,
    maxTracers: row.max_tracers,
    phase: row.phase,
    roundIndex: row.round_index,
    stateVersion: row.state_version,
    deadlineAt: row.deadline_at,
    reconnectUntil: row.reconnect_until,
    board,
    targets: optionalJson<HuntTargetPair>(row.targets_payload),
    plans: parseJson<HuntPlanRecord[]>(row.plans_payload, 'plans'),
    eventRecord: createEventRecord(board, purchases),
    scans: parseJson<HuntStateSnapshot['scans']>(row.scans_payload, 'scans'),
    pinnedEvidence: parseJson<HuntStateSnapshot['pinnedEvidence']>(
      row.pinned_payload,
      'pinned evidence',
    ),
    suspicions: parseJson<HuntSuspicionRecord[]>(row.suspicions_payload, 'suspicions'),
    finalAccusation: optionalJson<HuntTargetPair>(row.final_accusation),
    reveal: optionalJson<HuntReveal>(row.reveal_payload),
    scores: optionalJson<HuntMatchScores>(row.scores_payload),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function rowFromState(previous: HuntMatchRow, state: HuntStateSnapshot): HuntMatchRow {
  return {
    ...previous,
    phase: state.phase,
    round_index: state.roundIndex,
    state_version: state.stateVersion,
    deadline_at: state.deadlineAt,
    reconnect_until: state.reconnectUntil,
    board_payload: canonicalJson(state.board),
    targets_payload: canonicalJson(state.targets),
    plans_payload: canonicalJson(state.plans),
    purchases_payload: canonicalJson(state.eventRecord.simulated),
    scans_payload: canonicalJson(state.scans),
    pinned_payload: canonicalJson(state.pinnedEvidence),
    suspicions_payload: canonicalJson(state.suspicions),
    final_accusation: canonicalJson(state.finalAccusation),
    reveal_payload: canonicalJson(state.reveal),
    scores_payload: canonicalJson(state.scores),
    completed_at: state.completedAt,
  };
}

function phaseDeadline(phase: HuntStateSnapshot['phase'], at: string): HuntMatchView['deadline'] {
  return phase === 'finished' || phase === 'voided' ? null : { phase, at };
}

function evidenceAvailability(board: CompiledHuntBoard): EvidenceAvailability {
  const asset = board.publicAssets[0];
  if (!asset)
    return {
      status: 'unavailable',
      sourceKind: board.sourceKind,
      reasonCode: 'incomplete-window',
      message: 'This Hunt board has no public evidence asset.',
    };
  return {
    status: 'available',
    sourceKind: board.sourceKind,
    coverage: asset.coverage,
  };
}

function unitsFor(state: HuntStateSnapshot, assetId: OpaqueId): number {
  return state.eventRecord.simulated
    .filter((event) => event.assetId === assetId)
    .reduce((sum, event) => sum + event.units, 0);
}

function completedScore(
  state: HuntStateSnapshot,
  accusation: HuntTargetPair,
  captainId: OpaqueId,
): HuntFinalResolution {
  if (!state.targets)
    throw new HuntError('INVALID_COMMAND', 'Targets are not selected.', 409, state.stateVersion);
  const resolution = resolveFinal({
    targets: state.targets,
    accusation,
    purchases: state.eventRecord.simulated,
    suspicions: state.suspicions,
    earlySuspicionActorId: captainId,
  });
  return {
    ...resolution,
    reveal: revealWithIdentities(resolution.reveal, state.board),
  };
}

function revealWithIdentities(reveal: HuntReveal, board: CompiledHuntBoard): HuntReveal {
  const ids = new Set<OpaqueId>([
    reveal.primaryAssetId,
    reveal.secondaryAssetId,
    ...(reveal.accusation
      ? [reveal.accusation.primaryAssetId, reveal.accusation.secondaryAssetId]
      : []),
  ]);
  const identities: HuntAssetIdentity[] = board.assets
    .filter((asset) => ids.has(asset.caseId))
    .map((asset) => ({
      assetId: asset.caseId,
      symbol: asset.symbol,
      name: asset.name,
    }));
  return { ...reveal, identities };
}

export class HuntEngine {
  private readonly clock: () => Date;
  private readonly boardFor: (roomId: OpaqueId) => CompiledHuntBoard;
  private readonly idFactory: () => OpaqueId;
  private readonly roomCodeFor: (roomId: OpaqueId) => string;

  constructor(
    private readonly db: DatabaseSync,
    options: HuntEngineOptions | (() => Date) = {},
  ) {
    const configured = typeof options === 'function' ? { clock: options } : options;
    this.clock = configured.clock ?? (() => new Date());
    this.boardFor = configured.boardFor ?? (() => createSyntheticHuntBoard());
    this.idFactory = configured.idFactory ?? randomUUID;
    this.roomCodeFor =
      configured.roomCodeFor ??
      ((roomId) => `HUNT-${roomId.replaceAll('-', '').slice(0, 8).toUpperCase()}`);
    initializeHuntDatabase(db);
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new HuntError('INVALID_COMMAND', 'A valid server clock is required.', 500);
    return value;
  }

  private matchState(matchId: string): {
    readonly row: HuntMatchRow;
    readonly state: HuntStateSnapshot;
    readonly participants: readonly HuntParticipantRow[];
    readonly events: readonly HuntEventRow[];
  } {
    const row = readHuntMatch(this.db, matchId);
    if (!row) throw new HuntError('NOT_FOUND', 'Hunt match not found.', 404);
    const events = readHuntEvents(this.db, matchId);
    return {
      row,
      state: stateFromRow(row, events),
      participants: readHuntParticipants(this.db, matchId),
      events,
    };
  }

  private participant(matchId: string, participantId: string): HuntParticipantRow {
    const value = readHuntParticipants(this.db, matchId).find(
      (item) => item.participant_id === participantId,
    );
    if (!value) throw new HuntError('FORBIDDEN', 'This player is not in the Hunt match.', 403);
    return value;
  }

  private stateDeadline(phase: HuntStateSnapshot['phase'] = 'setup'): string {
    const duration =
      phase === 'whale-planning'
        ? HUNT_ENGINE_RULES.whalePlanningDurationMs
        : phase === 'tracer-investigation'
          ? HUNT_ENGINE_RULES.tracerInvestigationDurationMs
          : phase === 'final-accusation'
            ? HUNT_ENGINE_RULES.finalAccusationDurationMs
            : HUNT_ENGINE_RULES.setupDurationMs;
    return new Date(this.now().getTime() + duration).toISOString();
  }

  private view(
    state: HuntStateSnapshot,
    participants: readonly HuntParticipantRow[],
    actorId: string,
  ): HuntMatchView {
    const actor = participants.find((item) => item.participant_id === actorId);
    if (!actor) throw new HuntError('FORBIDDEN', 'This player is not in the Hunt match.', 403);
    const captain = participants.find((item) => item.role === 'tracer' && item.is_captain === 1);
    const common = {
      matchId: state.matchId,
      roomCode: state.roomCode,
      phase: state.phase,
      stateVersion: state.stateVersion,
      roundIndex: state.roundIndex,
      totalRounds: HUNT_RULES.totalRounds,
      assets: state.board.publicAssets,
      participants: participants.map(participantView),
      captain: {
        participantId: captain?.participant_id ?? null,
        transfer: 'stable' as const,
        canSubmitFinalAccusation: actor.role === 'tracer' && actor.is_captain === 1,
      },
      deadline: phaseDeadline(state.phase, state.deadlineAt),
      serverNow: this.now().toISOString(),
      reconnect: {
        reconnectUntil: actor.reconnect_until,
        canReconnect: actor.connection !== 'substituted',
        substitution: actor.connection === 'substituted' ? ('active' as const) : ('none' as const),
      },
      evidence: evidenceAvailability(state.board),
    };
    if (actor.role === 'whale') {
      const targets = state.targets;
      const targetSet = targets
        ? new Set([targets.primaryAssetId, targets.secondaryAssetId])
        : new Set<OpaqueId>();
      const decoyUnits = state.eventRecord.simulated
        .filter((event) => !targetSet.has(event.assetId))
        .reduce((sum, event) => sum + event.units, 0);
      return {
        ...common,
        viewerRole: 'whale',
        ownTargets: targets,
        targetUnits: {
          primary: state.plans
            .filter((plan) => plan.assetId === targets?.primaryAssetId)
            .reduce((sum, plan) => sum + plan.units, 0),
          secondary: state.plans
            .filter((plan) => plan.assetId === targets?.secondaryAssetId)
            .reduce((sum, plan) => sum + plan.units, 0),
        },
        unitsPurchased: state.eventRecord.simulated.reduce((sum, event) => sum + event.units, 0),
        decoyUnits,
      };
    }
    const scanIds = currentRoundScans(state);
    const ownSuspicion =
      state.suspicions.find(
        (item) => item.actorId === actorId && item.roundIndex === state.roundIndex,
      ) ?? null;
    return {
      ...common,
      viewerRole: actor.is_captain === 1 ? 'captain' : 'tracer',
      scansRemaining: Math.max(
        0,
        (state.maxTracers === 1 ? HUNT_RULES.oneVsOneScansPerRound : HUNT_RULES.crewScansPerRound) -
          scanIds.length,
      ),
      availableScanIds:
        state.maxTracers === 5 &&
        state.scans.some((scan) => scan.roundIndex === state.roundIndex && scan.actorId === actorId)
          ? []
          : state.board.publicAssets
              .flatMap((asset) => asset.clueDescriptors.map((clue) => clue.clueId))
              .filter((id) => !scanIds.includes(id)),
      sharedEvidence: state.scans.map((scan) => scan.clue),
      pinnedEvidenceIds: state.pinnedEvidence[actorId] ?? [],
      ownSuspicion: ownSuspicion
        ? {
            primaryAssetId: ownSuspicion.primaryAssetId,
            secondaryAssetId: ownSuspicion.secondaryAssetId,
          }
        : null,
    };
  }

  private roomView(room: HuntRoomRow): HuntRoomView {
    const participants = room.match_id ? readHuntParticipants(this.db, room.match_id) : [];
    const match = room.match_id ? readHuntMatch(this.db, room.match_id) : undefined;
    return {
      roomCode: room.room_code,
      roomId: room.room_id,
      ...(room.match_id ? { matchId: room.match_id } : {}),
      phase: room.phase,
      participants: participants.map(participantView),
      maxTracers: room.max_tracers,
      deadline: room.deadline_at && match ? { phase: match.phase, at: room.deadline_at } : null,
    };
  }

  /** Creates a setup match with the creator assigned as the hidden whale. */
  createRoom(
    actorId: string,
    command: { readonly idempotencyKey: string; readonly maxTracers: 1 | 5 },
  ): HuntRoomView {
    const playerId = requireText(actorId, 'Player identity');
    const key = requireText(command?.idempotencyKey, 'Idempotency key');
    if (command.maxTracers !== 1 && command.maxTracers !== 5)
      throw new HuntError('INVALID_COMMAND', 'A Hunt room must allow one or five tracers.', 400);
    const payload = canonicalJson({ maxTracers: command.maxTracers });
    return transaction(this.db, () => {
      const prior = readHuntRoomCommand(this.db, playerId, key);
      if (prior) {
        if (prior.payload !== payload || prior.operation !== 'create-room')
          throw new HuntError(
            'IDEMPOTENCY_CONFLICT',
            'The room key was used with another command.',
          );
        return parseJson<HuntRoomView>(prior.response, 'room command response');
      }
      const now = this.now().toISOString();
      const roomId = this.idFactory();
      const matchId = this.idFactory();
      const roomCode = this.roomCodeFor(roomId);
      const board = this.boardFor(roomId);
      if (board.assets.length < HUNT_RULES.assets || board.assets.length > HUNT_RULES.maxAssets)
        throw new HuntError('INVALID_COMMAND', 'A Hunt board must contain six to ten assets.', 500);
      const deadline = new Date(
        this.now().getTime() + HUNT_ENGINE_RULES.setupDurationMs,
      ).toISOString();
      const reconnectUntil = new Date(
        this.now().getTime() + HUNT_ENGINE_RULES.reconnectGraceMs,
      ).toISOString();
      const room: HuntRoomRow = {
        room_id: roomId,
        room_code: roomCode,
        max_tracers: command.maxTracers,
        phase: 'setup',
        state_version: 1,
        match_id: matchId,
        deadline_at: deadline,
        created_at: now,
      };
      const match: HuntMatchRow = {
        match_id: matchId,
        room_id: roomId,
        room_code: roomCode,
        max_tracers: command.maxTracers,
        phase: 'setup',
        round_index: 0,
        state_version: 1,
        deadline_at: deadline,
        reconnect_until: reconnectUntil,
        board_payload: canonicalJson(board),
        targets_payload: 'null',
        plans_payload: '[]',
        purchases_payload: '[]',
        scans_payload: '[]',
        pinned_payload: '{}',
        suspicions_payload: '[]',
        final_accusation: 'null',
        reveal_payload: 'null',
        scores_payload: 'null',
        created_at: now,
        completed_at: null,
      };
      insertHuntRoom(this.db, room);
      insertHuntMatch(this.db, match);
      insertHuntParticipant(this.db, {
        match_id: matchId,
        participant_id: playerId,
        display_name: 'Whale',
        role: 'whale',
        kind: 'human',
        connection: 'connected',
        is_captain: 0,
        reconnect_until: reconnectUntil,
      });
      insertHuntEvent(this.db, {
        match_id: matchId,
        event_index: 0,
        round_index: 0,
        kind: 'room-created',
        visibility: 'system',
        actor_id: playerId,
        payload: canonicalJson({ roomId, roomCode }),
        created_at: now,
      });
      const response = this.roomView(room);
      insertHuntRoomCommand(this.db, {
        actor_id: playerId,
        idempotency_key: key,
        operation: 'create-room',
        room_id: roomId,
        payload,
        response: canonicalJson(response),
        created_at: now,
      });
      return response;
    });
  }

  /** Joins a setup room as a tracer and makes the first tracer its captain. */
  joinRoom(
    actorId: string,
    roomCode: string,
    command: { readonly idempotencyKey: string },
  ): HuntRoomView {
    const playerId = requireText(actorId, 'Player identity');
    const code = requireText(roomCode, 'Room code');
    const key = requireText(command?.idempotencyKey, 'Idempotency key');
    const payload = canonicalJson({ roomCode: code });
    return transaction(this.db, () => {
      const prior = readHuntRoomCommand(this.db, playerId, key);
      if (prior) {
        if (prior.payload !== payload || prior.operation !== 'join-room')
          throw new HuntError(
            'IDEMPOTENCY_CONFLICT',
            'The room key was used with another command.',
          );
        return parseJson<HuntRoomView>(prior.response, 'room command response');
      }
      const room = readHuntRoom(this.db, code);
      if (!room || !room.match_id) throw new HuntError('NOT_FOUND', 'Hunt room not found.', 404);
      const match = readHuntMatch(this.db, room.match_id);
      if (!match) throw new HuntError('NOT_FOUND', 'Hunt match not found.', 404);
      const participants = readHuntParticipants(this.db, match.match_id);
      const existing = participants.find((item) => item.participant_id === playerId);
      const now = this.now().toISOString();
      if (!existing) {
        if (room.phase !== 'setup' || match.phase !== 'setup')
          throw new HuntError(
            'INVALID_PHASE',
            'This Hunt room is no longer accepting players.',
            409,
            match.state_version,
          );
        const tracers = participants.filter((item) => item.role === 'tracer');
        if (tracers.length >= room.max_tracers)
          throw new HuntError(
            'INVALID_COMMAND',
            'This Hunt room already has all of its tracers.',
            409,
            match.state_version,
          );
        const reconnectUntil = new Date(
          this.now().getTime() + HUNT_ENGINE_RULES.reconnectGraceMs,
        ).toISOString();
        insertHuntParticipant(this.db, {
          match_id: match.match_id,
          participant_id: playerId,
          display_name: `Tracer ${tracers.length + 1}`,
          role: 'tracer',
          kind: 'human',
          connection: 'connected',
          is_captain: tracers.length === 0 ? 1 : 0,
          reconnect_until: reconnectUntil,
        });
        const nextMatch = {
          ...match,
          state_version: match.state_version + 1,
        };
        updateHuntMatch(this.db, nextMatch);
        updateHuntRoom(this.db, {
          ...room,
          state_version: room.state_version + 1,
        });
        insertHuntEvent(this.db, {
          match_id: match.match_id,
          event_index: eventIndex(readHuntEvents(this.db, match.match_id)),
          round_index: 0,
          kind: 'participant-joined',
          visibility: 'shared',
          actor_id: playerId,
          payload: canonicalJson({ role: 'tracer' }),
          created_at: now,
        });
      }
      const currentRoom = readHuntRoom(this.db, room.room_id)!;
      const response = this.roomView(currentRoom);
      insertHuntRoomCommand(this.db, {
        actor_id: playerId,
        idempotency_key: key,
        operation: 'join-room',
        room_id: room.room_id,
        payload,
        response: canonicalJson(response),
        created_at: now,
      });
      return response;
    });
  }

  /** Returns a setup room without exposing private match state. */
  getRoom(roomCode: string): HuntRoomView {
    const room = readHuntRoom(this.db, requireText(roomCode, 'Room code'));
    if (!room) throw new HuntError('NOT_FOUND', 'Hunt room not found.', 404);
    return this.roomView(room);
  }

  private participantMutation(
    matchId: string,
    participantId: string,
    mutation: {
      readonly kind: 'human' | 'computer';
      readonly connection: HuntParticipantRow['connection'];
      readonly reconnectUntil: string;
    },
    eventKind: string,
    payload: unknown,
  ): HuntMatchView {
    return transaction(this.db, () => {
      const loaded = this.matchState(requireText(matchId, 'Match id'));
      const participant = loaded.participants.find(
        (item) => item.participant_id === requireText(participantId, 'Participant id'),
      );
      if (!participant)
        throw new HuntError('FORBIDDEN', 'This player is not in the Hunt match.', 403);
      const state = loaded.state;
      if (state.phase === 'finished' || state.phase === 'voided')
        throw new HuntError('ALREADY_COMPLETE', 'This Hunt match is already complete.', 409);
      const now = this.now().toISOString();
      this.db
        .prepare(
          `UPDATE hunt_participants SET kind=?,connection=?,reconnect_until=?
           WHERE match_id=? AND participant_id=?`,
        )
        .run(
          mutation.kind,
          mutation.connection,
          mutation.reconnectUntil,
          state.matchId,
          participant.participant_id,
        );
      const nextState = { ...state, stateVersion: state.stateVersion + 1 };
      this.persistTransition(loaded.row, nextState, [
        {
          roundIndex: state.roundIndex,
          kind: eventKind,
          visibility: 'system',
          actorId: participant.participant_id,
          payload,
        },
      ]);
      return this.view(nextState, readHuntParticipants(this.db, state.matchId), participantId);
    });
  }

  /** Marks a connected human as reconnecting and starts the persisted grace window. */
  disconnect(matchId: string, participantId: string): HuntMatchView {
    const loaded = this.matchState(requireText(matchId, 'Match id'));
    const participant = this.participant(matchId, participantId);
    if (participant.connection === 'substituted')
      throw new HuntError('FORBIDDEN', 'A substituted seat cannot disconnect.', 403);
    if (participant.connection === 'reconnecting')
      return this.view(loaded.state, loaded.participants, participantId);
    const reconnectUntil = new Date(
      this.now().getTime() + HUNT_ENGINE_RULES.reconnectGraceMs,
    ).toISOString();
    return this.participantMutation(
      matchId,
      participantId,
      { kind: participant.kind, connection: 'reconnecting', reconnectUntil },
      'participant-disconnected',
      { reconnectUntil },
    );
  }

  /** Restores a human seat, subject to the safe-boundary rule after substitution. */
  reconnect(matchId: string, participantId: string): HuntMatchView {
    const loaded = this.matchState(requireText(matchId, 'Match id'));
    const participant = this.participant(matchId, participantId);
    if (loaded.state.phase === 'finished' || loaded.state.phase === 'voided')
      return this.view(loaded.state, loaded.participants, participantId);
    if (participant.connection === 'connected' && participant.kind === 'human')
      return this.view(loaded.state, loaded.participants, participantId);
    if (participant.connection === 'substituted') {
      const substitution = [...loaded.events]
        .reverse()
        .find(
          (event) =>
            event.kind === 'participant-substituted' &&
            event.actor_id === participant.participant_id,
        );
      const payload = substitution
        ? parseJson<{ readonly phase?: string }>(substitution.payload, 'substitution event')
        : {};
      if (payload.phase === loaded.state.phase)
        throw new HuntError(
          'INVALID_PHASE',
          'Reconnect is available at the next safe Hunt phase boundary.',
          409,
          loaded.state.stateVersion,
        );
    }
    return this.participantMutation(
      matchId,
      participantId,
      {
        kind: 'human',
        connection: 'connected',
        reconnectUntil: new Date(
          this.now().getTime() + HUNT_ENGINE_RULES.reconnectGraceMs,
        ).toISOString(),
      },
      'participant-reconnected',
      {},
    );
  }

  /** Converts a disconnected human seat to a labeled computer takeover. */
  substituteParticipant(matchId: string, participantId: string): HuntMatchView {
    const loaded = this.matchState(requireText(matchId, 'Match id'));
    const participant = this.participant(matchId, participantId);
    if (participant.kind === 'computer')
      return this.view(loaded.state, loaded.participants, participantId);
    if (participant.connection !== 'reconnecting')
      throw new HuntError('INVALID_COMMAND', 'Only a disconnected seat can be substituted.', 409);
    if (Date.parse(participant.reconnect_until) > this.now().getTime())
      throw new HuntError('INVALID_COMMAND', 'Reconnect grace has not elapsed.', 409);
    return this.participantMutation(
      matchId,
      participantId,
      { kind: 'computer', connection: 'substituted', reconnectUntil: participant.reconnect_until },
      'participant-substituted',
      { phase: loaded.state.phase, reason: 'reconnect-grace-elapsed' },
    );
  }

  private expireState(
    state: HuntStateSnapshot,
    participants: readonly HuntParticipantRow[],
  ): HuntStateSnapshot {
    if (state.phase === 'finished' || state.phase === 'voided') return state;
    if (Date.parse(state.deadlineAt) > this.now().getTime()) return state;
    const assetIds = state.board.publicAssets.map((asset) => asset.assetId);
    const fallbackPair: HuntTargetPair = {
      primaryAssetId: assetIds[0] ?? 'missing-primary',
      secondaryAssetId: assetIds[1] ?? 'missing-secondary',
    };
    if (state.phase === 'setup')
      return {
        ...state,
        targets: state.targets ?? fallbackPair,
        phase: 'whale-planning',
        roundIndex: 1,
        deadlineAt: this.stateDeadline('whale-planning'),
        stateVersion: state.stateVersion + 1,
      };
    if (state.phase === 'whale-planning') {
      const plan = state.plans.some((item) => item.roundIndex === state.roundIndex)
        ? state.plans
        : [
            ...state.plans,
            { roundIndex: state.roundIndex, action: 'wait' as const, assetId: null, units: 0 },
          ];
      return {
        ...state,
        phase: 'tracer-investigation',
        plans: plan,
        deadlineAt: this.stateDeadline('tracer-investigation'),
        stateVersion: state.stateVersion + 1,
      };
    }
    if (state.phase === 'tracer-investigation') {
      const pair = state.targets ?? fallbackPair;
      const suspicions = [...state.suspicions];
      for (const participant of participants.filter((item) => item.role === 'tracer'))
        if (
          !suspicions.some(
            (item) =>
              item.actorId === participant.participant_id && item.roundIndex === state.roundIndex,
          )
        )
          suspicions.push({
            ...pair,
            roundIndex: state.roundIndex,
            actorId: participant.participant_id,
          });
      const nextPhase =
        state.roundIndex >= HUNT_RULES.totalRounds ? 'final-accusation' : 'whale-planning';
      return {
        ...state,
        phase: nextPhase,
        roundIndex: nextPhase === 'whale-planning' ? state.roundIndex + 1 : state.roundIndex,
        suspicions,
        deadlineAt: this.stateDeadline(nextPhase),
        stateVersion: state.stateVersion + 1,
      };
    }
    if (state.phase === 'final-accusation') {
      const targets = state.targets ?? fallbackPair;
      const resolution = resolveFinal({
        targets,
        accusation: fallbackPair,
        purchases: state.eventRecord.simulated,
        suspicions: state.suspicions,
      });
      return {
        ...state,
        phase: 'finished',
        finalAccusation: null,
        reveal: { ...revealWithIdentities(resolution.reveal, state.board), accusation: null },
        scores: resolution.scores,
        completedAt: this.now().toISOString(),
        stateVersion: state.stateVersion + 1,
      };
    }
    return state;
  }

  private persistTransition(
    previous: HuntMatchRow,
    state: HuntStateSnapshot,
    events: readonly TransitionEvent[],
  ): void {
    updateHuntMatch(this.db, rowFromState(previous, state));
    const existing = readHuntEvents(this.db, previous.match_id);
    events.forEach((event, index) =>
      insertHuntEvent(this.db, {
        match_id: previous.match_id,
        event_index: eventIndex(existing) + index,
        round_index: event.roundIndex,
        kind: event.kind,
        visibility: event.visibility,
        actor_id: event.actorId,
        payload: canonicalJson(event.payload),
        created_at: this.now().toISOString(),
      }),
    );
  }

  private withExpiration(
    previous: HuntMatchRow,
    state: HuntStateSnapshot,
  ): { readonly state: HuntStateSnapshot; readonly timedOut: boolean } {
    const expired = this.expireState(state, readHuntParticipants(this.db, previous.match_id));
    if (expired === state) return { state, timedOut: false };
    this.persistTransition(previous, expired, [
      {
        roundIndex: state.roundIndex,
        kind: 'phase-timeout-defaulted',
        visibility: 'system',
        actorId: null,
        payload: { phase: state.phase, reason: 'declared-default-applied' },
      },
    ]);
    return { state: expired, timedOut: true };
  }

  /** Returns a role-filtered match view; hidden targets never enter tracer serialization. */
  getMatch(matchId: string, actorId: string): HuntMatchView {
    const id = requireText(matchId, 'Match id');
    const playerId = requireText(actorId, 'Player identity');
    return transaction(this.db, () => {
      const loaded = this.matchState(id);
      const expired = this.withExpiration(loaded.row, loaded.state);
      return this.view(expired.state, loaded.participants, playerId);
    });
  }

  private assertPhase(state: HuntStateSnapshot, phase: HuntStateSnapshot['phase']): void {
    if (state.phase !== phase)
      throw new HuntError(
        'INVALID_PHASE',
        `This command is unavailable during ${state.phase}.`,
        409,
        state.stateVersion,
      );
  }

  private assertExpectedVersion(state: HuntStateSnapshot, command: HuntCommand): void {
    if (!Number.isInteger(command.expectedStateVersion) || command.expectedStateVersion < 1)
      throw new HuntError(
        'INVALID_COMMAND',
        'A valid expected state version is required.',
        400,
        state.stateVersion,
      );
    if (command.expectedStateVersion !== state.stateVersion)
      throw new HuntError(
        'STALE_STATE',
        'The Hunt state changed; refresh before retrying.',
        409,
        state.stateVersion,
      );
  }

  private commandTransition(
    state: HuntStateSnapshot,
    participants: readonly HuntParticipantRow[],
    actorId: string,
    command: HuntCommand,
  ): Transition {
    const actor = participants.find((item) => item.participant_id === actorId);
    if (!actor) throw new HuntError('FORBIDDEN', 'This player is not in the Hunt match.', 403);
    const assets = targetIds(state.board);
    if (command.kind === 'select-targets') {
      this.assertPhase(state, 'setup');
      if (actor.role !== 'whale')
        throw new HuntError(
          'INVALID_ROLE',
          'Only the whale can select targets.',
          403,
          state.stateVersion,
        );
      if (state.targets)
        throw new HuntError(
          'DUPLICATE_COMMAND',
          'Hunt targets are already selected.',
          409,
          state.stateVersion,
        );
      if (participants.filter((item) => item.role === 'tracer').length !== state.maxTracers)
        throw new HuntError(
          'INVALID_COMMAND',
          'The Hunt needs all selected tracers before target setup.',
          409,
          state.stateVersion,
        );
      const targets = targetPair(command);
      if (targets.primaryAssetId === targets.secondaryAssetId)
        throw new HuntError(
          'INVALID_TARGETS',
          'Whale targets must be distinct.',
          400,
          state.stateVersion,
        );
      if (!assets.includes(targets.primaryAssetId) || !assets.includes(targets.secondaryAssetId))
        throw new HuntError(
          'INVALID_TARGETS',
          'Whale targets must use assets on this Hunt board.',
          400,
          state.stateVersion,
        );
      return {
        state: {
          ...state,
          phase: 'whale-planning',
          roundIndex: 1,
          stateVersion: state.stateVersion + 1,
          deadlineAt: this.stateDeadline('whale-planning'),
          targets,
        },
        events: [
          {
            roundIndex: 0,
            kind: 'targets-selected',
            visibility: 'private-whale',
            actorId,
            payload: targets,
          },
        ],
      };
    }
    if (command.kind === 'submit-whale-plan') {
      this.assertPhase(state, 'whale-planning');
      if (actor.role !== 'whale')
        throw new HuntError(
          'INVALID_ROLE',
          'Only the whale can submit a plan.',
          403,
          state.stateVersion,
        );
      if (!state.targets)
        throw new HuntError(
          'INVALID_TARGETS',
          'Select targets before planning.',
          409,
          state.stateVersion,
        );
      let plan;
      try {
        plan = validateWhalePlan({
          command,
          targets: state.targets,
          assets,
          priorPlans: state.plans,
        });
      } catch (error) {
        if (error instanceof HuntRuleError)
          throw new HuntError(
            error.code,
            error.message,
            error.code === 'INVALID_TARGETS' ? 400 : 409,
            state.stateVersion,
          );
        throw error;
      }
      const eventRecord = applyPlan(state.eventRecord, plan);
      return {
        state: {
          ...state,
          phase: 'tracer-investigation',
          stateVersion: state.stateVersion + 1,
          deadlineAt: this.stateDeadline('tracer-investigation'),
          plans: [...state.plans, plan],
          eventRecord,
        },
        events: [
          {
            roundIndex: command.roundIndex,
            kind: 'whale-plan-submitted',
            visibility: 'private-whale',
            actorId,
            payload: plan,
          },
        ],
      };
    }
    if (command.kind === 'purchase-scan') {
      this.assertPhase(state, 'tracer-investigation');
      if (actor.role !== 'tracer')
        throw new HuntError(
          'INVALID_ROLE',
          'Only tracers can purchase scans.',
          403,
          state.stateVersion,
        );
      if (command.roundIndex !== state.roundIndex)
        throw new HuntError(
          'INVALID_COMMAND',
          'The scan belongs to another Hunt round.',
          400,
          state.stateVersion,
        );
      const definition = scanDefinitionFor(command.scanId);
      const inferredAsset =
        command.assetId === undefined
          ? state.board.publicAssets.find((asset) =>
              asset.clueDescriptors.some((item) => item.clueId === command.scanId),
            )
          : undefined;
      const selectedAsset = command.assetId
        ? state.board.publicAssets.find((asset) => asset.assetId === command.assetId)
        : inferredAsset;
      if (definition.scope === 'asset' && !selectedAsset)
        throw new HuntError(
          'INVALID_COMMAND',
          'Choose the location for this asset-scoped scan.',
          400,
          state.stateVersion,
        );
      const descriptor = (
        selectedAsset
          ? selectedAsset.clueDescriptors
          : state.board.publicAssets.flatMap((asset) => asset.clueDescriptors)
      ).find((item) => item.clueId === command.scanId);
      if (!descriptor)
        throw new HuntError(
          'INVALID_COMMAND',
          'Choose an unopened scan on this Hunt board.',
          400,
          state.stateVersion,
        );
      if (
        state.scans.some(
          (scan) => scan.roundIndex === command.roundIndex && scan.clue.clueId === command.scanId,
        )
      )
        return { state, events: [] };
      if (
        state.maxTracers === 5 &&
        state.scans.some(
          (scan) => scan.roundIndex === command.roundIndex && scan.actorId === actorId,
        )
      )
        throw new HuntError(
          'INSUFFICIENT_SCANS',
          'Each crew tracer has one scan per round.',
          409,
          state.stateVersion,
        );
      const used = currentRoundScans(state).length;
      const limit =
        state.maxTracers === 1 ? HUNT_RULES.oneVsOneScansPerRound : HUNT_RULES.crewScansPerRound;
      if (used >= limit)
        throw new HuntError(
          'INSUFFICIENT_SCANS',
          'All scans for this round are already shared.',
          409,
          state.stateVersion,
        );
      const clue = resolveScan(state.eventRecord, {
        roundIndex: command.roundIndex,
        scanId: command.scanId,
        assetId: command.assetId,
      });
      const scan = { scanId: command.scanId, roundIndex: command.roundIndex, actorId, clue };
      return {
        state: { ...state, stateVersion: state.stateVersion + 1, scans: [...state.scans, scan] },
        events: [
          {
            roundIndex: command.roundIndex,
            kind: 'scan-revealed',
            visibility: 'shared',
            actorId,
            payload: clue,
          },
        ],
      };
    }
    if (command.kind === 'pin-evidence') {
      this.assertPhase(state, 'tracer-investigation');
      if (actor.role !== 'tracer')
        throw new HuntError(
          'INVALID_ROLE',
          'Only tracers can pin evidence.',
          403,
          state.stateVersion,
        );
      if (!state.scans.some((scan) => scan.clue.clueId === command.evidenceId))
        throw new HuntError(
          'INVALID_COMMAND',
          'Pin an evidence clue already shared with the team.',
          400,
          state.stateVersion,
        );
      const existing = state.pinnedEvidence[actorId] ?? [];
      if (existing.includes(command.evidenceId)) return { state, events: [] };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          pinnedEvidence: { ...state.pinnedEvidence, [actorId]: [...existing, command.evidenceId] },
        },
        events: [
          {
            roundIndex: command.roundIndex,
            kind: 'evidence-pinned',
            visibility: 'private-tracer',
            actorId,
            payload: { evidenceId: command.evidenceId },
          },
        ],
      };
    }
    if (command.kind === 'submit-suspicion') {
      this.assertPhase(state, 'tracer-investigation');
      if (actor.role !== 'tracer')
        throw new HuntError(
          'INVALID_ROLE',
          'Only tracers can submit suspicions.',
          403,
          state.stateVersion,
        );
      if (command.roundIndex !== state.roundIndex)
        throw new HuntError(
          'INVALID_COMMAND',
          'The suspicion belongs to another Hunt round.',
          400,
          state.stateVersion,
        );
      if (
        state.suspicions.some(
          (item) => item.actorId === actorId && item.roundIndex === command.roundIndex,
        )
      )
        throw new HuntError(
          'DUPLICATE_COMMAND',
          'This tracer already locked a suspicion for the round.',
          409,
          state.stateVersion,
        );
      const pair = validateSuspicion(command, assets);
      const suspicion: HuntSuspicionRecord = { ...pair, roundIndex: command.roundIndex, actorId };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          suspicions: [...state.suspicions, suspicion],
        },
        events: [
          {
            roundIndex: command.roundIndex,
            kind: 'suspicion-locked',
            visibility: 'private-tracer',
            actorId,
            payload: pair,
          },
        ],
      };
    }
    if (command.kind === 'finish-investigation') {
      this.assertPhase(state, 'tracer-investigation');
      if (actor.role !== 'tracer' || actor.is_captain !== 1)
        throw new HuntError(
          'INVALID_ROLE',
          'Only the tracer captain can finish investigation.',
          403,
          state.stateVersion,
        );
      const tracers = participants.filter((item) => item.role === 'tracer');
      if (
        tracers.some(
          (tracer) =>
            !state.suspicions.some(
              (item) =>
                item.actorId === tracer.participant_id && item.roundIndex === state.roundIndex,
            ),
        )
      )
        throw new HuntError(
          'INVALID_COMMAND',
          'Every tracer must lock one suspicion before the round ends.',
          409,
          state.stateVersion,
        );
      const nextPhase =
        state.roundIndex >= HUNT_RULES.totalRounds ? 'final-accusation' : 'whale-planning';
      return {
        state: {
          ...state,
          phase: nextPhase,
          roundIndex: nextPhase === 'whale-planning' ? state.roundIndex + 1 : state.roundIndex,
          stateVersion: state.stateVersion + 1,
          deadlineAt: this.stateDeadline(nextPhase),
        },
        events: [
          {
            roundIndex: command.roundIndex,
            kind: 'investigation-finished',
            visibility: 'system',
            actorId,
            payload: { roundIndex: command.roundIndex },
          },
        ],
      };
    }
    if (command.kind === 'final-accusation') {
      this.assertPhase(state, 'final-accusation');
      if (actor.role !== 'tracer' || actor.is_captain !== 1)
        throw new HuntError(
          'INVALID_ROLE',
          'Only the tracer captain can submit the final pair.',
          403,
          state.stateVersion,
        );
      const accusation = targetPair(command);
      if (accusation.primaryAssetId === accusation.secondaryAssetId)
        throw new HuntError(
          'INVALID_COMMAND',
          'The final pair must contain two distinct assets.',
          400,
          state.stateVersion,
        );
      if (
        !assets.includes(accusation.primaryAssetId) ||
        !assets.includes(accusation.secondaryAssetId)
      )
        throw new HuntError(
          'INVALID_COMMAND',
          'The final pair must use assets on this Hunt board.',
          400,
          state.stateVersion,
        );
      const resolution = completedScore(state, accusation, actorId);
      const now = this.now().toISOString();
      const nextState = {
        ...state,
        phase: 'finished' as const,
        stateVersion: state.stateVersion + 1,
        deadlineAt: state.deadlineAt,
        finalAccusation: accusation,
        reveal: resolution.reveal,
        scores: resolution.scores,
        completedAt: now,
      };
      return {
        state: nextState,
        response: resolution.reveal,
        events: [
          {
            roundIndex: state.roundIndex,
            kind: 'match-finished',
            visibility: 'system',
            actorId,
            payload: { reveal: resolution.reveal, scores: resolution.scores },
          },
        ],
      };
    }
    const exhaustive: never = command;
    throw new HuntError(
      'INVALID_COMMAND',
      `Unsupported Hunt command ${(exhaustive as { kind: string }).kind}.`,
      400,
      state.stateVersion,
    );
  }

  /** Applies one server-owned Hunt command with version and idempotency checks. */
  command(matchId: string, actorId: string, command: HuntCommand): HuntMatchView | HuntReveal {
    const id = requireText(matchId, 'Match id');
    const playerId = requireText(actorId, 'Player identity');
    const key = requireText(command?.idempotencyKey, 'Idempotency key');
    const payload = canonicalJson(command);
    const result = transaction(this.db, () => {
      const loaded = this.matchState(id);
      const prior = readHuntCommand(this.db, id, key);
      if (prior) {
        if (prior.actor_id !== playerId || prior.kind !== command.kind || prior.payload !== payload)
          throw new HuntError(
            'IDEMPOTENCY_CONFLICT',
            'The command key was used with another command.',
          );
        return {
          response: parseJson<HuntMatchView | HuntReveal>(prior.response, 'command response'),
        };
      }
      const expiration = this.withExpiration(loaded.row, loaded.state);
      if (expiration.timedOut) return { timeout: { stateVersion: expiration.state.stateVersion } };
      const state = expiration.state;
      this.assertExpectedVersion(state, command);
      if (state.phase === 'finished')
        throw new HuntError(
          'ALREADY_COMPLETE',
          'This Hunt match is already complete.',
          409,
          state.stateVersion,
        );
      if (state.phase === 'voided')
        throw new HuntError('VOIDED', 'This Hunt match was voided.', 409, state.stateVersion);
      const transition = this.commandTransition(state, loaded.participants, playerId, command);
      const response =
        transition.response ?? this.view(transition.state, loaded.participants, playerId);
      this.persistTransition(loaded.row, transition.state, transition.events);
      insertHuntCommand(this.db, {
        match_id: id,
        idempotency_key: key,
        actor_id: playerId,
        kind: command.kind,
        payload,
        response: canonicalJson(response),
        created_at: this.now().toISOString(),
      });
      return { response };
    });
    if (result.timeout)
      throw new HuntError(
        'TIMEOUT',
        'The Hunt phase deadline was missed and the match was voided.',
        409,
        result.timeout.stateVersion,
      );
    if (!result.response) throw new Error('Hunt command returned no response.');
    return result.response;
  }

  /** Returns a complete reconstruction only after a match has ended. */
  reconstruction(matchId: string, actorId: string): HuntReconstruction {
    const id = requireText(matchId, 'Match id');
    const playerId = requireText(actorId, 'Player identity');
    return transaction(this.db, () => {
      const loaded = this.matchState(id);
      const expiration = this.withExpiration(loaded.row, loaded.state);
      const participant = loaded.participants.find((item) => item.participant_id === playerId);
      if (!participant)
        throw new HuntError('FORBIDDEN', 'This player is not in the Hunt match.', 403);
      const state = expiration.state;
      if (state.phase !== 'finished' && state.phase !== 'voided')
        throw new HuntError(
          'INVALID_PHASE',
          'The full Hunt reconstruction is available after the match ends.',
          409,
          state.stateVersion,
        );
      return {
        matchId: state.matchId,
        roomCode: state.roomCode,
        phase: state.phase,
        board: state.board,
        targets: state.targets,
        plans: state.plans,
        eventRecord: state.eventRecord,
        scans: state.scans,
        suspicions: state.suspicions,
        finalAccusation: state.finalAccusation,
        reveal: state.reveal,
        scores: state.scores,
        events: eventRecords(readHuntEvents(this.db, state.matchId)),
      };
    });
  }

  /** Frozen shared transport replay shape; use reconstruction for the internal full replay. */
  replay(matchId: string, actorId: string): readonly HuntReveal[] {
    const value = this.reconstruction(matchId, actorId);
    return value.reveal ? [value.reveal] : [];
  }
}

export { canonicalJson };
