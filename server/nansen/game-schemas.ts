import { z } from 'zod';

const numeric = z.union([z.number(), z.string()]).nullable().optional();
const objectRow = z.record(z.string(), z.unknown());
const metadata = {
  pagination: z.unknown().optional(),
  warnings: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
};

export const GAME_EVIDENCE_OPERATIONS = {
  historicalCandidates: {
    path: '/api/v1/token-screener',
    estimatedCredits: 1,
  },
  historicalFlow: {
    path: '/api/v1/tgm/flow-intelligence',
    estimatedCredits: 1,
  },
  historicalTrades: {
    path: '/api/v1/tgm/dex-trades',
    estimatedCredits: 1,
  },
  historicalCandles: {
    path: '/api/v1/tgm/token-ohlcv',
    estimatedCredits: 1,
  },
} as const;

export type GameEvidenceOperation = keyof typeof GAME_EVIDENCE_OPERATIONS;

const dateRange = z.object({ from: z.string(), to: z.string() }).passthrough();
const pagination = z
  .object({ page: z.number().int().positive(), per_page: z.number().int().positive() })
  .passthrough();

export const historicalCandidatesRequestSchema = z
  .object({
    chains: z.array(z.string()).min(1),
    timeframe: z.enum(['5m', '10m', '1h', '6h', '24h', '7d', '30d']),
    filters: z.record(z.string(), z.unknown()).optional(),
    order_by: z.array(z.record(z.string(), z.unknown())).optional(),
    pagination,
  })
  .passthrough();

export const historicalFlowRequestSchema = z
  .object({
    chain: z.string().min(1),
    token_address: z.string().min(1),
    timeframe: z.enum(['5m', '1h', '6h', '12h', '1d', '7d']),
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const historicalTradesRequestSchema = z
  .object({
    chain: z.string().min(1),
    token_address: z.string().min(1),
    date: dateRange,
    only_smart_money: z.boolean().optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    order_by: z.array(z.record(z.string(), z.unknown())).optional(),
    pagination,
  })
  .passthrough();

export const historicalCandlesRequestSchema = z
  .object({
    chain: z.string().min(1),
    token_address: z.string().min(1),
    date: dateRange,
    timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']),
  })
  .passthrough();

export const historicalCandidateRowSchema = z
  .object({
    chain: z.string().min(1),
    token_address: z.string().min(1),
    token_symbol: z.string().nullable().optional(),
    token_name: z.string().nullable().optional(),
    price_usd: numeric,
    volume: numeric,
    liquidity: numeric,
  })
  .passthrough();

export const historicalCandidatesResponseSchema = z
  .object({ data: z.array(historicalCandidateRowSchema), ...metadata })
  .passthrough();

const historicalRows = z.union([
  z.array(objectRow),
  z.object({ data: z.array(objectRow), ...metadata }).passthrough(),
]);

export const historicalFlowResponseSchema = historicalRows;
export const historicalTradesResponseSchema = historicalRows;

const tokenBatch = z
  .object({
    token_address: z.string().optional(),
    data: z.array(objectRow),
  })
  .passthrough();

export const historicalCandlesResponseSchema = z
  .object({
    data: z.array(objectRow).optional(),
    tokens: z.array(tokenBatch).optional(),
    ...metadata,
  })
  .passthrough();

export const GAME_EVIDENCE_SCHEMAS = {
  historicalCandidates: historicalCandidatesResponseSchema,
  historicalFlow: historicalFlowResponseSchema,
  historicalTrades: historicalTradesResponseSchema,
  historicalCandles: historicalCandlesResponseSchema,
} as const;

export type HistoricalCandidateRow = z.infer<typeof historicalCandidateRowSchema>;
export type HistoricalCandidatesResponse = z.infer<typeof historicalCandidatesResponseSchema>;
export type HistoricalFlowResponse = z.infer<typeof historicalFlowResponseSchema>;
export type HistoricalTradesResponse = z.infer<typeof historicalTradesResponseSchema>;
export type HistoricalCandlesResponse = z.infer<typeof historicalCandlesResponseSchema>;

/** Return the response schema used at the provider boundary for a historical operation. */
export function gameEvidenceResponseSchema(operation: GameEvidenceOperation) {
  return GAME_EVIDENCE_SCHEMAS[operation];
}

/** Return the request schema used before a historical request is sent. */
export function gameEvidenceRequestSchema(operation: GameEvidenceOperation) {
  return {
    historicalCandidates: historicalCandidatesRequestSchema,
    historicalFlow: historicalFlowRequestSchema,
    historicalTrades: historicalTradesRequestSchema,
    historicalCandles: historicalCandlesRequestSchema,
  }[operation];
}
