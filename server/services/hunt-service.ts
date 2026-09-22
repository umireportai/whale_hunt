import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  HuntCommand,
  HuntMatchView,
  HuntQueueEntryView,
  HuntReveal,
  HuntReplaySummary,
} from '../../shared/hunt.js';
import { HUNT_RULES, type OpaqueId } from '../../shared/game-rules.js';
import { transaction } from '../db/store.js';
import {
  insertHuntEvent,
  insertHuntMatch,
  insertHuntParticipant,
  insertHuntRoom,
  readHuntMatch,
  readHuntParticipants,
  type HuntMatchRow,
  type HuntParticipantRow,
  type HuntRoomRow,
} from '../db/hunt.js';
import {
  HuntEngine,
  HuntError,
  HUNT_ENGINE_RULES,
  canonicalJson,
  createSyntheticHuntBoard,
} from '../domain/hunt/index.js';
import type { CompiledHuntBoard } from '../evidence/types.js';
import {
  chooseTracerFinalAccusation,
  chooseTracerScan,
  chooseTracerSuspicion,
  chooseWhalePlan,
  chooseWhaleTargets,
  sanitizeTracerObservation,
  sanitizeWhaleObservation,
  type BotDecision,
  type BotProgress,
} from '../bots/index.js';
import {
  insertHuntBotState,
  readHuntBotState,
  readHuntBotStates,
  type BotPersonality,
  type HuntBotStateRow,
} from '../matchmaking/store.js';
import {
  MatchmakingEngine,
  type MatchmakingQueueRequest,
  type MatchmakingRosterEntry,
  type MatchCreated,
} from '../matchmaking/engine.js';

export interface HuntServiceOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => OpaqueId;
  readonly botSeedFactory?: () => string;
  readonly boardFor?: (roomId: OpaqueId) => CompiledHuntBoard;
  readonly queueTimeoutMs?: number;
}

interface MatchParticipantSpec {
  readonly participantId: OpaqueId;
  readonly role: 'whale' | 'tracer';
  readonly kind: 'human' | 'computer';
  readonly displayName: string;
  readonly isCaptain: boolean;
  readonly personality?: BotPersonality;
}

function dateFrom(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new HuntError('INVALID_COMMAND', 'A valid Hunt service clock is required.', 500);
  return value;
}

function botCommand(
  decision: BotDecision,
  expectedStateVersion: number,
  idempotencyKey: string,
): HuntCommand {
  return {
    ...decision,
    expectedStateVersion,
    idempotencyKey,
  } as HuntCommand;
}

function personalityForTracer(index: number): BotPersonality {
  return (
    (
      ['flow-analyst', 'timing-analyst', 'concentration-analyst', 'skeptic', 'coordinator'] as const
    )[index] ?? 'coordinator'
  );
}

/** Coordinates persisted queue entries, Hunt command execution, and deterministic computer play. */
export class HuntService {
  readonly engine: HuntEngine;
  readonly matchmaking: MatchmakingEngine;
  private readonly clock: () => Date;
  private readonly idFactory: () => OpaqueId;
  private readonly botSeedFactory: () => string;
  private readonly boardFor: (roomId: OpaqueId) => CompiledHuntBoard;
  private readonly scheduler: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: DatabaseSync,
    options: HuntServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.botSeedFactory = options.botSeedFactory ?? randomUUID;
    this.boardFor = options.boardFor ?? ((roomId) => createSyntheticHuntBoard(`hunt-${roomId}`));
    this.engine = new HuntEngine(db, {
      clock: this.clock,
      idFactory: this.idFactory,
      boardFor: this.boardFor,
    });
    this.matchmaking = new MatchmakingEngine(db, {
      clock: this.clock,
      idFactory: this.idFactory,
      queueTimeoutMs: options.queueTimeoutMs,
      createMatch: (roster, maxTracers, now) => this.createMatch(roster, maxTracers, now),
    });
    this.scheduler = setInterval(() => this.tick(), 1_000);
    this.scheduler.unref?.();
  }

  /** Advances overdue matches from persisted deadlines even when no browser polls. */
  tick(): void {
    try {
      const rows = this.db
        .prepare("SELECT match_id FROM hunt_matches WHERE phase NOT IN ('finished','voided')")
        .all() as unknown as readonly { match_id: string }[];
      for (const row of rows) {
        const participant = readHuntParticipants(this.db, row.match_id)[0];
        if (!participant) continue;
        this.engine.getMatch(row.match_id, participant.participant_id);
        this.runBots(row.match_id);
      }
    } catch {
      /* A concurrent command or a just-closed database is resolved on its next tick. */
    }
  }

  dispose(): void {
    clearInterval(this.scheduler);
  }

  createRoom(...args: Parameters<HuntEngine['createRoom']>) {
    return this.engine.createRoom(...args);
  }
  joinRoom(...args: Parameters<HuntEngine['joinRoom']>) {
    return this.engine.joinRoom(...args);
  }
  replay(...args: Parameters<HuntEngine['replay']>) {
    return this.engine.replay(...args);
  }

  /** Allowlisted post-match explanation; source mappings and other players' suspicions stay private. */
  replaySummary(matchId: string, playerId: string): HuntReplaySummary {
    const record = this.engine.reconstruction(matchId, playerId);
    return {
      reveal: record.reveal,
      rounds: record.plans.map((plan) => {
        const suspicion = record.suspicions.find(
          (item) => item.roundIndex === plan.roundIndex && item.actorId === playerId,
        );
        return {
          roundIndex: plan.roundIndex,
          whaleAction: plan.action,
          ...(plan.assetId ? { whaleAssetId: plan.assetId } : {}),
          whaleUnits: plan.units,
          scans: record.scans
            .filter((scan) => scan.roundIndex === plan.roundIndex)
            .map((scan) => scan.scanId),
          pinnedEvidenceIds: [],
          suspicion: suspicion
            ? {
                primaryAssetId: suspicion.primaryAssetId,
                secondaryAssetId: suspicion.secondaryAssetId,
              }
            : null,
        };
      }),
      decisiveExplanation:
        record.reveal?.reason === 'targets-identified'
          ? 'The final pair identified both whale targets.'
          : record.reveal?.reason === 'objective-complete'
            ? 'The whale completed both positions and avoided the final pair.'
            : record.reveal?.reason === 'objective-incomplete'
              ? 'The whale did not complete both required positions.'
              : 'The match ended without a scored result.',
      distraction: record.plans.some((plan) => plan.action === 'decoy')
        ? 'Recorded decoy purchases left simulated footprints.'
        : 'No decoy purchase was recorded.',
      badges: [],
      score: { whale: record.scores?.whaleScore ?? 0, tracers: record.scores?.tracerScore ?? 0 },
    };
  }

  enqueue(playerId: string, command: MatchmakingQueueRequest): HuntQueueEntryView {
    const result = this.matchmaking.enqueue(playerId, command);
    if (result.matchId) this.runBots(result.matchId);
    return result.matchId ? this.matchmaking.status(result.queueId, playerId) : result;
  }

  status(queueId: string, playerId: string): HuntQueueEntryView {
    const result = this.matchmaking.status(queueId, playerId);
    if (result.matchId) this.runBots(result.matchId);
    return result.matchId ? this.matchmaking.status(queueId, playerId) : result;
  }

  cancel(queueId: string, playerId: string, command: Parameters<MatchmakingEngine['cancel']>[2]) {
    return this.matchmaking.cancel(queueId, playerId, command);
  }

  processQueue(): readonly MatchCreated[] {
    const created = this.matchmaking.processQueue();
    for (const match of created) this.runBots(match.matchId);
    return created;
  }

  getMatch(matchId: string, playerId: string): HuntMatchView {
    this.processQueue();
    this.runBots(matchId);
    return this.engine.getMatch(matchId, playerId);
  }

  command(matchId: string, playerId: string, command: HuntCommand): HuntMatchView | HuntReveal {
    const participant = readHuntParticipants(this.db, matchId).find(
      (item) => item.participant_id === playerId,
    );
    if (!participant)
      throw new HuntError('FORBIDDEN', 'This player is not in the Hunt match.', 403);
    if (participant.kind === 'computer')
      throw new HuntError('FORBIDDEN', 'A computer controls this Hunt seat.', 403);
    const result = this.engine.command(matchId, playerId, command);
    this.runBots(matchId);
    return result;
  }

  disconnect(matchId: string, playerId: string): HuntMatchView {
    return this.engine.disconnect(matchId, playerId);
  }

  reconnect(matchId: string, playerId: string): HuntMatchView {
    const result = this.engine.reconnect(matchId, playerId);
    this.runBots(matchId);
    return result;
  }

  /** Runs overdue substitutions and deterministic bot turns after a restart or poll. */
  resolveDeadlines(matchId: string): void {
    const now = dateFrom(this.clock).getTime();
    const participants = readHuntParticipants(this.db, matchId);
    for (const participant of participants) {
      if (
        participant.kind === 'human' &&
        participant.connection === 'reconnecting' &&
        Date.parse(participant.reconnect_until) <= now
      )
        this.engine.substituteParticipant(matchId, participant.participant_id);
      const substituted = readHuntParticipants(this.db, matchId).find(
        (item) => item.participant_id === participant.participant_id,
      );
      if (
        substituted?.kind === 'computer' &&
        !readHuntBotState(this.db, matchId, participant.participant_id)
      )
        insertHuntBotState(this.db, {
          match_id: matchId,
          participant_id: participant.participant_id,
          seed: this.botSeedFactory(),
          difficulty: 'standard',
          personality: participant.role === 'whale' ? 'coordinator' : 'flow-analyst',
          decision_index: 0,
          primary_units: 0,
          secondary_units: 0,
          decoy_units: 0,
          last_command_key: null,
        });
    }
  }

  private createMatch(
    roster: readonly MatchmakingRosterEntry[],
    maxTracers: 1 | 5,
    now: Date,
  ): MatchCreated {
    const matchId = this.idFactory();
    const roomId = this.idFactory();
    const roomCode = `HUNT-${roomId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
    const board = this.boardFor(roomId);
    if (board.assets.length < HUNT_RULES.assets || board.assets.length > HUNT_RULES.maxAssets)
      throw new HuntError('INVALID_COMMAND', 'A Hunt board must contain six to ten assets.', 500);
    const createdAt = now.toISOString();
    const reconnectUntil = new Date(
      now.getTime() + HUNT_ENGINE_RULES.reconnectGraceMs,
    ).toISOString();
    const participants = this.participantsFor(matchId, roster, maxTracers);
    const deadline = new Date(now.getTime() + HUNT_ENGINE_RULES.setupDurationMs).toISOString();
    const room: HuntRoomRow = {
      room_id: roomId,
      room_code: roomCode,
      max_tracers: maxTracers,
      phase: 'setup',
      state_version: participants.length,
      match_id: matchId,
      deadline_at: deadline,
      created_at: createdAt,
    };
    const match: HuntMatchRow = {
      match_id: matchId,
      room_id: roomId,
      room_code: roomCode,
      max_tracers: maxTracers,
      phase: 'setup',
      round_index: 0,
      state_version: participants.length,
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
      created_at: createdAt,
      completed_at: null,
    };
    insertHuntRoom(this.db, room);
    insertHuntMatch(this.db, match);
    participants.forEach((participant) => {
      insertHuntParticipant(this.db, {
        match_id: matchId,
        participant_id: participant.participantId,
        display_name: participant.displayName,
        role: participant.role,
        kind: participant.kind,
        connection: 'connected',
        is_captain: participant.isCaptain ? 1 : 0,
        reconnect_until: reconnectUntil,
      });
    });
    insertHuntEvent(this.db, {
      match_id: matchId,
      event_index: 0,
      round_index: 0,
      kind: 'room-created',
      visibility: 'system',
      actor_id: null,
      payload: canonicalJson({ roomId, roomCode, source: 'matchmaking' }),
      created_at: createdAt,
    });
    participants.slice(1).forEach((participant, index) =>
      insertHuntEvent(this.db, {
        match_id: matchId,
        event_index: index + 1,
        round_index: 0,
        kind: participant.kind === 'computer' ? 'computer-seated' : 'participant-joined',
        visibility: 'shared',
        actor_id: participant.participantId,
        payload: canonicalJson({ role: participant.role, kind: participant.kind }),
        created_at: createdAt,
      }),
    );
    participants
      .filter((participant) => participant.kind === 'computer')
      .forEach((participant) =>
        insertHuntBotState(this.db, {
          match_id: matchId,
          participant_id: participant.participantId,
          seed: this.botSeedFactory(),
          difficulty: 'standard',
          personality: participant.personality ?? 'coordinator',
          decision_index: 0,
          primary_units: 0,
          secondary_units: 0,
          decoy_units: 0,
          last_command_key: null,
        }),
      );
    return { matchId, roomCode };
  }

  private participantsFor(
    matchId: string,
    roster: readonly MatchmakingRosterEntry[],
    maxTracers: 1 | 5,
  ): readonly MatchParticipantSpec[] {
    const humanWhale = roster.find((entry) => entry.role === 'whale');
    const humanTracers = roster.filter((entry) => entry.role === 'tracer').slice(0, maxTracers);
    const participants: MatchParticipantSpec[] = [];
    if (humanWhale)
      participants.push({
        participantId: humanWhale.playerId,
        role: 'whale',
        kind: 'human',
        displayName: 'Whale',
        isCaptain: false,
      });
    else
      participants.push({
        participantId: `computer:${matchId}:whale`,
        role: 'whale',
        kind: 'computer',
        displayName: 'Computer Whale',
        isCaptain: false,
        personality: 'coordinator',
      });
    humanTracers.forEach((entry, index) =>
      participants.push({
        participantId: entry.playerId,
        role: 'tracer',
        kind: 'human',
        displayName: `Tracer ${index + 1}`,
        isCaptain: index === 0,
      }),
    );
    for (let index = humanTracers.length; index < maxTracers; index += 1)
      participants.push({
        participantId: `computer:${matchId}:tracer:${index + 1}`,
        role: 'tracer',
        kind: 'computer',
        displayName: `Computer Tracer ${index + 1}`,
        isCaptain: index === 0,
        personality: personalityForTracer(index),
      });
    return participants;
  }

  private runBots(matchId: string): void {
    this.resolveDeadlines(matchId);
    const initial = readHuntMatch(this.db, matchId);
    const yieldingForReconnect = readHuntParticipants(this.db, matchId).some(
      (participant) => participant.connection === 'substituted',
    );
    for (let turn = 0; turn < 64; turn += 1) {
      const action = this.nextBotAction(matchId);
      if (!action) return;
      this.submitBotAction(matchId, action.participantId, action.decision, action.stateVersion);
      if (yieldingForReconnect && readHuntMatch(this.db, matchId)?.phase !== initial?.phase) return;
    }
  }

  private nextBotAction(matchId: string): {
    readonly participantId: string;
    readonly decision: BotDecision;
    readonly stateVersion: number;
  } | null {
    const match = readHuntMatch(this.db, matchId);
    if (!match || match.phase === 'finished' || match.phase === 'voided') return null;
    const participants = readHuntParticipants(this.db, matchId);
    const botStates = readHuntBotStates(this.db, matchId);
    for (const participant of participants.filter((item) => item.kind === 'computer')) {
      const botState = botStates.find((item) => item.participant_id === participant.participant_id);
      if (!botState) continue;
      const view = this.engine.getMatch(matchId, participant.participant_id);
      if (view.viewerRole === 'whale' && view.phase === 'setup') {
        const observation = sanitizeWhaleObservation(view, botState.seed, this.progress(botState));
        if (!observation.ownTargets)
          return {
            participantId: participant.participant_id,
            decision: chooseWhaleTargets(observation),
            stateVersion: view.stateVersion,
          };
      }
      if (view.viewerRole === 'whale' && view.phase === 'whale-planning') {
        const observation = sanitizeWhaleObservation(view, botState.seed, this.progress(botState));
        return {
          participantId: participant.participant_id,
          decision: chooseWhalePlan(observation),
          stateVersion: view.stateVersion,
        };
      }
      if (
        (view.viewerRole === 'tracer' || view.viewerRole === 'captain') &&
        view.phase === 'tracer-investigation'
      ) {
        const observation = sanitizeTracerObservation(
          view,
          botState.seed,
          botState.personality,
          botState.decision_index,
        );
        const scan = chooseTracerScan(observation);
        if (scan)
          return {
            participantId: participant.participant_id,
            decision: scan,
            stateVersion: view.stateVersion,
          };
        if (!view.ownSuspicion)
          return {
            participantId: participant.participant_id,
            decision: chooseTracerSuspicion(observation),
            stateVersion: view.stateVersion,
          };
        if (view.viewerRole === 'captain' && this.allTracersHaveSuspicion(matchId, view.roundIndex))
          return {
            participantId: participant.participant_id,
            decision: { kind: 'finish-investigation', roundIndex: view.roundIndex },
            stateVersion: view.stateVersion,
          };
      }
      if (
        (view.viewerRole === 'captain' || view.viewerRole === 'tracer') &&
        view.phase === 'final-accusation' &&
        view.viewerRole === 'captain'
      ) {
        const observation = sanitizeTracerObservation(
          view,
          botState.seed,
          botState.personality,
          botState.decision_index,
        );
        return {
          participantId: participant.participant_id,
          decision: chooseTracerFinalAccusation(observation),
          stateVersion: view.stateVersion,
        };
      }
    }
    return null;
  }

  private submitBotAction(
    matchId: string,
    participantId: string,
    decision: BotDecision,
    stateVersion: number,
  ): void {
    const state = readHuntBotState(this.db, matchId, participantId);
    if (!state) throw new HuntError('NOT_FOUND', 'Computer state is missing.', 500);
    const key = `bot:${participantId}:${state.decision_index}:${decision.kind}`;
    const result = this.engine.command(
      matchId,
      participantId,
      botCommand(decision, stateVersion, key),
    );
    if (state.last_command_key === key) return;
    const next = this.nextBotState(state, decision, result);
    transaction(this.db, () => {
      const latest = readHuntBotState(this.db, matchId, participantId);
      if (!latest || latest.last_command_key === key) return;
      insertOrUpdateBotState(this.db, next);
    });
  }

  private nextBotState(
    state: HuntBotStateRow,
    decision: BotDecision,
    result: HuntMatchView | HuntReveal,
  ): HuntBotStateRow {
    const view = 'stateVersion' in result ? result : null;
    const current = view?.viewerRole === 'whale' ? view.ownTargets : null;
    const primaryUnits =
      decision.kind === 'submit-whale-plan' &&
      current &&
      decision.assetId === current.primaryAssetId
        ? state.primary_units + decision.units
        : state.primary_units;
    const secondaryUnits =
      decision.kind === 'submit-whale-plan' &&
      current &&
      decision.assetId === current.secondaryAssetId
        ? state.secondary_units + decision.units
        : state.secondary_units;
    const decoyUnits =
      decision.kind === 'submit-whale-plan' && decision.action === 'decoy'
        ? state.decoy_units + decision.units
        : state.decoy_units;
    return {
      ...state,
      decision_index: state.decision_index + 1,
      primary_units: primaryUnits,
      secondary_units: secondaryUnits,
      decoy_units: decoyUnits,
      last_command_key: `bot:${state.participant_id}:${state.decision_index}:${decision.kind}`,
    };
  }

  private progress(state: HuntBotStateRow): BotProgress {
    return {
      primaryUnits: state.primary_units,
      secondaryUnits: state.secondary_units,
      decoyUnits: state.decoy_units,
      decisionIndex: state.decision_index,
    };
  }

  private allTracersHaveSuspicion(matchId: string, roundIndex: number): boolean {
    const match = readHuntMatch(this.db, matchId);
    if (!match) return false;
    const parsed = JSON.parse(match.suspicions_payload) as readonly {
      roundIndex: number;
      actorId: string;
    }[];
    return readHuntParticipants(this.db, matchId)
      .filter((participant) => participant.role === 'tracer')
      .every((participant) =>
        parsed.some(
          (suspicion) =>
            suspicion.roundIndex === roundIndex && suspicion.actorId === participant.participant_id,
        ),
      );
  }
}

function insertOrUpdateBotState(db: DatabaseSync, row: HuntBotStateRow): void {
  const existing = readHuntBotState(db, row.match_id, row.participant_id);
  if (!existing) insertHuntBotState(db, row);
  else
    db.prepare(
      `UPDATE hunt_bot_state SET decision_index=?,primary_units=?,secondary_units=?,decoy_units=?,last_command_key=?
       WHERE match_id=? AND participant_id=?`,
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

export { initializeMatchmakingDatabase } from '../matchmaking/store.js';
