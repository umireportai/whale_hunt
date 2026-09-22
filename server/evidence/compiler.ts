import {
  EVIDENCE_CATEGORIES,
  type EvidenceAttribution,
  type EvidenceCategory,
  type PublicAssetEvidence,
  type SourceKind,
} from '../../shared/evidence.js';
import { price } from '../../shared/game-rules.js';
import { deriveClues, type ClueDerivationOptions } from './derive.js';
import {
  assertTemporalIntegrity,
  EvidenceValidationError,
  normalizeCandles,
  normalizeSnapshots,
  normalizeTrades,
  sourceKindOf,
  validateCoverage,
} from './normalize.js';
import {
  EVIDENCE_CONTENT_VERSION,
  EVIDENCE_RULES_VERSION,
  LIQUIDATION_PRESETS,
  type CompiledHuntCase,
  type CompiledHuntBoard,
  type CoverageRecord,
  type DerivedClues,
  type EvidenceRecordInput,
  type LiquidationSignature,
  type MatchingFeatures,
  type NormalizedCandle,
  type NormalizedSnapshot,
  type NormalizedTrade,
  type PriorPattern,
  type ReturnBucket,
} from './types.js';

export interface HuntCaseCompileInput extends Omit<
  EvidenceRecordInput,
  'preDecisionCandles' | 'outcomeCandles' | 'trades' | 'snapshots' | 'coverage' | 'attribution'
> {
  readonly preDecisionCandles: unknown;
  readonly outcomeCandles: unknown;
  readonly trades: unknown;
  readonly snapshots?: unknown;
  readonly coverage: unknown;
  readonly attribution?: readonly EvidenceAttribution[];
}

export interface CompileOptions extends ClueDerivationOptions {
  readonly allowPracticePartial?: boolean;
  readonly rulesVersion?: string;
  readonly contentVersion?: string;
}

export interface HuntBoardCompileInput {
  readonly boardId: string;
  readonly cases: readonly (CompiledHuntCase | HuntCaseCompileInput)[];
  readonly sourceKind?: SourceKind;
  readonly rulesVersion?: string;
  readonly contentVersion?: string;
}

function canonical(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new EvidenceValidationError('invalid-timestamp', `${label} must be a timestamp.`);
  return date.toISOString();
}

function positiveNumber(value: number | undefined, label: string): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0)
    throw new EvidenceValidationError('invalid-number', `${label} must be positive.`);
  return value;
}

function alias(index: number): string {
  return `Mystery Asset ${String.fromCharCode(65 + (index % 26))}`;
}

function title(category: EvidenceCategory): string {
  return category
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function publicEvidence(
  value: Pick<
    CompiledHuntCase,
    'caseId' | 'preDecisionCandles' | 'trades' | 'coverage' | 'attribution' | 'clues'
  >,
  attemptAlias: string,
  colorIndex: number,
): PublicAssetEvidence {
  const first = value.preDecisionCandles[0];
  const last = value.preDecisionCandles.at(-1);
  const change = first && last ? (last.close / first.close - 1) * 100 : undefined;
  const volume = value.trades.reduce((sum, trade) => sum + (trade.valueUsd ?? 0), 0);
  return {
    assetId: value.caseId,
    attemptAlias,
    colorIndex,
    chart: value.preDecisionCandles.map((candle) => ({
      at: candle.at,
      value: price(candle.close.toFixed(8)),
    })),
    ...(last ? { currentPrice: price(last.close.toFixed(8)) } : {}),
    ...(change === undefined
      ? {}
      : { changePct: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` }),
    ...(volume > 0 ? { volumeUsd: `$${Math.round(volume).toLocaleString('en-US')}` } : {}),
    clueDescriptors: EVIDENCE_CATEGORIES.map((category) => ({
      clueId: `${value.caseId}:${category}`,
      category,
      title: title(category),
      question: 'What did the completed evidence window show before the decision cutoff?',
    })),
    unlockedClues: [],
    coverage: value.coverage,
    attribution: value.attribution,
  };
}

function returnBucket(value: number): ReturnBucket {
  const absolute = Math.abs(value);
  if (absolute < 1) return 'under-1';
  if (absolute < 3) return '1-to-3';
  if (absolute < 7) return '3-to-7';
  if (absolute < 15) return '7-to-15';
  return 'above-15';
}

function priorPattern(candles: readonly NormalizedCandle[]): PriorPattern {
  const move = (candles.at(-1)!.close / candles[0]!.close - 1) * 100;
  if (move < -3) return 'down';
  if (move > 3) return 'up';
  return 'flat';
}

function realizedVolatility(candles: readonly NormalizedCandle[]): number {
  const returns = candles
    .slice(1)
    .map((candle, index) => (candle.close / candles[index]!.close - 1) * 100);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
}

function excursions(
  candles: readonly NormalizedCandle[],
  entryPrice: number,
): Pick<
  MatchingFeatures,
  | 'favorableExcursionPct'
  | 'adverseExcursionPct'
  | 'longFavorableExcursionPct'
  | 'longAdverseExcursionPct'
  | 'shortFavorableExcursionPct'
  | 'shortAdverseExcursionPct'
> {
  const highest = Math.max(...candles.map((candle) => candle.high));
  const lowest = Math.min(...candles.map((candle) => candle.low));
  const longFavorable = Math.max(0, ((highest - entryPrice) / entryPrice) * 100);
  const longAdverse = Math.max(0, ((entryPrice - lowest) / entryPrice) * 100);
  const shortFavorable = longAdverse;
  const shortAdverse = longFavorable;
  return {
    favorableExcursionPct: Math.max(longFavorable, shortFavorable),
    adverseExcursionPct: Math.max(longAdverse, shortAdverse),
    longFavorableExcursionPct: longFavorable,
    longAdverseExcursionPct: longAdverse,
    shortFavorableExcursionPct: shortFavorable,
    shortAdverseExcursionPct: shortAdverse,
  };
}

function liquidationSignature(
  candles: readonly NormalizedCandle[],
  entryPrice: number,
): LiquidationSignature {
  const long = LIQUIDATION_PRESETS.map((leverage) =>
    candles.some((candle) => 1 + leverage * ((candle.low - entryPrice) / entryPrice) <= 0),
  );
  const short = LIQUIDATION_PRESETS.map((leverage) =>
    candles.some((candle) => 1 + leverage * ((entryPrice - candle.high) / entryPrice) <= 0),
  );
  return { long, short };
}

/** Compute variant features from the historical path, including actual-candle liquidation signatures. */
export function computeMatchingFeatures(
  value: Pick<
    CompiledHuntCase,
    'preDecisionCandles' | 'outcomeCandles' | 'entryPrice' | 'exitPrice' | 'coverage' | 'clues'
  >,
): MatchingFeatures {
  const signedTerminalReturnPct = (value.exitPrice / value.entryPrice - 1) * 100;
  const movement = excursions(value.outcomeCandles, value.entryPrice);
  return {
    signedTerminalReturnPct,
    terminalSign:
      signedTerminalReturnPct < 0
        ? 'negative'
        : signedTerminalReturnPct > 0
          ? 'positive'
          : 'neutral',
    returnBucket: returnBucket(signedTerminalReturnPct),
    priorPattern: priorPattern(value.preDecisionCandles),
    realizedVolatilityPct: realizedVolatility(value.outcomeCandles),
    ...movement,
    liquidation: liquidationSignature(value.outcomeCandles, value.entryPrice),
    coverageProfile: [
      value.coverage.status,
      value.coverage.warnings.length,
      value.coverage.missingMeasurements.join(','),
      value.clues ? Object.keys(value.clues).sort().join(',') : '',
    ].join('|'),
    clueCategories: EVIDENCE_CATEGORIES,
  };
}

function attributionFor(input: HuntCaseCompileInput): readonly EvidenceAttribution[] {
  return input.attribution?.length
    ? input.attribution.map((item) => ({ ...item, sourceKind: sourceKindOf(item.sourceKind) }))
    : [{ label: input.sourceKind, sourceKind: sourceKindOf(input.sourceKind) }];
}

function compileNormalized(
  value: HuntCaseCompileInput,
  options: CompileOptions,
): CompiledHuntCase {
  const sourceKind = sourceKindOf(value.sourceKind);
  if (!value.caseId.trim() || !Number.isInteger(value.roundIndex) || value.roundIndex < 1)
    throw new EvidenceValidationError(
      'invalid-record',
      'A case needs a non-empty id and positive round index.',
    );
  if (!value.chain.trim() || !value.tokenAddress.trim())
    throw new EvidenceValidationError('invalid-record', 'A case needs chain and token references.');
  const evidenceStartAt = canonical(value.evidenceStartAt, 'evidenceStartAt');
  const cutoffAt = canonical(value.cutoffAt, 'cutoffAt');
  const entryAt = canonical(value.entryAt, 'entryAt');
  const exitAt = canonical(value.exitAt, 'exitAt');
  const collectionAt = canonical(value.collectionAt, 'collectionAt');
  const preDecisionCandles = normalizeCandles(value.preDecisionCandles);
  const outcomeCandles = normalizeCandles(value.outcomeCandles);
  const trades = normalizeTrades(value.trades);
  const snapshots = normalizeSnapshots(value.snapshots);
  const coverage = validateCoverage(value.coverage, {
    requireComplete: options.allowPracticePartial !== true,
  });
  assertTemporalIntegrity({
    evidenceStartAt,
    cutoffAt,
    entryAt,
    exitAt,
    collectionAt,
    preDecisionCandles,
    outcomeCandles,
    trades,
    snapshots,
    coverage,
  });
  const entryPrice = positiveNumber(value.entryPrice, 'entryPrice') ?? outcomeCandles[0]!.open;
  const exitPrice = positiveNumber(value.exitPrice, 'exitPrice') ?? outcomeCandles.at(-1)!.close;
  const attribution = attributionFor(value);
  const clueInput = {
    sourceKind,
    cutoffAt,
    preDecisionCandles,
    trades,
    snapshots,
    coverage,
    attribution,
  };
  const clues: DerivedClues = deriveClues(clueInput, options);
  const partial = {
    caseId: value.caseId,
    preDecisionCandles,
    coverage,
    attribution,
    clues,
  };
  const compiledWithoutDerived = {
    kind: 'hunt-case' as const,
    caseId: value.caseId,
    roundIndex: value.roundIndex,
    sourceKind,
    chain: value.chain,
    tokenAddress: value.tokenAddress,
    symbol: value.symbol ?? null,
    name: value.name ?? null,
    evidenceStartAt,
    cutoffAt,
    entryAt,
    exitAt,
    entryPrice,
    exitPrice,
    collectionAt,
    preDecisionCandles,
    outcomeCandles,
    trades,
    snapshots,
    coverage,
    attribution,
    clues,
    matching: {} as MatchingFeatures,
    rulesVersion: value.rulesVersion ?? options.rulesVersion ?? EVIDENCE_RULES_VERSION,
    contentVersion: value.contentVersion ?? options.contentVersion ?? EVIDENCE_CONTENT_VERSION,
    publicEvidence: publicEvidence(
      { ...partial, trades },
      alias(value.roundIndex - 1),
      value.roundIndex - 1,
    ),
  } satisfies CompiledHuntCase;
  const compiled = {
    ...compiledWithoutDerived,
    matching: computeMatchingFeatures(compiledWithoutDerived),
    publicEvidence: publicEvidence(
      compiledWithoutDerived,
      alias(value.roundIndex - 1),
      value.roundIndex - 1,
    ),
  } satisfies CompiledHuntCase;
  return compiled;
}

/** Compile one private case and create a public projection with no future path or provider mapping. */
export function compileHuntCase(
  value: HuntCaseCompileInput,
  options: CompileOptions = {},
): CompiledHuntCase {
  return compileNormalized(value, options);
}

function isCompiled(value: CompiledHuntCase | HuntCaseCompileInput): value is CompiledHuntCase {
  return 'kind' in value && value.kind === 'hunt-case';
}

/** Compile the fixed historical evidence board used by Hunt while keeping case details private. */
export function compileHuntBoard(
  input: HuntBoardCompileInput,
  options: CompileOptions = {},
): CompiledHuntBoard {
  if (!input.boardId.trim())
    throw new EvidenceValidationError('invalid-record', 'A hunt board needs an id.');
  if (input.cases.length < 6 || input.cases.length > 10)
    throw new EvidenceValidationError(
      'incomplete-coverage',
      'A hunt board needs six to ten assets.',
    );
  const cases = input.cases.map((value) =>
    isCompiled(value) ? value : compileNormalized(value, options),
  );
  const sourceKind = input.sourceKind ?? cases[0]!.sourceKind;
  if (cases.some((value) => value.sourceKind !== sourceKind))
    throw new EvidenceValidationError('invalid-record', 'A hunt board cannot mix source kinds.');
  const realAssets = new Set<string>();
  for (const value of cases) {
    const key = `${value.chain.toLowerCase()}:${value.tokenAddress.toLowerCase()}`;
    if (realAssets.has(key))
      throw new EvidenceValidationError('invalid-record', 'A hunt board repeats a real asset.');
    realAssets.add(key);
  }
  const publicAssets = cases.map((value, index) => ({
    ...value.publicEvidence,
    attemptAlias: alias(index),
    colorIndex: index,
  }));
  return Object.freeze({
    kind: 'hunt-board' as const,
    boardId: input.boardId,
    sourceKind,
    cutoffAt: cases[0]!.cutoffAt,
    assets: Object.freeze(cases),
    publicAssets: Object.freeze(publicAssets),
    rulesVersion: input.rulesVersion ?? options.rulesVersion ?? EVIDENCE_RULES_VERSION,
    contentVersion: input.contentVersion ?? options.contentVersion ?? EVIDENCE_CONTENT_VERSION,
  });
}

export function toPublicAssetEvidence(
  value: CompiledHuntCase,
  attemptAlias: string,
  colorIndex: number,
): PublicAssetEvidence {
  return publicEvidence(value, attemptAlias, colorIndex);
}
