import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SyntheticAsset, SyntheticScenario } from '../../fixtures/synthetic/scenarios.js';
import type {
  SignalHuntCandidateView,
  SignalHuntCaseSummary,
  SignalHuntChartPoint,
  SignalHuntClue,
  SignalHuntClueDescriptor,
  SignalHuntCommand,
  SignalHuntDirection,
  SignalHuntLane,
  SignalHuntPhase,
  SignalHuntResult,
  SignalHuntRevealCandidate,
  SignalHuntSourceKind,
  SignalHuntThesis,
  SignalHuntView,
  StartSignalHuntCommand,
} from '../../shared/signal-hunt.js';
import { SIGNAL_HUNT_LANES, SIGNAL_HUNT_THESES } from '../../shared/signal-hunt.js';
import {
  insertSignalHuntAttempt,
  insertSignalHuntCommand,
  readSignalHuntAttempt,
  readSignalHuntCommand,
  updateSignalHuntAttempt,
  type SignalHuntAttemptRow,
} from '../db/signal-hunt.js';
import { transaction } from '../db/store.js';

const MAX_SCANS = 5;
const LANE_QUESTIONS: Record<SignalHuntLane, string> = {
  flow: 'Which way did Smart Money capital move?',
  whales: 'Did a whale-sized footprint appear?',
  cohort: 'Who participated in the move?',
  tape: 'Did the trade tape confirm the signal?',
  market: 'Did price and volume support the flow?',
};

interface SignalHuntCandidate extends SignalHuntCandidateView {
  readonly name: string;
  readonly symbol: string;
  readonly thesis: SignalHuntThesis;
  readonly direction: SignalHuntDirection;
  readonly clues: readonly SignalHuntClue[];
  readonly outcomeChart: readonly SignalHuntChartPoint[];
  readonly explanation: string;
  readonly signalScore: number;
}

interface SignalHuntCase extends SignalHuntCaseSummary {
  readonly targetAssetId: string;
  readonly candidates: readonly SignalHuntCandidate[];
}

type StoredScan = SignalHuntClue;

export type SignalHuntErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_PHASE'
  | 'STALE_STATE'
  | 'DUPLICATE_COMMAND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'ALREADY_COMPLETE';

export class SignalHuntError extends Error {
  constructor(
    readonly code: SignalHuntErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
    readonly stateVersion?: number,
  ) {
    super(message);
    this.name = 'SignalHuntError';
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sourceKind(
  value: SyntheticAsset['smartMoney'],
  scenario: SyntheticScenario,
): SignalHuntSourceKind {
  if (scenario.mode === 'live' || value) return 'live-provider';
  return 'historical-reconstructed';
}

function sourceLabel(scenario: SyntheticScenario): string {
  return (
    scenario.sourceLabel ??
    (scenario.mode === 'live' ? 'Nansen live provider' : 'Historical replay case')
  );
}

function chartFromSeries(
  series: readonly number[],
  cutoff: string,
  volume: readonly number[] | undefined,
): SignalHuntChartPoint[] {
  const end = Date.parse(cutoff);
  const step = 3_600_000;
  return series.map((value, index) => ({
    at: new Date(end - (series.length - index - 1) * step).toISOString(),
    value: number(value),
    ...(volume?.[index] === undefined ? {} : { volume: number(volume[index]) }),
  }));
}

function laneFromCurrentClue(kind: string): SignalHuntLane {
  if (kind === 'flow') return 'flow';
  if (kind === 'buyers') return 'cohort';
  return 'market';
}

function clueFromCurrent(
  asset: SyntheticAsset,
  scenario: SyntheticScenario,
  kind: string,
  clue: SyntheticAsset['clues'][keyof SyntheticAsset['clues']],
): SignalHuntClue {
  const lane = laneFromCurrentClue(kind);
  return {
    clueId: `${asset.id}:${lane}`,
    lane,
    title: clue?.title ?? LANE_QUESTIONS[lane],
    headline: clue?.headline ?? 'The provider returned no readable signal.',
    detail: clue?.detail ?? 'This lane is unavailable for the selected asset.',
    metrics: clue?.metrics ?? [],
    limitation: clue?.warning,
    observedAt: clue?.observedAt ?? scenario.cutoff,
    sourceLabel: sourceLabel(scenario),
  };
}

function currentSpecialClues(asset: SyntheticAsset, scenario: SyntheticScenario): SignalHuntClue[] {
  const observedAt = asset.observedAt ?? scenario.cutoff;
  const pressure = asset.whalePressure;
  const transfers = asset.walletTransfers;
  const holder = asset.holderMetrics;
  return [
    {
      clueId: `${asset.id}:whales`,
      lane: 'whales',
      title: 'Whale footprint',
      headline:
        pressure || transfers
          ? `${(pressure?.tradeCount ?? 0) + (transfers?.transferCount ?? 0)} labeled prints and transfers in the window`
          : 'No labeled whale activity returned',
      detail:
        pressure || transfers
          ? 'Nansen DEX trades and token transfers are bounded labeled samples, not a complete ownership census.'
          : 'An absent returned row is not proof that no whale acted.',
      metrics:
        pressure || transfers
          ? [
              {
                label: 'Net pressure',
                value: `${(pressure?.netUsd ?? 0) + (transfers?.netUsd ?? 0) >= 0 ? '+' : '−'}$${Math.round(Math.abs((pressure?.netUsd ?? 0) + (transfers?.netUsd ?? 0))).toLocaleString()}`,
              },
              {
                label: 'Largest wallet move',
                value: Math.max(pressure?.largestTradeUsd ?? 0, transfers?.largestTransferUsd ?? 0)
                  ? `$${Math.round(Math.max(pressure?.largestTradeUsd ?? 0, transfers?.largestTransferUsd ?? 0)).toLocaleString()}`
                  : '—',
              },
            ]
          : [],
      limitation:
        'Nansen labels cover the returned sample only; this is not a wallet identity claim.',
      observedAt,
      sourceLabel: sourceLabel(scenario),
    },
    {
      clueId: `${asset.id}:tape`,
      lane: 'tape',
      title: 'Trading tape',
      headline: pressure
        ? `${pressure.buyUsd >= pressure.sellUsd ? 'Buyers' : 'Sellers'} carried the labeled tape`
        : 'Trade tape unavailable',
      detail: pressure
        ? 'The buy/sell balance shows how the returned labeled prints were distributed.'
        : 'No bounded labeled trade sample was available for this asset.',
      metrics: pressure
        ? [
            { label: 'Buy volume', value: `$${Math.round(pressure.buyUsd).toLocaleString()}` },
            { label: 'Sell volume', value: `$${Math.round(pressure.sellUsd).toLocaleString()}` },
          ]
        : [],
      limitation: 'Trade samples may be truncated by provider coverage and pagination.',
      observedAt,
      sourceLabel: sourceLabel(scenario),
    },
    {
      clueId: `${asset.id}:ownership`,
      lane: 'cohort',
      title: 'Holder context',
      headline:
        holder?.buyers || holder?.sellers
          ? 'Participation data is available'
          : 'Holder coverage is limited',
      detail: 'Counts describe observed provider metrics and do not represent every holder.',
      metrics: [
        { label: 'Buyers', value: holder?.buyers ? holder.buyers.toLocaleString() : '—' },
        { label: 'Sellers', value: holder?.sellers ? holder.sellers.toLocaleString() : '—' },
      ],
      limitation: 'No ownership percentage was returned in this bounded live board.',
      observedAt,
      sourceLabel: sourceLabel(scenario),
    },
  ];
}

function thesisForCurrent(asset: SyntheticAsset): SignalHuntThesis {
  const flow = asset.smartMoney?.direction;
  const whale = asset.whalePressure?.netUsd ?? 0;
  if (flow === 'accumulating') return 'accumulation';
  if (flow === 'distributing') return 'distribution';
  if (whale !== 0) return 'whale-activity';
  return 'mixed-signal';
}

function directionForCurrent(asset: SyntheticAsset): SignalHuntDirection {
  const net =
    (asset.smartMoney?.netFlowUsd ?? 0) +
    (asset.whalePressure?.netUsd ?? 0) +
    (asset.walletTransfers?.netUsd ?? 0);
  if (net < 0) return 'short';
  if (net > 0) return 'long';
  return (asset.outcomeSeries.at(-1) ?? 0) >= (asset.outcomeSeries[0] ?? 0) ? 'long' : 'short';
}

function scoreCurrent(asset: SyntheticAsset): number {
  const pressure = asset.whalePressure;
  const transfers = asset.walletTransfers;
  return (
    Math.abs(asset.smartMoney?.netFlowUsd ?? 0) * 0.75 +
    Math.abs(pressure?.netUsd ?? 0) +
    (pressure?.largestTradeUsd ?? 0) * 0.25 +
    Math.abs(transfers?.netUsd ?? 0) * 0.75 +
    (transfers?.largestTransferUsd ?? 0) * 0.25 +
    ((pressure?.tradeCount ?? 0) + (transfers?.transferCount ?? 0)) * 1_000
  );
}

function descriptors(clues: readonly SignalHuntClue[]): SignalHuntClueDescriptor[] {
  const byLane = new Map(clues.map((clue) => [clue.lane, clue]));
  return SIGNAL_HUNT_LANES.map((lane) => {
    const clue = byLane.get(lane);
    return {
      clueId: clue?.clueId ?? `missing:${lane}`,
      lane,
      title: clue?.title ?? lane,
      question: LANE_QUESTIONS[lane],
    };
  });
}

function currentCandidate(
  asset: SyntheticAsset,
  scenario: SyntheticScenario,
  index: number,
): SignalHuntCandidate {
  const clues = [
    ...Object.entries(asset.clues).map(([kind, clue]) =>
      clueFromCurrent(asset, scenario, kind, clue),
    ),
    ...currentSpecialClues(asset, scenario),
  ];
  const byLane = new Map(clues.map((clue) => [clue.lane, clue]));
  const compactClues = [...byLane.values()];
  const chart = chartFromSeries(asset.series, scenario.cutoff, asset.volumeSeries);
  const outcomeChart = chartFromSeries(asset.outcomeSeries, scenario.cutoff, undefined);
  const first = chart[0]?.value ?? 0;
  const last = chart.at(-1)?.value ?? first;
  return {
    assetId: asset.id,
    alias: `Signal ${String.fromCharCode(65 + index)}`,
    chain: asset.providerChain ?? asset.category.split(' · ')[0] ?? 'market',
    chart,
    currentPrice: last || undefined,
    changePct: first ? (last / first - 1) * 100 : undefined,
    volumeUsd: asset.volumeUsd,
    liquidityUsd: asset.liquidityUsd,
    clueDescriptors: descriptors(compactClues),
    unlockedClues: [],
    name: asset.name,
    symbol: asset.symbol,
    thesis: thesisForCurrent(asset),
    direction: directionForCurrent(asset),
    clues: compactClues,
    outcomeChart,
    explanation: asset.explanation,
    signalScore: scoreCurrent(asset),
  };
}

function scenarioCase(scenario: SyntheticScenario): SignalHuntCase {
  const candidates = scenario.assets.map((asset, index) =>
    currentCandidate(asset, scenario, index),
  );
  const target = candidates.reduce(
    (best, candidate) => (candidate.signalScore > best.signalScore ? candidate : best),
    candidates[0]!,
  );
  return {
    caseId: `signal-${scenario.id}`,
    title: scenario.title,
    subtitle: scenario.subtitle,
    sourceKind: sourceKind(scenario.assets[0]?.smartMoney, scenario),
    sourceLabel: sourceLabel(scenario),
    snapshotAt: scenario.cutoff,
    candidateCount: candidates.length,
    targetAssetId: target.assetId,
    candidates,
  };
}

export function createSignalHuntCases(
  currentScenario: SyntheticScenario | null,
  historicalScenarios: readonly SyntheticScenario[],
): readonly SignalHuntCase[] {
  if (currentScenario) return [scenarioCase(currentScenario)];
  return historicalScenarios.map(scenarioCase);
}

function publicCandidate(
  candidate: SignalHuntCandidate,
  scans: readonly StoredScan[],
): SignalHuntCandidateView {
  const unlocked = scans.filter(
    (scan) =>
      scan.clueId.startsWith(`${candidate.assetId}:`) || scan.clueId.includes(candidate.assetId),
  );
  return {
    assetId: candidate.assetId,
    alias: candidate.alias,
    chain: candidate.chain,
    chart: candidate.chart,
    currentPrice: candidate.currentPrice,
    changePct: candidate.changePct,
    volumeUsd: candidate.volumeUsd,
    liquidityUsd: candidate.liquidityUsd,
    clueDescriptors: candidate.clueDescriptors,
    unlockedClues: unlocked,
  };
}

function revealCandidate(candidate: SignalHuntCandidate): SignalHuntRevealCandidate {
  return {
    ...publicCandidate(candidate, candidate.clues),
    name: candidate.name,
    symbol: candidate.symbol,
    thesis: candidate.thesis,
    direction: candidate.direction,
    outcomeChart: candidate.outcomeChart,
    explanation: candidate.explanation,
  };
}

function publicCase(candidateCase: SignalHuntCase): SignalHuntCaseSummary {
  return {
    caseId: candidateCase.caseId,
    title: candidateCase.title,
    subtitle: candidateCase.subtitle,
    sourceKind: candidateCase.sourceKind,
    sourceLabel: candidateCase.sourceLabel,
    snapshotAt: candidateCase.snapshotAt,
    candidateCount: candidateCase.candidateCount,
  };
}

export class SignalHuntEngine {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly casesById: ReadonlyMap<string, SignalHuntCase>;

  constructor(
    private readonly db: DatabaseSync,
    cases: readonly SignalHuntCase[],
    options: { readonly clock?: () => Date; readonly idFactory?: () => string } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.casesById = new Map(cases.map((candidateCase) => [candidateCase.caseId, candidateCase]));
  }

  listCases(): readonly SignalHuntCaseSummary[] {
    return [...this.casesById.values()].map(publicCase);
  }

  start(playerId: string, command: StartSignalHuntCommand): SignalHuntView {
    const candidateCase = this.casesById.get(command.caseId);
    if (!candidateCase) throw new SignalHuntError('NOT_FOUND', 'Signal Hunt case not found.', 404);
    const now = this.clock();
    const row: SignalHuntAttemptRow = {
      attempt_id: this.idFactory(),
      player_id: playerId,
      case_id: candidateCase.caseId,
      phase: 'investigate',
      state_version: 1,
      scans_payload: '[]',
      selected_asset_id: null,
      result_payload: null,
      created_at: nowIso(now),
      completed_at: null,
    };
    transaction(this.db, () => insertSignalHuntAttempt(this.db, row));
    return this.view(row);
  }

  get(attemptId: string, playerId: string): SignalHuntView {
    const row = readSignalHuntAttempt(this.db, attemptId);
    if (!row) throw new SignalHuntError('NOT_FOUND', 'Signal Hunt attempt not found.', 404);
    this.assertOwner(row, playerId);
    return this.view(row);
  }

  command(attemptId: string, playerId: string, command: SignalHuntCommand): SignalHuntView {
    let response: SignalHuntView | undefined;
    transaction(this.db, () => {
      const row = readSignalHuntAttempt(this.db, attemptId);
      if (!row) throw new SignalHuntError('NOT_FOUND', 'Signal Hunt attempt not found.', 404);
      this.assertOwner(row, playerId);
      const payload = json(command);
      const existing = readSignalHuntCommand(this.db, attemptId, command.idempotencyKey);
      if (existing) {
        if (existing.actor_id !== playerId || existing.payload !== payload)
          throw new SignalHuntError(
            'IDEMPOTENCY_CONFLICT',
            'This command key was already used.',
            409,
          );
        response = parseJson<SignalHuntView>(existing.response);
        return;
      }
      if (row.state_version !== command.expectedStateVersion)
        throw new SignalHuntError(
          'STALE_STATE',
          'The Signal Hunt state changed. Refresh the evidence board.',
          409,
          true,
          row.state_version,
        );
      if (row.phase === 'result')
        throw new SignalHuntError('ALREADY_COMPLETE', 'This Signal Hunt is complete.', 409);
      const candidateCase = this.casesById.get(row.case_id);
      if (!candidateCase)
        throw new SignalHuntError('NOT_FOUND', 'Signal Hunt case not found.', 404);
      const scans = parseJson<StoredScan[]>(row.scans_payload);
      if (command.kind === 'scan') {
        const candidate = candidateCase.candidates.find(
          (item) => item.assetId === command.candidateId,
        );
        if (!candidate)
          throw new SignalHuntError('INVALID_COMMAND', 'Choose a valid signal asset.');
        const clue = candidate.clues.find((item) => item.lane === command.lane);
        if (!clue)
          throw new SignalHuntError('INVALID_COMMAND', 'That evidence lane is unavailable.');
        if (scans.some((item) => item.clueId === clue.clueId)) {
          response = this.view(row);
        } else {
          if (scans.length >= MAX_SCANS)
            throw new SignalHuntError('INVALID_COMMAND', 'No investigation charges remain.');
          row.scans_payload = json([
            ...scans,
            { ...clue, candidateId: candidate.assetId, candidateAlias: candidate.alias },
          ]);
          row.state_version += 1;
        }
      } else {
        const candidate = candidateCase.candidates.find(
          (item) => item.assetId === command.candidateId,
        );
        if (!candidate)
          throw new SignalHuntError('INVALID_COMMAND', 'Choose a valid signal asset.');
        if (!SIGNAL_HUNT_THESES.includes(command.thesis))
          throw new SignalHuntError('INVALID_COMMAND', 'Choose a valid signal thesis.');
        if (command.direction !== 'long' && command.direction !== 'short')
          throw new SignalHuntError('INVALID_COMMAND', 'Choose a long or short direction.');
        const correctAsset = candidate.assetId === candidateCase.targetAssetId;
        const correctThesis = candidate.thesis === command.thesis;
        const target =
          candidateCase.candidates.find((item) => item.assetId === candidateCase.targetAssetId) ??
          candidate;
        const correctDirection = target.direction === command.direction;
        const score =
          (correctAsset ? 1_000 + Math.max(0, MAX_SCANS - scans.length) * 100 : 100) +
          (correctThesis ? 250 : 0) +
          (correctDirection ? 200 : 0);
        const result: SignalHuntResult = {
          selectedAssetId: candidate.assetId,
          targetAssetId: target.assetId,
          selectedThesis: command.thesis,
          targetThesis: target.thesis,
          selectedDirection: command.direction,
          targetDirection: target.direction,
          correctAsset,
          correctThesis,
          correctDirection,
          score,
          target: revealCandidate(target),
          explanation: correctAsset
            ? `You caught ${target.alias}: ${target.name} (${target.symbol}). The strongest observed read was ${target.direction} ${target.thesis.replace('-', ' ')} in this snapshot.`
            : `You chose ${candidate.alias}. The whale signal was in ${target.alias}: ${target.name} (${target.symbol}). The decisive read was ${target.direction} ${target.thesis.replace('-', ' ')}.`,
        };
        row.phase = 'result';
        row.selected_asset_id = candidate.assetId;
        row.result_payload = json(result);
        row.state_version += 1;
        row.completed_at = nowIso(this.clock());
      }
      updateSignalHuntAttempt(this.db, row);
      response = this.view(row);
      insertSignalHuntCommand(this.db, {
        attempt_id: attemptId,
        idempotency_key: command.idempotencyKey,
        actor_id: playerId,
        payload,
        response: json(response),
        created_at: nowIso(this.clock()),
      });
    });
    if (!response)
      throw new SignalHuntError('INVALID_COMMAND', 'The Signal Hunt command had no response.', 500);
    return response;
  }

  private assertOwner(row: SignalHuntAttemptRow, playerId: string): void {
    if (row.player_id !== playerId)
      throw new SignalHuntError('FORBIDDEN', 'This Signal Hunt belongs to another player.', 403);
  }

  private view(row: SignalHuntAttemptRow): SignalHuntView {
    const candidateCase = this.casesById.get(row.case_id);
    if (!candidateCase) throw new SignalHuntError('NOT_FOUND', 'Signal Hunt case not found.', 404);
    const scans = parseJson<StoredScan[]>(row.scans_payload);
    const result = row.result_payload ? parseJson<SignalHuntResult>(row.result_payload) : null;
    return {
      version: 'signal-hunt-v1',
      attemptId: row.attempt_id,
      case: publicCase(candidateCase),
      phase: row.phase as SignalHuntPhase,
      stateVersion: row.state_version,
      scansRemaining: Math.max(0, MAX_SCANS - scans.length),
      scans,
      candidates: candidateCase.candidates.map((candidate) => publicCandidate(candidate, scans)),
      selectedAssetId: row.selected_asset_id,
      result,
    };
  }
}

export type { SignalHuntCase };
