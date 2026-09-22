export type CardKind = 'flow' | 'buyers' | 'pulse';
export type RoundMode = 'synthetic' | 'live';

export interface Clue {
  readonly kind: CardKind;
  readonly title: string;
  readonly headline: string;
  readonly detail: string;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly warning: string;
  readonly observedAt: string;
}

export interface SyntheticAsset {
  id: string;
  alias: string;
  name: string;
  symbol: string;
  /** Provider references stay server-side; Game.round never serializes them before lock. */
  providerChain?: string;
  providerTokenAddress?: string;
  category: string;
  series: number[];
  volumeSeries?: number[];
  volumeUsd?: number;
  liquidityUsd?: number;
  observedAt?: string;
  smartMoney?: {
    direction: 'accumulating' | 'distributing' | 'mixed' | 'unavailable';
    netFlowUsd?: number;
    walletCount?: number;
  };
  whalePressure?: {
    buyUsd: number;
    sellUsd: number;
    netUsd: number;
    tradeCount?: number;
    largestTradeUsd?: number;
  };
  walletTransfers?: {
    inflowUsd: number;
    outflowUsd: number;
    netUsd: number;
    transferCount?: number;
    largestTransferUsd?: number;
  };
  whalePositionUsd?: number;
  holderMetrics?: {
    buyers?: number;
    sellers?: number;
    liquidityUsd?: number;
    volumeUsd?: number;
  };
  entry: number;
  exit: number;
  outcomeSeries: number[];
  explanation: string;
  clues: Record<CardKind, Clue>;
}
export interface SyntheticScenario {
  id: string;
  index: number;
  title: string;
  subtitle: string;
  cutoff: string;
  assets: SyntheticAsset[];
  mode?: RoundMode;
  sourceLabel?: string;
  sourceUrl?: string;
}

const stories = [
  {
    title: 'First currents',
    subtitle: 'Big splashes attract attention. Quiet currents move the ocean.',
    returns: [14, -8, 5],
    prior: [4, 12, -3],
  },
  {
    title: 'The crowded trade',
    subtitle: 'When everyone sees the same signal, who is left to buy?',
    returns: [-13, 9, 2],
    prior: [18, -2, 5],
  },
  {
    title: 'Against the tide',
    subtitle: 'A green clue can still meet a red market.',
    returns: [-6, -17, -3],
    prior: [6, 8, -4],
  },
  {
    title: 'Quiet accumulation',
    subtitle: 'Read the evidence. Decide how much uncertainty to carry.',
    returns: [3, 18, -9],
    prior: [-1, 3, 11],
  },
  {
    title: 'The final wave',
    subtitle: 'One last allocation. Every percentage point is your call.',
    returns: [11, -4, 7],
    prior: [7, -5, 2],
  },
];
const identities = [
  ['Coral', 'CRL', 'Tidal', 'TDL', 'Pearl', 'PRL'],
  ['Kelp', 'KLP', 'Marina', 'MRN', 'Drift', 'DRF'],
  ['Anchor', 'ANC', 'Foam', 'FOM', 'Lagoon', 'LGN'],
  ['Reef', 'REF', 'Nautilus', 'NAU', 'Squall', 'SQL'],
  ['Orca', 'ORC', 'Buoy', 'BUY', 'Current', 'CUR'],
];

function makeSeries(start: number, end: number, seed: number): number[] {
  return Array.from({ length: 12 }, (_, i) =>
    Number(
      (
        start +
        ((end - start) * i) / 11 +
        (i === 0 || i === 11 ? 0 : Math.sin(i * 1.8 + seed) * Math.abs(start) * 0.013)
      ).toFixed(4),
    ),
  );
}

export const SCENARIOS: SyntheticScenario[] = stories.map((story, roundIndex) => {
  const cutoff = `2026-08-${String(10 + roundIndex * 3).padStart(2, '0')}T23:59:59Z`;
  return {
    id: `synthetic-v1-${roundIndex + 1}`,
    index: roundIndex + 1,
    title: story.title,
    subtitle: story.subtitle,
    cutoff,
    assets: ['a', 'b', 'c'].map((id, assetIndex) => {
      const prior = story.prior[assetIndex]!;
      const entry = 1 + assetIndex * 0.75 + roundIndex * 0.25;
      const exit = entry * (1 + story.returns[assetIndex]! / 100);
      const flow = [
        [420, 90, -65],
        [590, 130, 25],
        [110, 270, -80],
        [-35, 310, 460],
        [210, -120, 80],
      ][roundIndex]![assetIndex]!;
      const buyers = [
        [72, 19, 46],
        [15, 67, 40],
        [54, 23, 38],
        [41, 82, 17],
        [68, 31, 59],
      ][roundIndex]![assetIndex]!;
      const clue = (
        kind: CardKind,
        title: string,
        headline: string,
        detail: string,
        metrics: Clue['metrics'],
        warning: string,
      ): Clue => ({ kind, title, headline, detail, metrics, warning, observedAt: cutoff });
      return {
        id,
        alias: `Token ${id.toUpperCase()}`,
        name: identities[roundIndex]![assetIndex * 2]!,
        symbol: identities[roundIndex]![assetIndex * 2 + 1]!,
        category: 'Base · fictional token',
        series: makeSeries(100 / (1 + prior / 100), 100, roundIndex + assetIndex),
        entry,
        exit,
        outcomeSeries: makeSeries(100, (100 * exit) / entry, roundIndex * 5 + assetIndex),
        whalePressure: {
          buyUsd: flow > 0 ? (Math.abs(flow) + 45) * 1_000 : 18_000,
          sellUsd: flow < 0 ? (Math.abs(flow) + 45) * 1_000 : 18_000,
          netUsd:
            flow > 0
              ? (Math.abs(flow) + 27) * 1_000
              : flow < 0
                ? -((Math.abs(flow) + 27) * 1_000)
                : 0,
          tradeCount: 8 + assetIndex * 2,
          largestTradeUsd: (Math.abs(flow) + 45) * 400,
        },
        explanation: `${flow > 0 ? 'Positive' : 'Negative'} observed transfer flow and ${buyers > 45 ? 'broader' : 'concentrated'} observed buying preceded a ${Math.abs(story.returns[assetIndex]!)}% ${story.returns[assetIndex]! >= 0 ? 'rise' : 'fall'}. These fictional outcomes illustrate that clues are evidence, never guarantees.`,
        clues: {
          flow: clue(
            'flow',
            'Follow the Funds',
            flow > 0 ? 'More flowed in than out' : 'More flowed out than in',
            'Net transfers for the fictional tracked cohort during the completed observation window.',
            [
              { label: 'Net transfer flow', value: `${flow > 0 ? '+' : '−'}$${Math.abs(flow)}K` },
              { label: 'Observed wallets', value: String(18 + assetIndex * 7 + roundIndex * 2) },
            ],
            'Synthetic evidence. Transfers are not executed purchases; cohort coverage is incomplete.',
          ),
          buyers: clue(
            'buyers',
            'Trading Footprints',
            buyers > 45
              ? 'Buying was spread across the sample'
              : 'A few buyers dominated the sample',
            'Distribution among observed buyers in the fictional BUY-only sample.',
            [
              { label: 'Observed buyers', value: String(buyers) },
              {
                label: 'Top 3 share',
                value: `${buyers > 45 ? 24 + assetIndex * 3 : 69 + assetIndex * 4}%`,
              },
            ],
            'Synthetic, truncated BUY-only sample. No claim about all buyers, selling, or net accumulation.',
          ),
          pulse: clue(
            'pulse',
            'Market Pulse',
            prior >= 0
              ? 'Momentum entered the window positive'
              : 'Price softened before the cutoff',
            'Market conditions from the completed period before the allocation window.',
            [
              { label: 'Prior 24h move', value: `${prior > 0 ? '+' : ''}${prior}%` },
              {
                label: 'Liquidity',
                value: `$${(0.8 + assetIndex * 0.6 + roundIndex * 0.2).toFixed(1)}M`,
              },
              {
                label: '24h volume',
                value: `$${(0.4 + assetIndex * 0.3 + roundIndex * 0.1).toFixed(1)}M`,
              },
            ],
            'Synthetic market snapshot. Past movement does not predict the next period.',
          ),
        },
      };
    }),
  };
});
