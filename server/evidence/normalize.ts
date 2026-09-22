import type { SourceKind } from '../../shared/evidence.js';
import type {
  CoverageRecord,
  EvidenceRecordInput,
  NormalizedCandle,
  NormalizedSnapshot,
  NormalizedTrade,
} from './types.js';

export type EvidenceValidationCode =
  | 'invalid-record'
  | 'invalid-timestamp'
  | 'invalid-number'
  | 'invalid-candle'
  | 'invalid-trade'
  | 'duplicate-point'
  | 'out-of-order'
  | 'open-candle'
  | 'future-observation'
  | 'invalid-window'
  | 'incomplete-coverage'
  | 'truncated-response'
  | 'missing-batch-asset';

export class EvidenceValidationError extends Error {
  constructor(
    public readonly code: EvidenceValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceValidationError';
  }
}

type Row = Record<string, unknown>;

function objectRecord(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EvidenceValidationError('invalid-record', `${label} must be an object.`);
  return value as Row;
}

function rowsFrom(value: unknown, label: string, tokenAddress?: string): Row[] {
  if (Array.isArray(value))
    return value.map((item, index) => objectRecord(item, `${label}[${index}]`));
  const object = objectRecord(value, label);
  if (Array.isArray(object.data)) return rowsFrom(object.data, `${label}.data`, tokenAddress);
  if (object.data && typeof object.data === 'object')
    return rowsFrom(object.data, `${label}.data`, tokenAddress);
  if (Array.isArray(object.tokens)) {
    const tokenRows: Row[] = [];
    for (const [index, item] of object.tokens.entries()) {
      const token = objectRecord(item, `${label}.tokens[${index}]`);
      const address = stringValue(token.token_address ?? token.tokenAddress ?? token.address);
      if (tokenAddress && address && address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
      if (Array.isArray(token.data))
        tokenRows.push(...rowsFrom(token.data, `${label}.tokens[${index}].data`));
    }
    return tokenRows;
  }
  throw new EvidenceValidationError('invalid-record', `${label} does not contain rows.`);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}

function numberValue(value: unknown, label: string, positive = false): number {
  const result =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(result) || (positive ? result <= 0 : result < 0))
    throw new EvidenceValidationError(
      'invalid-number',
      `${label} must be a finite${positive ? ' positive' : ' non-negative'} number.`,
    );
  return result;
}

function optionalNumber(value: unknown, label: string, positive = false): number | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''))
    return null;
  return numberValue(value, label, positive);
}

function timestamp(value: unknown, label: string): string {
  let date: Date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
    date = new Date(milliseconds);
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value);
  } else {
    date = new Date(NaN);
  }
  if (!Number.isFinite(date.getTime()))
    throw new EvidenceValidationError('invalid-timestamp', `${label} must be a timestamp.`);
  return date.toISOString();
}

function first(row: Row, keys: readonly string[]): unknown {
  for (const key of keys) if (row[key] !== undefined) return row[key];
  return undefined;
}

function candleClosed(row: Row): boolean {
  const raw = first(row, ['closed', 'is_closed', 'complete', 'is_complete']);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return !/^(?:open|partial|false|0)$/i.test(raw.trim());
  const status = stringValue(row.status);
  return status ? !/^(?:open|partial)$/i.test(status) : true;
}

/** Normalize provider OHLCV rows while preserving their supplied order and null semantics. */
export function normalizeCandles(
  value: unknown,
  options: { readonly tokenAddress?: string } = {},
): readonly NormalizedCandle[] {
  return rowsFrom(value, 'candles', options.tokenAddress).map((row, index) => {
    const open = numberValue(first(row, ['open', 'open_price']), `candles[${index}].open`, true);
    const high = numberValue(first(row, ['high', 'high_price']), `candles[${index}].high`, true);
    const low = numberValue(first(row, ['low', 'low_price']), `candles[${index}].low`, true);
    const close = numberValue(
      first(row, ['close', 'close_price']),
      `candles[${index}].close`,
      true,
    );
    if (high < Math.max(open, close) || low > Math.min(open, close) || low > high)
      throw new EvidenceValidationError(
        'invalid-candle',
        `candles[${index}] has inconsistent OHLC values.`,
      );
    if (!candleClosed(row))
      throw new EvidenceValidationError('open-candle', 'A required candle is still open.');
    return {
      at: timestamp(
        first(row, ['at', 'timestamp', 'time', 'interval_start', 'open_time', 'datetime', 'date']),
        `candles[${index}].at`,
      ),
      open,
      high,
      low,
      close,
      volume: optionalNumber(
        first(row, ['volume', 'volume_usd', 'trading_volume']),
        `candles[${index}].volume`,
      ),
      closed: candleClosed(row),
    };
  });
}

function tradeSide(value: unknown, row: Row): 'buy' | 'sell' {
  if (typeof value === 'boolean') return value ? 'buy' : 'sell';
  const text = stringValue(value ?? first(row, ['trade_type', 'transaction_type', 'action']));
  if (text && /^(?:buy|bought|in|purchase|purchased)$/i.test(text)) return 'buy';
  if (text && /^(?:sell|sold|out|sale)$/i.test(text)) return 'sell';
  throw new EvidenceValidationError('invalid-trade', 'A trade side must be buy or sell.');
}

/** Normalize provider trade rows without inventing a missing side, value, or timestamp. */
export function normalizeTrades(value: unknown): readonly NormalizedTrade[] {
  return rowsFrom(value, 'trades').map((row, index) => {
    const price = numberValue(
      first(row, ['price', 'price_usd', 'token_price', 'estimated_swap_price_usd']),
      `trades[${index}].price`,
      true,
    );
    const amount = optionalNumber(
      first(row, ['amount', 'token_amount', 'quantity', 'size', 'traded_token_amount']),
      `trades[${index}].amount`,
      true,
    );
    let valueUsd = optionalNumber(
      first(row, [
        'value_usd',
        'usd_value',
        'amount_usd',
        'trade_value_usd',
        'volume_usd',
        'estimated_value_usd',
      ]),
      `trades[${index}].valueUsd`,
      true,
    );
    if (valueUsd === null && amount !== null) valueUsd = amount * price;
    if (valueUsd === null)
      throw new EvidenceValidationError(
        'invalid-trade',
        `trades[${index}] has no usable amount or USD value.`,
      );
    const wallet = stringValue(
      first(row, ['wallet', 'wallet_address', 'trader_address', 'address', 'from_address']),
    );
    if (!candleClosed(row))
      throw new EvidenceValidationError('open-candle', 'A required candle is still open.');
    return {
      at: timestamp(
        first(row, ['at', 'timestamp', 'time', 'block_timestamp', 'datetime', 'date']),
        `trades[${index}].at`,
      ),
      side: tradeSide(first(row, ['side', 'buy_or_sell', 'is_buy']), row),
      price,
      amount,
      valueUsd,
      wallet: wallet?.toLowerCase() ?? null,
      sourceId: stringValue(first(row, ['id', 'trade_id', 'transaction_hash', 'tx_hash'])),
    };
  });
}

/** Normalize timestamped snapshots; values remain nullable and provider-specific fields stay private. */
export function normalizeSnapshots(value: unknown): readonly NormalizedSnapshot[] {
  if (value === undefined || value === null) return [];
  const rows = rowsFrom(value, 'snapshots');
  return rows.map((row, index) => {
    const at = timestamp(
      first(row, ['at', 'timestamp', 'time', 'event_time', 'datetime', 'date']),
      `snapshots[${index}].at`,
    );
    const capturedAt = timestamp(
      first(row, ['captured_at', 'collected_at', 'fetched_at', 'observed_at']) ?? at,
      `snapshots[${index}].capturedAt`,
    );
    const values: Record<string, number | string | boolean | null> = {};
    for (const [key, item] of Object.entries(row)) {
      if (
        ![
          'at',
          'timestamp',
          'time',
          'event_time',
          'datetime',
          'date',
          'captured_at',
          'collected_at',
          'fetched_at',
          'observed_at',
        ].includes(key) &&
        (item === null ||
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean')
      ) {
        values[key] = item;
      }
    }
    return { at, capturedAt, values };
  });
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Validate coverage metadata and reject truncation or missing batch members when a complete case is required. */
export function validateCoverage(
  value: unknown,
  options: {
    readonly requireComplete?: boolean;
    readonly expectedAssetKeys?: readonly string[];
    readonly returnedAssetKeys?: readonly string[];
  } = {},
): CoverageRecord {
  const row = objectRecord(value, 'coverage');
  const startAt = timestamp(
    first(row, ['startAt', 'start_at', 'evidence_start_at', 'from']),
    'coverage.startAt',
  );
  const cutoffAt = timestamp(
    first(row, ['cutoffAt', 'cutoff_at', 'decision_cutoff', 'to']),
    'coverage.cutoffAt',
  );
  const observedAt = timestamp(
    first(row, ['observedAt', 'observed_at', 'collectedAt', 'collected_at']) ?? cutoffAt,
    'coverage.observedAt',
  );
  const statusValue = stringValue(row.status);
  const complete = row.complete === false || statusValue === 'partial' ? false : true;
  const truncated = row.truncated === true || row.is_truncated === true;
  const warnings = stringList(row.warnings ?? row.warning);
  const missingAssets = stringList(row.missingAssets ?? row.missing_assets);
  const missingMeasurements = stringList(row.missingMeasurements ?? row.missing_measurements);
  const expectedInterval = optionalNumber(
    row.expectedCandleIntervalMinutes ?? row.expected_interval_minutes,
    'coverage.expectedCandleIntervalMinutes',
    true,
  );
  if (startAt >= cutoffAt)
    throw new EvidenceValidationError('invalid-window', 'Coverage start must precede its cutoff.');
  const expected = options.expectedAssetKeys ?? [];
  const returned = new Set(options.returnedAssetKeys ?? []);
  const omitted = expected.filter((key) => !returned.has(key));
  if (omitted.length)
    throw new EvidenceValidationError(
      'missing-batch-asset',
      `Missing batch assets: ${omitted.join(', ')}.`,
    );
  if (truncated)
    throw new EvidenceValidationError('truncated-response', 'Coverage is explicitly truncated.');
  if (
    options.requireComplete !== false &&
    (!complete || missingAssets.length > 0 || missingMeasurements.length > 0)
  )
    throw new EvidenceValidationError(
      'incomplete-coverage',
      'Coverage is incomplete for a published case.',
    );
  return {
    status: complete ? 'complete' : 'partial',
    description:
      stringValue(row.description) ??
      (complete
        ? 'Historical evidence window is complete.'
        : 'Historical evidence window is partial.'),
    observedAt,
    startAt,
    cutoffAt,
    complete,
    truncated,
    warnings,
    missingAssets,
    missingMeasurements,
    expectedCandleIntervalMinutes: expectedInterval,
  };
}

function assertOrdered(points: readonly { readonly at: string }[], label: string): void {
  let previous = -Infinity;
  for (const [index, point] of points.entries()) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at))
      throw new EvidenceValidationError(
        'invalid-timestamp',
        `${label}[${index}] has an invalid timestamp.`,
      );
    if (at === previous)
      throw new EvidenceValidationError(
        'duplicate-point',
        `${label} contains a duplicate timestamp.`,
      );
    if (at < previous)
      throw new EvidenceValidationError('out-of-order', `${label} is out of order.`);
    previous = at;
  }
}

function assertNonDecreasing(points: readonly { readonly at: string }[], label: string): void {
  let previous = -Infinity;
  for (const [index, point] of points.entries()) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at))
      throw new EvidenceValidationError(
        'invalid-timestamp',
        `${label}[${index}] has an invalid timestamp.`,
      );
    if (at < previous)
      throw new EvidenceValidationError('out-of-order', `${label} is out of order.`);
    previous = at;
  }
}

function assertCandleSequence(
  candles: readonly NormalizedCandle[],
  label: string,
  intervalMinutes: number | null,
): void {
  assertOrdered(candles, label);
  for (const candle of candles) {
    if (!candle.closed)
      throw new EvidenceValidationError('open-candle', `${label} contains an open candle.`);
  }
  if (intervalMinutes !== null) {
    const expected = intervalMinutes * 60_000;
    for (let index = 1; index < candles.length; index++) {
      const gap = Date.parse(candles[index]!.at) - Date.parse(candles[index - 1]!.at);
      if (gap !== expected)
        throw new EvidenceValidationError(
          'invalid-window',
          `${label} has a missing or irregular candle interval.`,
        );
    }
  }
}

export interface TemporalEvidenceInput extends Pick<
  EvidenceRecordInput,
  | 'evidenceStartAt'
  | 'cutoffAt'
  | 'entryAt'
  | 'exitAt'
  | 'collectionAt'
  | 'preDecisionCandles'
  | 'outcomeCandles'
  | 'trades'
  | 'snapshots'
  | 'coverage'
> {}

/** Assert that all clue inputs precede the cutoff and all outcome observations stay private. */
export function assertTemporalIntegrity(input: TemporalEvidenceInput): void {
  const start = Date.parse(input.evidenceStartAt);
  const cutoff = Date.parse(input.cutoffAt);
  const entry = Date.parse(input.entryAt);
  const exit = Date.parse(input.exitAt);
  const collected = Date.parse(input.collectionAt);
  if (![start, cutoff, entry, exit, collected].every(Number.isFinite))
    throw new EvidenceValidationError(
      'invalid-timestamp',
      'Evidence window contains an invalid timestamp.',
    );
  if (!(start < cutoff && cutoff <= entry && entry < exit))
    throw new EvidenceValidationError(
      'invalid-window',
      'Evidence times must be start < cutoff <= entry < exit.',
    );
  if (
    Date.parse(input.coverage.startAt) !== start ||
    Date.parse(input.coverage.cutoffAt) !== cutoff
  )
    throw new EvidenceValidationError(
      'invalid-window',
      'Coverage bounds do not match the case bounds.',
    );
  assertCandleSequence(
    input.preDecisionCandles,
    'preDecisionCandles',
    input.coverage.expectedCandleIntervalMinutes,
  );
  assertCandleSequence(input.outcomeCandles, 'outcomeCandles', null);
  if (input.preDecisionCandles.length < 2 || input.outcomeCandles.length < 2)
    throw new EvidenceValidationError(
      'incomplete-coverage',
      'Both historical windows need at least two candles.',
    );
  // Multiple DEX transactions can share one block timestamp. Candles and
  // snapshots need unique points; trades only need chronological ordering.
  assertNonDecreasing(input.trades, 'trades');
  assertOrdered(input.snapshots, 'snapshots');
  for (const candle of input.preDecisionCandles) {
    const at = Date.parse(candle.at);
    if (!(start <= at && at < cutoff))
      throw new EvidenceValidationError(
        'future-observation',
        'A pre-decision candle is outside the evidence window.',
      );
  }
  for (const trade of input.trades) {
    const at = Date.parse(trade.at);
    if (!(start <= at && at < cutoff))
      throw new EvidenceValidationError(
        'future-observation',
        'A trade at or after the cutoff cannot become a clue.',
      );
  }
  for (const snapshot of input.snapshots) {
    const at = Date.parse(snapshot.at);
    const capturedAt = Date.parse(snapshot.capturedAt);
    if (!(start <= at && at < cutoff && capturedAt < cutoff && capturedAt <= collected))
      throw new EvidenceValidationError(
        'future-observation',
        'A snapshot was captured after the decision cutoff.',
      );
  }
  for (const candle of input.outcomeCandles) {
    const at = Date.parse(candle.at);
    if (!(entry <= at && at <= exit))
      throw new EvidenceValidationError(
        'invalid-window',
        'An outcome candle is outside the entry and exit window.',
      );
  }
}

export function sourceKindOf(value: unknown): SourceKind {
  if (
    value === 'synthetic' ||
    value === 'historical-reconstructed' ||
    value === 'historical-snapshot' ||
    value === 'live-provider'
  )
    return value;
  throw new EvidenceValidationError('invalid-record', 'Unsupported evidence source kind.');
}
