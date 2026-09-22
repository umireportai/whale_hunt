import type { EvidenceAttribution, EvidenceCategory } from '../../shared/evidence.js';
import { EvidenceValidationError } from './normalize.js';
import type {
  CoverageRecord,
  DerivedClue,
  DerivedClues,
  NormalizedCandle,
  NormalizedSnapshot,
  NormalizedTrade,
} from './types.js';
import type { SourceKind } from '../../shared/evidence.js';

export interface ClueEvidenceInput {
  readonly sourceKind: SourceKind;
  readonly cutoffAt: string;
  readonly preDecisionCandles: readonly NormalizedCandle[];
  readonly trades: readonly NormalizedTrade[];
  readonly snapshots: readonly NormalizedSnapshot[];
  readonly coverage: CoverageRecord;
  readonly attribution: readonly EvidenceAttribution[];
}

export interface ClueDerivationOptions {
  readonly largeTradeUsd?: number;
}

type Metric = { readonly label: string; readonly value: string };

function metric(label: string, value: string): Metric {
  return { label, value };
}

function usd(value: number): string {
  const sign = value < 0 ? '−' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}

function ratioPct(value: number): string {
  return `${Math.max(0, value).toFixed(1)}%`;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function base(
  input: ClueEvidenceInput,
  category: EvidenceCategory,
  metrics: readonly Metric[],
): DerivedClue {
  if (metrics.length < 1 || metrics.length > 2)
    throw new EvidenceValidationError(
      'invalid-record',
      `${category} must expose one or two metrics.`,
    );
  return {
    category,
    factualHeadline: '',
    metrics: metrics as DerivedClue['metrics'],
    interpretation: '',
    evidenceCutoff: input.cutoffAt,
    sourceKind: input.sourceKind,
    coverage: input.coverage,
    attribution: input.attribution,
  };
}

function withText(
  clue: DerivedClue,
  factualHeadline: string,
  interpretation: string,
  limitation?: string,
  conflict?: string,
): DerivedClue {
  return {
    ...clue,
    factualHeadline,
    interpretation,
    ...(limitation === undefined ? {} : { limitation }),
    ...(conflict === undefined ? {} : { conflict }),
  };
}

function requireValues(category: EvidenceCategory, values: readonly number[]): void {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new EvidenceValidationError(
      'incomplete-coverage',
      `${category} has no supported measurements.`,
    );
}

function sourceLimitation(input: ClueEvidenceInput): string | undefined {
  return input.coverage.warnings.length
    ? `Coverage warning: ${input.coverage.warnings.join('; ')}`
    : undefined;
}

function flowClue(input: ClueEvidenceInput): DerivedClue {
  const valued = input.trades.filter((trade) => trade.valueUsd !== null);
  requireValues(
    'flow',
    valued.map((trade) => trade.valueUsd!),
  );
  const buy = valued
    .filter((trade) => trade.side === 'buy')
    .reduce((sum, trade) => sum + trade.valueUsd!, 0);
  const sell = valued
    .filter((trade) => trade.side === 'sell')
    .reduce((sum, trade) => sum + trade.valueUsd!, 0);
  const total = buy + sell;
  const net = buy - sell;
  const clue = base(input, 'flow', [
    metric('Observed net flow', usd(net)),
    metric('Observed volume', usd(total)),
  ]);
  return withText(
    clue,
    `${net >= 0 ? 'Buying' : 'Selling'} was larger in the observed trade sample`,
    `The pre-decision sample contained ${usd(buy)} of buys and ${usd(sell)} of sells.`,
    sourceLimitation(input) ??
      'Observed trades are a bounded sample and do not establish the complete market flow.',
  );
}

function crowdClue(input: ClueEvidenceInput): DerivedClue {
  const buyers = new Set(
    input.trades
      .filter((trade) => trade.side === 'buy' && trade.wallet)
      .map((trade) => trade.wallet!),
  );
  const sellers = new Set(
    input.trades
      .filter((trade) => trade.side === 'sell' && trade.wallet)
      .map((trade) => trade.wallet!),
  );
  if (!buyers.size && !sellers.size)
    throw new EvidenceValidationError('incomplete-coverage', 'crowd has no wallet measurements.');
  const clue = base(input, 'crowd', [
    metric('Observed buyers', String(buyers.size)),
    metric('Observed sellers', String(sellers.size)),
  ]);
  return withText(
    clue,
    `${buyers.size} observed buyers and ${sellers.size} observed sellers`,
    'Distinct wallet counts are calculated only from the addresses present in the pre-decision sample.',
    'Wallet labels and coverage are incomplete; this is not an identity or ownership claim.',
  );
}

function whaleFootprintClue(input: ClueEvidenceInput, threshold: number): DerivedClue {
  const valued = input.trades.filter((trade) => trade.valueUsd !== null);
  requireValues(
    'whale-footprint',
    valued.map((trade) => trade.valueUsd!),
  );
  const total = valued.reduce((sum, trade) => sum + trade.valueUsd!, 0);
  const large = valued.filter((trade) => trade.valueUsd! >= threshold);
  const largeValue = large.reduce((sum, trade) => sum + trade.valueUsd!, 0);
  const share = total > 0 ? (largeValue / total) * 100 : 0;
  const clue = base(input, 'whale-footprint', [
    metric('Large observed trades', String(large.length)),
    metric('Large-trade share', ratioPct(share)),
  ]);
  return withText(
    clue,
    large.length
      ? 'Large trades made up a measurable part of observed activity'
      : 'No threshold-sized trade was observed',
    `Trades at or above ${usd(threshold)} represented ${ratioPct(share)} of the observed USD volume.`,
    'The threshold is a game measurement over the returned sample, not a claim about a person or entity.',
  );
}

function volumeClue(input: ClueEvidenceInput): DerivedClue {
  const candles = input.preDecisionCandles.filter((candle) => candle.volume !== null);
  requireValues(
    'volume',
    candles.map((candle) => candle.volume!),
  );
  const split = Math.max(1, Math.floor(candles.length / 2));
  const baseline = candles.slice(0, split).map((candle) => candle.volume!);
  const recent = candles.slice(split).map((candle) => candle.volume!);
  if (!recent.length)
    throw new EvidenceValidationError('incomplete-coverage', 'volume needs two periods.');
  const baselineAverage = average(baseline);
  const recentAverage = average(recent);
  const multiple = baselineAverage > 0 ? recentAverage / baselineAverage : null;
  const firstClose = input.preDecisionCandles[0]!.close;
  const lastClose = input.preDecisionCandles.at(-1)!.close;
  const priceMove = (lastClose / firstClose - 1) * 100;
  const clue = base(input, 'volume', [
    metric('Recent versus baseline', multiple === null ? '—' : `${multiple.toFixed(2)}×`),
    metric('Pre-cutoff price move', pct(priceMove)),
  ]);
  return withText(
    clue,
    `${multiple === null ? 'Volume baseline unavailable' : multiple >= 1 ? 'Recent volume was at or above baseline' : 'Recent volume was below baseline'}`,
    'Recent and earlier candle volumes are compared within the completed pre-decision window.',
    multiple === null
      ? 'A zero baseline is left missing rather than converted into an extreme signal.'
      : sourceLimitation(input),
  );
}

function volatilityClue(input: ClueEvidenceInput): DerivedClue {
  const closes = input.preDecisionCandles.map((candle) => candle.close);
  const returns = closes.slice(1).map((close, index) => (close / closes[index]! - 1) * 100);
  requireValues('volatility', returns);
  const ranges = input.preDecisionCandles.map(
    (candle) => ((candle.high - candle.low) / candle.open) * 100,
  );
  const pullback = Math.max(
    0,
    ...input.preDecisionCandles.map((candle) => ((candle.high - candle.close) / candle.high) * 100),
  );
  const clue = base(input, 'volatility', [
    metric('Realized move dispersion', `${standardDeviation(returns).toFixed(2)}%`),
    metric('Largest candle range', `${Math.max(...ranges).toFixed(2)}%`),
  ]);
  return withText(
    clue,
    `The pre-cutoff path showed ${standardDeviation(returns).toFixed(2)}% return dispersion`,
    `Candle ranges and close-to-close changes produced a largest observed pullback of ${pullback.toFixed(2)}%.`,
    sourceLimitation(input),
  );
}

function absorptionClue(input: ClueEvidenceInput): DerivedClue {
  const valued = input.trades.filter((trade) => trade.valueUsd !== null);
  requireValues(
    'absorption',
    valued.map((trade) => trade.valueUsd!),
  );
  const buy = valued
    .filter((trade) => trade.side === 'buy')
    .reduce((sum, trade) => sum + trade.valueUsd!, 0);
  const sell = valued
    .filter((trade) => trade.side === 'sell')
    .reduce((sum, trade) => sum + trade.valueUsd!, 0);
  const pressure = buy - sell;
  if (pressure === 0)
    throw new EvidenceValidationError(
      'incomplete-coverage',
      'absorption has no directional pressure.',
    );
  const firstClose = input.preDecisionCandles[0]!.close;
  const lastClose = input.preDecisionCandles.at(-1)!.close;
  const move = (lastClose / firstClose - 1) * 100;
  const agreement = Math.sign(pressure) === Math.sign(move) ? 'progress' : 'limited price progress';
  const clue = base(input, 'absorption', [
    metric('Observed pressure', usd(pressure)),
    metric('Price progress', pct(move)),
  ]);
  return withText(
    clue,
    `${agreement === 'progress' ? 'Pressure and price moved together' : 'Pressure met limited price progress'}`,
    'Absorption is a derived comparison between observed directional pressure and pre-cutoff price movement.',
    'This interpretation is sensitive to incomplete trade coverage and does not predict the outcome window.',
  );
}

/** Derive all six facts exclusively from observations before the decision cutoff. */
export function deriveClues(
  input: ClueEvidenceInput,
  options: ClueDerivationOptions = {},
): DerivedClues {
  const threshold = options.largeTradeUsd ?? 100_000;
  if (!Number.isFinite(threshold) || threshold <= 0)
    throw new EvidenceValidationError(
      'invalid-number',
      'The large trade threshold must be positive.',
    );
  const clues = {
    flow: flowClue(input),
    crowd: crowdClue(input),
    'whale-footprint': whaleFootprintClue(input, threshold),
    volume: volumeClue(input),
    volatility: volatilityClue(input),
    absorption: absorptionClue(input),
  } satisfies Record<EvidenceCategory, DerivedClue>;
  return clues;
}
