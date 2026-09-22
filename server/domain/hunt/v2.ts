import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateHuntV2Command,
  HuntV2Command,
  HuntV2MatchView,
  HuntV2Move,
  HuntV2Phase,
  HuntV2Role,
  HuntV2RoundReason,
  HuntV2RoundResult,
  HuntV2ScanKind,
  HuntV2ScanResult,
  HuntV2Window,
  HuntV2Zone,
} from '../../../shared/hunt-v2.js';
import { HUNT_V2_MOVES, HUNT_V2_ZONES } from '../../../shared/hunt-v2.js';
import {
  insertHuntV2Command,
  insertHuntV2Match,
  readHuntV2Command,
  readHuntV2Match,
  updateHuntV2Match,
  type HuntV2MatchRow,
} from '../../db/hunt-v2.js';
import { transaction } from '../../db/store.js';

export const HUNT_V2_TIMING = {
  introMs: 2_000,
  hideMs: 30_000,
  huntMs: 45_000,
  revealMs: 12_000,
  scanCharges: 3,
  totalRounds: 3,
  pointsToWin: 3,
} as const;

export type HuntV2BoardFactory = (matchId: string, roundIndex: number) => readonly HuntV2Window[];

export type HuntV2ErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_PHASE'
  | 'STALE_STATE'
  | 'DUPLICATE_COMMAND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'ALREADY_COMPLETE';

export class HuntV2Error extends Error {
  constructor(
    readonly code: HuntV2ErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
    readonly stateVersion?: number,
  ) {
    super(message);
    this.name = 'HuntV2Error';
  }
}

interface HuntV2Selection {
  readonly zone: HuntV2Zone;
  readonly move: HuntV2Move;
  readonly decoyZone: HuntV2Zone | null;
}

interface HuntV2RoundState {
  readonly roundIndex: number;
  readonly windows: readonly HuntV2Window[];
  readonly selection: HuntV2Selection | null;
  readonly hiddenZone: HuntV2Zone | null;
  readonly whaleMove: HuntV2Move | null;
  readonly decoyZone: HuntV2Zone | null;
  readonly selectedZone: HuntV2Zone | null;
  readonly scans: readonly HuntV2ScanResult[];
  readonly result: HuntV2RoundResult | null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseRounds(row: HuntV2MatchRow): HuntV2RoundState[] {
  return JSON.parse(row.rounds_payload) as HuntV2RoundState[];
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function opposite(role: HuntV2Role): HuntV2Role {
  return role === 'whale' ? 'tracer' : 'whale';
}

function hash(seed: string): number {
  let value = 2_166_136_261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

function zoneFor(seed: string): HuntV2Zone {
  return HUNT_V2_ZONES[hash(seed) % HUNT_V2_ZONES.length]!;
}

function otherZone(zone: HuntV2Zone): HuntV2Zone {
  return zone === 'A' ? 'B' : 'A';
}

function noise(seed: string, index: number): number {
  return (hash(`${seed}:${index}`) % 10_000) / 10_000 - 0.5;
}

function movePulseIndices(length: number, move: HuntV2Move, decoy: boolean): number[] {
  const fractions = decoy
    ? [0.56, 0.64]
    : move === 'burst'
      ? [0.48, 0.58]
      : move === 'drip'
        ? [0.22, 0.34, 0.46, 0.58, 0.7, 0.82]
        : move === 'wait'
          ? [0.68, 0.76, 0.84, 0.92]
          : [0.18, 0.34, 0.5, 0.66, 0.82];
  return [...new Set(fractions.map((fraction) => Math.round(fraction * Math.max(1, length - 1))))];
}

function baseWindows(seed: string): HuntV2Window[] {
  return HUNT_V2_ZONES.map((zone, index) => {
    const regime = hash(`${seed}:${zone}:regime`) % 5;
    const prices: number[] = [];
    const volume: number[] = [];
    const anchor = 92 + (hash(`${seed}:${zone}:anchor`) % 18);
    let level = anchor;
    for (let point = 0; point < 18; point += 1) {
      const random = noise(`${seed}:${zone}`, point);
      const wave = Math.sin(point * (0.55 + index * 0.12) + regime) * (0.12 + index * 0.06);
      const drift =
        regime === 0
          ? 0.42
          : regime === 1
            ? -0.34
            : regime === 2
              ? (anchor - level) * 0.08
              : regime === 3
                ? point === 9
                  ? 2.3
                  : 0.12
                : random * 1.6;
      level = Math.max(10, level + drift + random * (regime === 4 ? 1.8 : 0.55) + wave);
      prices.push(Number(level.toFixed(4)));
      const volumeSpike = regime === 3 && (point === 9 || point === 10) ? 620 : 0;
      volume.push(
        Math.round(260 + index * 60 + Math.abs(drift) * 150 + Math.abs(random) * 90 + volumeSpike),
      );
    }
    return { zone, price: prices, volume, pulseIndices: [] };
  });
}

function applyMove(windows: readonly HuntV2Window[], selection: HuntV2Selection): HuntV2Window[] {
  return windows.map((window) => {
    const isHidden = window.zone === selection.zone;
    const isDecoy = selection.move === 'decoy' && window.zone === selection.decoyZone;
    if (!isHidden && !isDecoy) return window;
    const pulseIndices = movePulseIndices(window.price.length, selection.move, isDecoy);
    const volumeBoost = isDecoy
      ? 820
      : selection.move === 'burst'
        ? 980
        : selection.move === 'drip'
          ? 90
          : selection.move === 'wait'
            ? 150
            : 210;
    return {
      ...window,
      price: window.price.map((value, index) => {
        if (index < pulseIndices[0]!) return value;
        if (isDecoy) return value + (index === pulseIndices.at(-1) ? 3.5 : 1.1);
        const multiplier =
          selection.move === 'burst' ? 0.72 : selection.move === 'drip' ? 0.12 : 0.3;
        return value + (index - pulseIndices[0] + 1) * multiplier;
      }),
      volume: window.volume.map((value, index) =>
        pulseIndices.includes(index) ? value + volumeBoost : value,
      ),
      pulseIndices,
    };
  });
}

function makeRound(
  matchId: string,
  roundIndex: number,
  boardFactory: HuntV2BoardFactory = (_matchId, _roundIndex) =>
    baseWindows(`${matchId}:${roundIndex}`),
): HuntV2RoundState {
  return {
    roundIndex,
    windows: boardFactory(matchId, roundIndex),
    selection: null,
    hiddenZone: null,
    whaleMove: null,
    decoyZone: null,
    selectedZone: null,
    scans: [],
    result: null,
  };
}

function deadlineAt(now: Date, duration: number): string {
  return new Date(now.getTime() + duration).toISOString();
}

function phaseDuration(phase: HuntV2Phase): number {
  if (phase === 'round_intro') return HUNT_V2_TIMING.introMs;
  if (phase === 'whale_hide') return HUNT_V2_TIMING.hideMs;
  if (phase === 'tracer_hunt') return HUNT_V2_TIMING.huntMs;
  if (phase === 'round_reveal') return HUNT_V2_TIMING.revealMs;
  return 0;
}

function fallbackZone(row: HuntV2MatchRow): HuntV2Zone {
  return zoneFor(`${row.match_id}:${row.round_index}:fallback`);
}

function resultFor(
  row: HuntV2MatchRow,
  round: HuntV2RoundState,
  winner: HuntV2Role,
  reason: HuntV2RoundReason,
  score: { whale: number; tracer: number },
  selectedZone: HuntV2Zone | null,
): HuntV2RoundResult {
  const hiddenZone = round.hiddenZone ?? round.selection?.zone ?? fallbackZone(row);
  const move = round.whaleMove ?? round.selection?.move ?? null;
  const decoyZone = round.decoyZone ?? round.selection?.decoyZone ?? null;
  const selectedMarket = selectedZone
    ? round.windows.find((window) => window.zone === selectedZone)?.market
    : undefined;
  const selectedAsset = selectedZone
    ? selectedMarket
      ? {
          zone: selectedZone,
          symbol: selectedMarket.symbol,
          name: selectedMarket.name,
          chain: selectedMarket.chain,
        }
      : {
          zone: selectedZone,
          symbol: `SIGNAL ${selectedZone}`,
          name: `Zone ${selectedZone}`,
          chain: 'current',
        }
    : null;
  const decisiveScan: HuntV2ScanKind =
    move === 'burst'
      ? 'concentration'
      : move === 'drip'
        ? 'rhythm'
        : move === 'blend'
          ? 'flow'
          : move === 'decoy'
            ? 'cross-asset'
            : 'timing';
  let explanation = '';
  if (reason === 'caught')
    explanation = `The tracer locked ${selectedZone}; the ${SCAN_LABELS[decisiveScan].toLowerCase()} read separated the real footprint from the noise in ${hiddenZone}.`;
  else if (reason === 'escaped')
    explanation = `The large pulse in ${decoyZone ?? otherZone(hiddenZone)} was a decoy. The whale blended the real trade into ${hiddenZone}; a ${SCAN_LABELS[decisiveScan].toLowerCase()} scan would have exposed it.`;
  else if (reason === 'whale-timeout')
    explanation = 'The whale missed the hide deadline; the tracer wins by timeout.';
  else if (reason === 'tracer-timeout')
    explanation = `The tracer ran out of time. The whale was hidden in ${hiddenZone}; the missing clue was ${SCAN_LABELS[decisiveScan].toLowerCase()}.`;
  else explanation = `The match ended by forfeit. The hidden zone was ${hiddenZone}.`;
  return {
    roundIndex: round.roundIndex,
    hiddenZone,
    selectedZone,
    selectedAsset,
    winner,
    reason,
    explanation,
    whaleMove: move,
    decoyZone,
    decisiveScan,
    score,
  };
}

const SCAN_LABELS: Record<HuntV2ScanKind, string> = {
  flow: 'Flow',
  concentration: 'Concentration',
  rhythm: 'Rhythm',
  timing: 'Timing',
  'cross-asset': 'Cross-signal',
  'position-growth': 'Position growth',
};

function scoredRound(
  row: HuntV2MatchRow,
  round: HuntV2RoundState,
  winner: HuntV2Role,
  reason: HuntV2RoundReason,
  selectedZone: HuntV2Zone | null,
): HuntV2RoundState {
  const score = {
    whale: row.score_whale + (winner === 'whale' ? 1 : 0),
    tracer: row.score_tracer + (winner === 'tracer' ? 1 : 0),
  };
  return {
    ...round,
    selectedZone,
    result: resultFor(row, round, winner, reason, score, selectedZone),
  };
}

function validateZone(zone: HuntV2Zone): void {
  if (!HUNT_V2_ZONES.includes(zone))
    throw new HuntV2Error('INVALID_COMMAND', 'Choose zone A, B, or C.');
}

function validateStateVersion(row: HuntV2MatchRow, expected: number): void {
  if (row.state_version !== expected)
    throw new HuntV2Error(
      'STALE_STATE',
      'The Hunt state changed. Refresh Whale Hunt and try again.',
      409,
      true,
      row.state_version,
    );
}

function roleFor(row: HuntV2MatchRow, actorId: string): HuntV2Role {
  if (actorId === row.player_id) return row.player_role;
  if (actorId === row.opponent_id) return opposite(row.player_role);
  throw new HuntV2Error('FORBIDDEN', 'This player is not in the Hunt match.', 403);
}

function currentRound(row: HuntV2MatchRow): HuntV2RoundState {
  const round = parseRounds(row)[row.round_index - 1];
  if (!round) throw new HuntV2Error('NOT_FOUND', 'The Hunt round is missing.', 500);
  return round;
}

function replaceCurrentRound(row: HuntV2MatchRow, nextRound: HuntV2RoundState): void {
  const rounds = parseRounds(row);
  rounds[row.round_index - 1] = nextRound;
  row.rounds_payload = json(rounds);
}

function advanceExpired(row: HuntV2MatchRow, now: Date, boardFactory: HuntV2BoardFactory): boolean {
  if (!row.deadline_at || Date.parse(row.deadline_at) > now.getTime()) return false;
  const round = currentRound(row);
  if (row.phase === 'round_intro') {
    row.phase = 'whale_hide';
    row.deadline_at = deadlineAt(now, HUNT_V2_TIMING.hideMs);
    row.state_version += 1;
    return true;
  }
  if (row.phase === 'round_reveal') {
    if (
      row.score_whale >= HUNT_V2_TIMING.pointsToWin ||
      row.score_tracer >= HUNT_V2_TIMING.pointsToWin ||
      row.round_index >= HUNT_V2_TIMING.totalRounds
    ) {
      row.phase = 'match_over';
      row.deadline_at = null;
      row.completed_at = nowIso(now);
    } else {
      row.round_index += 1;
      row.phase = 'round_intro';
      row.deadline_at = deadlineAt(now, HUNT_V2_TIMING.introMs);
      const rounds = parseRounds(row);
      rounds.push(makeRound(row.match_id, row.round_index, boardFactory));
      row.rounds_payload = json(rounds);
    }
    row.state_version += 1;
    return true;
  }
  if (row.phase !== 'whale_hide' && row.phase !== 'tracer_hunt') return false;
  const winner: HuntV2Role = row.phase === 'whale_hide' ? 'tracer' : 'whale';
  const reason: HuntV2RoundReason = row.phase === 'whale_hide' ? 'whale-timeout' : 'tracer-timeout';
  const nextRound = scoredRound(row, round, winner, reason, null);
  replaceCurrentRound(row, nextRound);
  row.score_whale += winner === 'whale' ? 1 : 0;
  row.score_tracer += winner === 'tracer' ? 1 : 0;
  if (
    row.score_whale >= HUNT_V2_TIMING.pointsToWin ||
    row.score_tracer >= HUNT_V2_TIMING.pointsToWin ||
    row.round_index >= HUNT_V2_TIMING.totalRounds
  ) {
    row.phase = 'match_over';
    row.deadline_at = null;
    row.completed_at = nowIso(now);
  } else {
    row.phase = 'round_reveal';
    row.deadline_at = deadlineAt(now, HUNT_V2_TIMING.revealMs);
  }
  row.state_version += 1;
  return true;
}

function scanResult(
  round: HuntV2RoundState,
  zone: HuntV2Zone,
  kind: HuntV2ScanKind,
): HuntV2ScanResult {
  const hidden = round.hiddenZone === zone;
  const decoy = round.decoyZone === zone && round.whaleMove === 'decoy';
  const marketContext = round.windows.find((window) => window.zone === zone)?.market;
  const marketSignal = marketContext?.smartMoney;
  const whalePressure = marketContext?.whalePressure;
  const providerMetrics = whalePressure
    ? [
        {
          label: 'Whale pressure',
          value: `${whalePressure.netUsd >= 0 ? '+' : '−'}$${Math.round(Math.abs(whalePressure.netUsd)).toLocaleString()}`,
        },
        { label: 'Smart prints', value: String(whalePressure.tradeCount ?? '—') },
      ]
    : [];
  const signal =
    marketSignal?.direction === 'accumulating'
      ? 'Accumulating'
      : marketSignal?.direction === 'distributing'
        ? 'Distributing'
        : marketSignal?.direction === 'mixed'
          ? 'Mixed'
          : 'Unavailable';
  const strength = hidden ? 'strong' : decoy ? 'short-lived' : 'unclear';
  const resultByKind: Record<
    HuntV2ScanKind,
    { headline: string; detail: string; metrics: HuntV2ScanResult['metrics'] }
  > = {
    flow: {
      headline: hidden
        ? 'Buying accumulated here.'
        : decoy
          ? 'A large pulse faded quickly.'
          : 'Flow stayed mixed.',
      detail: hidden
        ? 'Several smaller buys kept adding to the position after the first pulse.'
        : decoy
          ? 'The largest volume burst was not followed by sustained accumulation.'
          : 'The observed buying and selling traded places without a clear build.',
      metrics: [
        { label: 'Smart money', value: signal },
        {
          label: 'Read',
          value: strength === 'strong' ? 'Position building' : 'No sustained build',
        },
        ...providerMetrics,
      ],
    },
    concentration: {
      headline: hidden
        ? 'Activity spread across several prints.'
        : decoy
          ? 'One pulse dominates the window.'
          : 'No dominant print found.',
      detail: hidden
        ? 'The largest print is supported by smaller activity instead of standing alone.'
        : decoy
          ? 'A single large volume event carries most of the observed activity.'
          : 'Volume is distributed close to the window baseline.',
      metrics: [
        { label: 'Shape', value: hidden ? 'Distributed' : decoy ? 'Concentrated' : 'Balanced' },
        { label: 'Signal', value: strength },
      ],
    },
    rhythm: {
      headline: hidden
        ? 'Buying repeats across the window.'
        : decoy
          ? 'Activity arrives in one burst.'
          : 'No repeated accumulation.',
      detail: hidden
        ? 'The footprint returns at several intervals instead of appearing as one isolated print.'
        : decoy
          ? 'The largest pulse is not followed by the same rhythm later in the window.'
          : 'Pulses remain close to the background rhythm.',
      metrics: [
        { label: 'Pattern', value: hidden ? 'Repeated' : decoy ? 'Single burst' : 'Baseline' },
        { label: 'Persistence', value: hidden ? 'High' : 'Low' },
      ],
    },
    timing: {
      headline: hidden
        ? 'The move builds late.'
        : decoy
          ? 'The move arrives early and fades.'
          : 'Timing is inconclusive.',
      detail: hidden
        ? 'Later prints continue after the first visible activity, which supports a staged entry.'
        : decoy
          ? 'The first large event is not confirmed by later activity.'
          : 'The activity does not separate clearly from the surrounding interval.',
      metrics: [
        { label: 'Window bias', value: hidden ? 'Late' : decoy ? 'Early' : 'Even' },
        { label: 'Follow-through', value: hidden ? 'Present' : 'Missing' },
      ],
    },
    'cross-asset': {
      headline: hidden
        ? 'This window leads the board.'
        : decoy
          ? 'The board moved together.'
          : 'No isolated board leader.',
      detail: hidden
        ? 'Its activity remains stronger after comparing the three public windows on the same scale.'
        : decoy
          ? 'The large print is less distinctive because nearby windows also moved during the interval.'
          : 'The public windows do not show a decisive lead from this location.',
      metrics: [
        { label: 'Board read', value: hidden ? 'Leading' : decoy ? 'Shared move' : 'Unclear' },
        { label: 'Comparison', value: 'Three windows' },
      ],
    },
    'position-growth': {
      headline: hidden
        ? 'The position keeps growing.'
        : decoy
          ? 'The pulse does not grow.'
          : 'Growth is unconfirmed.',
      detail: hidden
        ? 'Price and volume continue in the same direction after the initial activity.'
        : decoy
          ? 'The superficial pulse does not produce a matching continuation.'
          : 'The window does not show enough follow-through to call a growing position.',
      metrics: [
        { label: 'Growth', value: hidden ? 'Sustained' : decoy ? 'Stopped' : 'Unconfirmed' },
        { label: 'Smart money', value: signal },
        ...(marketContext?.whalePositionUsd
          ? [
              {
                label: 'Modeled stake',
                value: `$${Math.round(marketContext.whalePositionUsd).toLocaleString()}`,
              },
            ]
          : []),
      ],
    },
  };
  const result = resultByKind[kind];
  return { zone, kind, ...result };
}

function publicRoundResults(rounds: readonly HuntV2RoundState[]): readonly HuntV2RoundResult[] {
  return rounds.flatMap((round) => (round.result ? [round.result] : []));
}

export class HuntV2Engine {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly boardFactory: HuntV2BoardFactory;

  constructor(
    private readonly db: DatabaseSync,
    options: {
      readonly clock?: () => Date;
      readonly idFactory?: () => string;
      readonly boardFactory?: HuntV2BoardFactory;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.boardFactory =
      options.boardFactory ?? ((matchId, roundIndex) => baseWindows(`${matchId}:${roundIndex}`));
  }

  createMatch(playerId: string, command: CreateHuntV2Command): HuntV2MatchView {
    const matchId = this.idFactory();
    const now = this.clock();
    const opponentId = `computer:${matchId}`;
    const row: HuntV2MatchRow = {
      match_id: matchId,
      player_id: playerId,
      opponent_id: opponentId,
      player_role: command.role,
      phase: 'round_intro',
      round_index: 1,
      state_version: 1,
      deadline_at: deadlineAt(now, HUNT_V2_TIMING.introMs),
      rounds_payload: json([makeRound(matchId, 1, this.boardFactory)]),
      score_whale: 0,
      score_tracer: 0,
      created_at: nowIso(now),
      completed_at: null,
    };
    transaction(this.db, () => insertHuntV2Match(this.db, row));
    return this.view(row, playerId, now);
  }

  joinMatch(matchId: string, actorId: string): HuntV2MatchView {
    const now = this.clock();
    let row: HuntV2MatchRow | undefined;
    transaction(this.db, () => {
      row = readHuntV2Match(this.db, matchId);
      if (!row) throw new HuntV2Error('NOT_FOUND', 'Hunt match not found.', 404);
      if (row.player_id === actorId || row.opponent_id === actorId) return;
      if (!row.opponent_id.startsWith('computer:'))
        throw new HuntV2Error('FORBIDDEN', 'This Hunt already has two players.', 409);
      if (row.phase !== 'round_intro')
        throw new HuntV2Error('INVALID_PHASE', 'A human player must join before the round starts.');
      row.opponent_id = actorId;
      row.state_version += 1;
      updateHuntV2Match(this.db, row);
    });
    if (!row) throw new HuntV2Error('NOT_FOUND', 'Hunt match not found.', 404);
    return this.view(row, actorId, now);
  }

  getMatch(matchId: string, actorId: string): HuntV2MatchView {
    const now = this.clock();
    let row: HuntV2MatchRow | undefined;
    transaction(this.db, () => {
      row = readHuntV2Match(this.db, matchId);
      if (!row) throw new HuntV2Error('NOT_FOUND', 'Hunt match not found.', 404);
      roleFor(row, actorId);
      if (advanceExpired(row, now, this.boardFactory)) updateHuntV2Match(this.db, row);
    });
    if (!row) throw new HuntV2Error('NOT_FOUND', 'Hunt match not found.', 404);
    return this.view(row, actorId, now);
  }

  command(matchId: string, actorId: string, command: HuntV2Command): HuntV2MatchView {
    const now = this.clock();
    let response: HuntV2MatchView | undefined;
    transaction(this.db, () => {
      const row = readHuntV2Match(this.db, matchId);
      if (!row) throw new HuntV2Error('NOT_FOUND', 'Hunt match not found.', 404);
      const role = roleFor(row, actorId);
      const payload = json(command);
      const existing = readHuntV2Command(this.db, matchId, command.idempotencyKey);
      if (existing) {
        if (existing.actor_id !== actorId || existing.payload !== payload)
          throw new HuntV2Error('IDEMPOTENCY_CONFLICT', 'This command key was already used.', 409);
        response = JSON.parse(existing.response) as HuntV2MatchView;
        return;
      }
      if (advanceExpired(row, now, this.boardFactory)) updateHuntV2Match(this.db, row);
      validateStateVersion(row, command.expectedStateVersion);
      if (row.phase === 'match_over')
        throw new HuntV2Error('ALREADY_COMPLETE', 'This Hunt match is complete.', 409);
      const round = currentRound(row);
      if (command.kind === 'select-whale-plan') {
        if (role !== 'whale' || row.phase !== 'whale_hide')
          throw new HuntV2Error(
            'INVALID_PHASE',
            'The whale can choose a plan during the hide phase.',
          );
        validateZone(command.zone);
        const move = command.move;
        if (!move || !HUNT_V2_MOVES.includes(move))
          throw new HuntV2Error('INVALID_COMMAND', 'Choose a valid whale move.');
        if (move === 'decoy') {
          if (!command.decoyZone || command.decoyZone === command.zone)
            throw new HuntV2Error('INVALID_COMMAND', 'Choose a second zone for the decoy.');
          validateZone(command.decoyZone);
        }
        replaceCurrentRound(row, {
          ...round,
          selection: {
            zone: command.zone,
            move,
            decoyZone: move === 'decoy' ? (command.decoyZone ?? null) : null,
          },
        });
        row.state_version += 1;
      } else if (command.kind === 'hide-trade') {
        if (role !== 'whale' || row.phase !== 'whale_hide')
          throw new HuntV2Error('INVALID_PHASE', 'The whale is not hiding right now.');
        if (!round.selection)
          throw new HuntV2Error('INVALID_COMMAND', 'Choose a zone and move first.');
        replaceCurrentRound(row, {
          ...round,
          windows: applyMove(round.windows, round.selection),
          hiddenZone: round.selection.zone,
          whaleMove: round.selection.move,
          decoyZone: round.selection.decoyZone,
        });
        row.phase = 'tracer_hunt';
        row.deadline_at = deadlineAt(now, HUNT_V2_TIMING.huntMs);
        row.state_version += 1;
      } else if (command.kind === 'scan') {
        if (role !== 'tracer' || row.phase !== 'tracer_hunt')
          throw new HuntV2Error('INVALID_PHASE', 'Scans are available during the tracer hunt.');
        validateZone(command.zone);
        const previous = round.scans.find(
          (scan) => scan.zone === command.zone && scan.kind === command.scan,
        );
        if (previous) {
          response = this.view(row, actorId, now);
        } else {
          if (round.scans.length >= HUNT_V2_TIMING.scanCharges)
            throw new HuntV2Error('INVALID_COMMAND', 'No scan charges remain.');
          replaceCurrentRound(row, {
            ...round,
            scans: [...round.scans, scanResult(round, command.zone, command.scan)],
          });
          row.state_version += 1;
        }
      } else if (command.kind === 'lock-catch') {
        if (role !== 'tracer' || row.phase !== 'tracer_hunt')
          throw new HuntV2Error('INVALID_PHASE', 'The tracer is not locking a catch right now.');
        validateZone(command.zone);
        const winner: HuntV2Role = command.zone === round.hiddenZone ? 'tracer' : 'whale';
        const reason: HuntV2RoundReason = winner === 'tracer' ? 'caught' : 'escaped';
        const nextRound = scoredRound(row, round, winner, reason, command.zone);
        replaceCurrentRound(row, nextRound);
        row.score_whale += winner === 'whale' ? 1 : 0;
        row.score_tracer += winner === 'tracer' ? 1 : 0;
        if (
          row.score_whale >= HUNT_V2_TIMING.pointsToWin ||
          row.score_tracer >= HUNT_V2_TIMING.pointsToWin ||
          row.round_index >= HUNT_V2_TIMING.totalRounds
        ) {
          row.phase = 'match_over';
          row.deadline_at = null;
          row.completed_at = nowIso(now);
        } else {
          row.phase = 'round_reveal';
          row.deadline_at = deadlineAt(now, HUNT_V2_TIMING.revealMs);
        }
        row.state_version += 1;
      } else if (command.kind === 'forfeit') {
        const winner = opposite(role);
        const nextRound = scoredRound(row, round, winner, 'forfeit', null);
        replaceCurrentRound(row, nextRound);
        row.score_whale += winner === 'whale' ? 1 : 0;
        row.score_tracer += winner === 'tracer' ? 1 : 0;
        row.phase = 'match_over';
        row.deadline_at = null;
        row.completed_at = nowIso(now);
        row.state_version += 1;
      }
      updateHuntV2Match(this.db, row);
      response = this.view(row, actorId, now);
      insertHuntV2Command(this.db, {
        match_id: matchId,
        idempotency_key: command.idempotencyKey,
        actor_id: actorId,
        payload,
        response: json(response),
        created_at: nowIso(now),
      });
    });
    if (!response)
      throw new HuntV2Error('INVALID_COMMAND', 'The Hunt command had no response.', 500);
    return response;
  }

  rematch(matchId: string, actorId: string, idempotencyKey: string): HuntV2MatchView {
    const existing = readHuntV2Match(this.db, matchId);
    if (!existing) throw new HuntV2Error('NOT_FOUND', 'Hunt match not found.', 404);
    const role = roleFor(existing, actorId);
    if (existing.phase !== 'match_over')
      throw new HuntV2Error('INVALID_PHASE', 'A rematch is available after the match ends.');
    return this.createMatch(actorId, { role: opposite(role), idempotencyKey });
  }

  tick(): void {
    const now = this.clock();
    const rows = this.db
      .prepare("SELECT match_id FROM hunt_v2_matches WHERE phase <> 'match_over'")
      .all() as unknown as readonly { match_id: string }[];
    for (const row of rows) {
      try {
        this.getMatch(row.match_id, readHuntV2Match(this.db, row.match_id)?.player_id ?? '');
      } catch {
        /* Another command may own the transaction; the next tick can retry. */
      }
    }
    void now;
  }

  private view(row: HuntV2MatchRow, actorId: string, now: Date): HuntV2MatchView {
    const role = roleFor(row, actorId);
    const rounds = parseRounds(row);
    const round = rounds[row.round_index - 1]!;
    const result = round.result;
    const winner =
      row.score_whale >= HUNT_V2_TIMING.pointsToWin
        ? 'whale'
        : row.score_tracer >= HUNT_V2_TIMING.pointsToWin
          ? 'tracer'
          : row.score_whale > row.score_tracer
            ? 'whale'
            : row.score_tracer > row.score_whale
              ? 'tracer'
              : null;
    const view: HuntV2MatchView = {
      version: 'hunt-v2',
      matchId: row.match_id,
      role,
      phase: row.phase as HuntV2Phase,
      stateVersion: row.state_version,
      roundIndex: row.round_index,
      totalRounds: HUNT_V2_TIMING.totalRounds,
      score: { whale: row.score_whale, tracer: row.score_tracer },
      deadline: row.deadline_at ? { phase: row.phase as HuntV2Phase, at: row.deadline_at } : null,
      serverNow: nowIso(now),
      windows: round.windows,
      scansRemaining: Math.max(0, HUNT_V2_TIMING.scanCharges - round.scans.length),
      scans: round.scans,
      roundResults: publicRoundResults(rounds),
      participants: [
        { role: row.player_role, displayName: 'You', kind: 'human', connection: 'connected' },
        {
          role: opposite(row.player_role),
          displayName: row.opponent_id.startsWith('computer:') ? 'Computer' : 'Opponent',
          kind: row.opponent_id.startsWith('computer:') ? 'computer' : 'human',
          connection: 'connected',
        },
      ],
      ...(role === 'whale' ? { whaleSelection: round.selection } : {}),
      ...(role === 'tracer' ? { selectedZone: result?.selectedZone ?? null } : {}),
      ...(result && (row.phase === 'round_reveal' || row.phase === 'match_over')
        ? { hiddenZone: result.hiddenZone, roundResult: result }
        : {}),
      ...(row.phase === 'match_over' ? { matchWinner: winner, roundResult: result } : {}),
    };
    return view;
  }
}
