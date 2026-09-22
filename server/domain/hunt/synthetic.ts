import { compileHuntBoard } from '../../evidence/compiler.js';
import type { CompiledHuntBoard } from '../../evidence/types.js';

function iso(minutes: number): string {
  return new Date(Date.UTC(2026, 8, 17, 12, minutes, 0)).toISOString();
}

const PRE_DECISION_SHAPES: readonly (readonly number[])[] = [
  [0.0, 0.035, 0.018, 0.062, 0.048, 0.101, 0.081, 0.142, 0.119, 0.188, 0.167, 0.231],
  [0.0, 0.015, -0.01, 0.012, -0.008, 0.02, 0.004, 0.015, -0.004, 0.012, 0.002, 0.01],
  [0.0, 0.005, 0.006, 0.055, 0.056, 0.06, 0.115, 0.12, 0.17, 0.175, 0.23, 0.235],
  [0.0, -0.035, -0.065, -0.045, -0.1, -0.075, -0.12, -0.1, -0.15, -0.13, -0.19, -0.16],
  [0.0, 0.02, 0.035, 0.22, 0.16, 0.1, 0.07, 0.04, 0.02, -0.01, -0.03, -0.02],
  [0.0, -0.02, 0.04, -0.03, 0.05, -0.04, 0.08, -0.02, 0.03, -0.06, 0.06, 0.01],
];

const OUTCOME_SHAPES: readonly (readonly number[])[] = [
  [0.24, 0.27, 0.3, 0.28, 0.33, 0.37, 0.35, 0.4, 0.43, 0.46, 0.48, 0.51],
  [0.01, -0.02, 0.02, -0.01, 0.015, -0.005, 0.01, -0.015, 0.02, 0.0, 0.012, 0.006],
  [0.24, 0.2, 0.23, 0.18, 0.25, 0.21, 0.29, 0.26, 0.34, 0.3, 0.39, 0.36],
  [-0.17, -0.2, -0.22, -0.19, -0.25, -0.29, -0.27, -0.33, -0.31, -0.36, -0.4, -0.38],
  [-0.02, -0.05, -0.08, -0.04, -0.1, -0.07, -0.12, -0.09, -0.14, -0.11, -0.16, -0.13],
  [0.02, -0.08, 0.06, -0.12, 0.1, -0.04, 0.14, -0.1, 0.08, -0.16, 0.12, -0.02],
];

const BASE_PRICES = [0.024, 1.82, 14.6, 236, 0.74, 6.4] as const;

function candles(assetIndex: number, outcome: boolean): readonly Record<string, unknown>[] {
  const start = outcome ? 60 : 0;
  const shape = (outcome ? OUTCOME_SHAPES : PRE_DECISION_SHAPES)[assetIndex];
  const base = BASE_PRICES[assetIndex];
  return Array.from({ length: outcome ? 12 : 12 }, (_, index) => {
    const close = base * (1 + shape[index]);
    const open = base * (1 + (index === 0 ? shape[index] - 0.008 : shape[index - 1]));
    const spread = base * (0.006 + (assetIndex % 3) * 0.002);
    return {
      at: iso(start + index * 5),
      open,
      high: Math.max(open, close) + spread,
      low: Math.max(0.00000001, Math.min(open, close) - spread),
      close,
      volume:
        900 +
        assetIndex * 180 +
        index * (outcome ? 55 : 35) +
        Math.round(Math.abs(shape[index]) * 500),
      closed: true,
    };
  });
}

function trades(assetIndex: number): readonly Record<string, unknown>[] {
  const shape = PRE_DECISION_SHAPES[assetIndex];
  const base = BASE_PRICES[assetIndex];
  return Array.from({ length: 8 }, (_, index) => ({
    at: iso(5 + index * 6),
    side:
      assetIndex === 3 || (assetIndex === 5 && index % 2 === 1) || index % 4 === 0 ? 'sell' : 'buy',
    price: base * (1 + shape[Math.min(index, shape.length - 1)]),
    amount: 10 + assetIndex * 2 + index * (assetIndex === 4 ? 2 : 1),
    valueUsd:
      (10 + assetIndex * 2 + index * (assetIndex === 4 ? 2 : 1)) *
      base *
      (1 + shape[Math.min(index, shape.length - 1)]),
    wallet: `synthetic-wallet-${assetIndex}-${index % 3}`,
    sourceId: `synthetic-trade-${assetIndex}-${index}`,
  }));
}

/** Builds the six-asset credential-free board used by synthetic Hunt play. */
export function createSyntheticHuntBoard(boardId = 'synthetic-hunt-board-v1'): CompiledHuntBoard {
  const cutoffAt = iso(60);
  const cases = Array.from({ length: 6 }, (_, assetIndex) => ({
    caseId: `hunt-synthetic-asset-${assetIndex + 1}`,
    roundIndex: assetIndex + 1,
    sourceKind: 'synthetic' as const,
    chain: 'synthetic-chain',
    tokenAddress: `synthetic-token-${assetIndex + 1}`,
    symbol: `SYN${assetIndex + 1}`,
    name: `Synthetic Asset ${assetIndex + 1}`,
    evidenceStartAt: iso(0),
    cutoffAt,
    entryAt: iso(60),
    exitAt: iso(120),
    collectionAt: iso(50),
    preDecisionCandles: candles(assetIndex, false),
    outcomeCandles: candles(assetIndex, true),
    trades: trades(assetIndex),
    snapshots: [],
    coverage: {
      startAt: iso(0),
      cutoffAt,
      observedAt: iso(50),
      status: 'complete',
      complete: true,
      truncated: false,
      warnings: [],
      missingAssets: [],
      missingMeasurements: [],
      expectedCandleIntervalMinutes: 5,
      description: 'Synthetic Hunt evidence is deterministic and complete for local play.',
    },
    attribution: [{ label: 'Synthetic Hunt fixture', sourceKind: 'synthetic' as const }],
  }));
  return compileHuntBoard({ boardId, cases, sourceKind: 'synthetic' });
}
