import { z } from 'zod';
import type { Clue } from '../../fixtures/synthetic/scenarios.js';
import type { SyntheticAsset, SyntheticScenario } from '../../fixtures/synthetic/scenarios.js';
import type { Operation, Schema } from '../nansen/client.js';

/** The live adapter accepts provider additions while validating the fields used by the game. */
const numberLike = z.union([z.number(), z.string()]).nullable().optional();
const tokenRowSchema = z
  .object({
    chain: z.string(),
    token_address: z.string(),
    token_symbol: z.string().nullable().optional(),
    token_name: z.string().nullable().optional(),
    price_usd: numberLike,
    price_change: numberLike,
    netflow: numberLike,
    buy_volume: numberLike,
    sell_volume: numberLike,
    volume: numberLike,
    liquidity: numberLike,
  })
  .passthrough();
const screenerSchema = z
  .object({ data: z.array(tokenRowSchema), pagination: z.unknown().optional() })
  .passthrough();
const tokenInfoSchema = z
  .object({
    data: z
      .object({
        name: z.string().nullable().optional(),
        symbol: z.string().nullable().optional(),
        contract_address: z.string().nullable().optional(),
        token_details: z.record(z.string(), z.unknown()).nullable().optional(),
        spot_metrics: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const flowSchema = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).passthrough();
const smartMoneySchema = z
  .object({ data: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();
const candleSchema = z
  .object({
    data: z.array(z.record(z.string(), z.unknown())).optional(),
    tokens: z
      .array(
        z.object({
          token_address: z.string(),
          data: z.array(z.record(z.string(), z.unknown())),
        }),
      )
      .optional(),
  })
  .passthrough();
const tradesSchema = z
  .object({ data: z.array(z.record(z.string(), z.unknown())).optional() })
  .passthrough();
const transfersSchema = z
  .object({ data: z.array(z.record(z.string(), z.unknown())).optional() })
  .passthrough();

type TokenRow = z.infer<typeof tokenRowSchema>;
type TokenInfo = z.infer<typeof tokenInfoSchema>;
type FlowInfo = z.infer<typeof flowSchema>;
type SmartMoneyInfo = z.infer<typeof smartMoneySchema>;
type CandleInfo = z.infer<typeof candleSchema>;
type TradesInfo = z.infer<typeof tradesSchema>;
type TransfersInfo = z.infer<typeof transfersSchema>;

export interface LiveNansenClient {
  request<T>(
    operation: Operation,
    body: unknown,
    requestSchema: Schema<unknown>,
    responseSchema: Schema<T>,
  ): Promise<{ data: T; cached: boolean }>;
}

export class LiveCollectionError extends Error {
  constructor(message = 'Nansen did not return enough usable live assets.') {
    super(message);
    this.name = 'LiveCollectionError';
  }
}

const requestSchema: Schema<unknown> = { parse: (input) => input };
const screenerResponse: Schema<z.infer<typeof screenerSchema>> = screenerSchema;
const infoResponse: Schema<z.infer<typeof tokenInfoSchema>> = tokenInfoSchema;
const flowResponse: Schema<z.infer<typeof flowSchema>> = flowSchema;
const smartMoneyResponse: Schema<z.infer<typeof smartMoneySchema>> = smartMoneySchema;
const candleResponse: Schema<z.infer<typeof candleSchema>> = candleSchema;
const tradesResponse: Schema<z.infer<typeof tradesSchema>> = tradesSchema;
const transfersResponse: Schema<z.infer<typeof transfersSchema>> = transfersSchema;

function asNumber(value: unknown, fallback = 0): number {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function compact(value: string | null | undefined, fallback: string): string {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 32) : fallback;
}

function shortAddress(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function metricValue(record: Record<string, unknown> | null | undefined, keys: string[]): number {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null) return asNumber(value);
  }
  return 0;
}

function closeSeries(candle: CandleInfo | null): number[] {
  const points = candlePoints(candle);
  return points
    .map((point) => asNumber(point.close))
    .filter((value) => value > 0)
    .slice(-12);
}

function candlePoints(candle: CandleInfo | null): Record<string, unknown>[] {
  return Array.isArray(candle?.data)
    ? candle.data
    : (candle?.tokens?.flatMap((token) => token.data) ?? []);
}

function volumeSeries(candle: CandleInfo | null, seed: number): number[] {
  const values = candlePoints(candle)
    .map((point) => asNumber(point.volume))
    .filter((value) => value > 0)
    .slice(-12);
  if (values.length >= 2) return values.map((value) => Math.round(value));
  return Array.from({ length: 12 }, (_, index) => 300 + seed * 45 + index * 12);
}

function series(start: number, end: number, seed: number): number[] {
  const safeStart = Math.max(start, 0.000001);
  const safeEnd = Math.max(end, 0.000001);
  return Array.from({ length: 12 }, (_, index) => {
    const progress = index / 11;
    const wobble = index === 0 || index === 11 ? 0 : Math.sin(index * 1.4 + seed) * 0.012;
    return Number((safeStart + (safeEnd - safeStart) * progress + safeStart * wobble).toFixed(6));
  });
}

function clue(
  kind: Clue['kind'],
  title: string,
  headline: string,
  detail: string,
  metrics: Clue['metrics'],
  warning: string,
  observedAt: string,
): Clue {
  return { kind, title, headline, detail, metrics, warning, observedAt };
}

function stableSymbol(symbol: string): boolean {
  return /^(?:USDC|USDT|DAI|USDE|USDS|FRAX|USDY|TUSD)$/i.test(symbol.trim());
}

function candidateScore(row: TokenRow): number {
  const liquidity = Math.max(0, asNumber(row.liquidity));
  const volume = Math.max(0, asNumber(row.volume));
  const netflow = Math.abs(asNumber(row.netflow));
  return Math.log10(1 + liquidity) + Math.log10(1 + volume) + Math.log10(1 + netflow);
}

function normalizeCandidates(rows: TokenRow[]): TokenRow[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const symbol = compact(row.token_symbol, '');
      const price = asNumber(row.price_usd);
      const liquidity = asNumber(row.liquidity);
      if (!row.chain || !row.token_address || !price || price <= 0 || liquidity <= 0) return false;
      if (stableSymbol(symbol)) return false;
      const key = `${row.chain.toLowerCase()}:${row.token_address.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, 3);
}

function tradeSignals(trades: TradesInfo | null): {
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  tradeCount: number;
  largestTradeUsd: number;
} {
  const rows = Array.isArray(trades?.data) ? trades.data : [];
  let buyUsd = 0;
  let sellUsd = 0;
  let largestTradeUsd = 0;
  for (const row of rows) {
    const value = metricValue(row, [
      'value_usd',
      'usd_value',
      'amount_usd',
      'volume_usd',
      'valueUsd',
    ]);
    const side = String(
      row.side ?? row.trade_side ?? row.transaction_type ?? row.trade_type ?? row.action ?? '',
    ).toLowerCase();
    if (side.includes('sell')) sellUsd += value;
    else if (side.includes('buy')) buyUsd += value;
    largestTradeUsd = Math.max(largestTradeUsd, value);
  }
  return {
    buyUsd,
    sellUsd,
    netUsd: buyUsd - sellUsd,
    tradeCount: rows.length,
    largestTradeUsd,
  };
}

function transferSignals(transfers: TransfersInfo | null): {
  inflowUsd: number;
  outflowUsd: number;
  netUsd: number;
  transferCount: number;
  largestTransferUsd: number;
} {
  const rows = Array.isArray(transfers?.data) ? transfers.data : [];
  let inflowUsd = 0;
  let outflowUsd = 0;
  let largestTransferUsd = 0;
  for (const row of rows) {
    const value = metricValue(row, ['transfer_value_usd', 'value_usd', 'usd_value', 'amount_usd']);
    const fromLabeled = Boolean(String(row.from_address_label ?? '').trim());
    const toLabeled = Boolean(String(row.to_address_label ?? '').trim());
    if (toLabeled && !fromLabeled) inflowUsd += value;
    else if (fromLabeled && !toLabeled) outflowUsd += value;
    largestTransferUsd = Math.max(largestTransferUsd, value);
  }
  return {
    inflowUsd,
    outflowUsd,
    netUsd: inflowUsd - outflowUsd,
    transferCount: rows.length,
    largestTransferUsd,
  };
}

function makeAsset(
  row: TokenRow,
  info: TokenInfo | null,
  flowInfo: FlowInfo | null,
  smartMoneyInfo: SmartMoneyInfo | null,
  candleInfo: CandleInfo | null,
  tradesInfo: TradesInfo | null,
  transfersInfo: TransfersInfo | null,
  index: number,
  observedAt: string,
): SyntheticAsset {
  const details = info?.data.token_details;
  const spot = info?.data.spot_metrics;
  const symbol = compact(info?.data.symbol ?? row.token_symbol, shortAddress(row.token_address));
  const name = compact(info?.data.name ?? row.token_name ?? row.token_symbol, symbol);
  const candleCloses = closeSeries(candleInfo);
  const price = candleCloses.at(-1) ?? asNumber(row.price_usd, 1);
  const entry = candleCloses[0] ?? price / Math.max(0.01, 1 + asNumber(row.price_change) / 100);
  const change = (price / Math.max(entry, 0.000001) - 1) * 100;
  const flowRecord = Array.isArray(flowInfo?.data) ? (flowInfo.data[0] ?? null) : null;
  const directSmartMoney =
    (Array.isArray(smartMoneyInfo?.data) ? smartMoneyInfo.data : []).find(
      (record) =>
        String(record.token_address ?? '').toLowerCase() === row.token_address.toLowerCase() &&
        (!record.chain || String(record.chain).toLowerCase() === row.chain.toLowerCase()),
    ) ?? null;
  const directFlow = metricValue(directSmartMoney, ['net_flow_24h_usd', 'net_flow_7d_usd']);
  const flow =
    directFlow ||
    metricValue(flowRecord, [
      'smart_trader_net_flow_usd',
      'whale_net_flow_usd',
      'top_pnl_net_flow_usd',
      'public_figure_net_flow_usd',
    ]) ||
    asNumber(row.netflow);
  const smartWallets =
    metricValue(directSmartMoney, ['trader_count', 'holders_count']) ||
    metricValue(flowRecord, ['smart_trader_wallet_count', 'whale_wallet_count']);
  const candleVolumes = volumeSeries(candleInfo, index + 1);
  const buys = asNumber(row.buy_volume);
  const sells = asNumber(row.sell_volume);
  const volume = asNumber(row.volume);
  const liquidity = asNumber(row.liquidity);
  const buyers = metricValue(spot, ['unique_buyers', 'buyers', 'buying_wallets']);
  const sellers = metricValue(spot, ['unique_sellers', 'sellers', 'selling_wallets']);
  const whale = tradeSignals(tradesInfo);
  const walletTransfers = transferSignals(transfersInfo);
  const modeledPosition = Math.max(
    Math.abs(flow),
    whale.buyUsd + whale.sellUsd,
    whale.largestTradeUsd * 2,
    walletTransfers.largestTransferUsd * 2,
  );
  const sourceWarning =
    'Current Nansen 24h discovery snapshot; coverage is incomplete and this is not a prediction.';
  return {
    id: String.fromCharCode(97 + index),
    alias: `Signal ${symbol}`,
    name,
    symbol,
    providerChain: row.chain,
    providerTokenAddress: row.token_address,
    category: `${row.chain} · Nansen live`,
    series: candleCloses.length >= 2 ? candleCloses : series(entry, price, index + 1),
    volumeSeries: candleVolumes,
    volumeUsd: volume,
    liquidityUsd: liquidity,
    observedAt,
    smartMoney: {
      direction: flow > 0 ? 'accumulating' : flow < 0 ? 'distributing' : 'mixed',
      netFlowUsd: flow,
      walletCount: smartWallets || undefined,
    },
    whalePressure: whale,
    walletTransfers: walletTransfers.transferCount ? walletTransfers : undefined,
    whalePositionUsd: modeledPosition || undefined,
    holderMetrics: {
      buyers: buyers || undefined,
      sellers: sellers || undefined,
      liquidityUsd: liquidity || undefined,
      volumeUsd: volume || undefined,
    },
    entry,
    exit: price,
    outcomeSeries: series(100, 100 * (price / entry), index + 7),
    explanation: `Nansen discovery metrics combined ${change >= 0 ? 'positive' : 'negative'} 24h price movement with ${liquidity > 1_000_000 ? 'deep' : 'thinner'} liquidity, observed volume, buy/sell balance, and netflow. This replay describes evidence, not a forecast.`,
    clues: {
      flow: clue(
        'flow',
        'Follow the Funds',
        flow >= 0 ? 'Netflow leaned into the token' : 'Netflow leaned away from the token',
        flowRecord
          ? 'Flow Intelligence confirms the token screener signal across labeled holder segments.'
          : 'The token screener ranked this asset using current 24h transfer-flow and trading signals.',
        [
          {
            label: '24h netflow',
            value: `${flow >= 0 ? '+' : '−'}$${Math.abs(flow).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          },
          {
            label: 'Buy volume',
            value: `$${buys.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          },
          {
            label: 'Sell volume',
            value: `$${sells.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          },
        ],
        sourceWarning,
        observedAt,
      ),
      buyers: clue(
        'buyers',
        'Trading Footprints',
        buyers || sellers
          ? `${buyers.toLocaleString()} buyers · ${sellers.toLocaleString()} sellers`
          : 'Wallet coverage is limited',
        'Wallet counts come from available token information metrics; they are not a complete holder census.',
        [
          { label: 'Observed buyers', value: buyers ? buyers.toLocaleString() : '—' },
          { label: 'Observed sellers', value: sellers ? sellers.toLocaleString() : '—' },
          {
            label: '24h volume',
            value: `$${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          },
        ],
        'Nansen spot metrics can be partial or unavailable for newer assets. No identity or ownership claim is made.',
        observedAt,
      ),
      pulse: clue(
        'pulse',
        'Market Pulse',
        `${change >= 0 ? '+' : ''}${change.toFixed(2)}% across 24h`,
        'Price, liquidity, and volume provide the market context for this current-data replay.',
        [
          { label: '24h move', value: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` },
          {
            label: 'Liquidity',
            value: `$${liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          },
          {
            label: '24h volume',
            value: `$${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          },
        ],
        sourceWarning,
        observedAt,
      ),
    },
  };
}

/** Collects one attributable, current-data scenario from discovery, smart-money, flow, info, and OHLCV data. */
export async function collectLiveScenario(
  client: LiveNansenClient,
  now: () => Date = () => new Date(),
): Promise<SyntheticScenario> {
  const observedAt = now().toISOString();
  const response = await client.request(
    'liveCandidates',
    {
      chains: ['ethereum', 'solana', 'base', 'arbitrum', 'polygon'],
      timeframe: '24h',
      pagination: { page: 1, per_page: 20 },
      filters: {},
      order_by: [{ field: 'netflow', direction: 'DESC' }],
    },
    requestSchema,
    screenerResponse,
  );
  const candidates = normalizeCandidates(response.data.data);
  if (candidates.length < 3) throw new LiveCollectionError();
  const smartMoneyInfo = await client
    .request(
      'liveSmartMoneyNetflow',
      {
        chains: ['ethereum', 'solana', 'base', 'arbitrum', 'polygon'],
        filters: {
          include_smart_money_labels: ['Fund', 'Smart Trader', '30D Smart Trader'],
          include_stablecoins: false,
        },
        pagination: { page: 1, per_page: 100 },
        order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }],
      },
      requestSchema,
      smartMoneyResponse,
    )
    .then((result) => result.data)
    .catch(() => null);
  const enriched = await Promise.all(
    candidates.map(async (candidate) => {
      const base = { chain: candidate.chain, token_address: candidate.token_address };
      const [info, flowInfo, candleInfo, tradesInfo, transfersInfo] = await Promise.all([
        client
          .request('liveTokenInfo', { ...base, timeframe: '1d' }, requestSchema, infoResponse)
          .then((response) => response.data)
          .catch(() => null),
        client
          .request(
            'liveFlow',
            { ...base, timeframe: '1d', filters: {} },
            requestSchema,
            flowResponse,
          )
          .then((response) => response.data)
          .catch(() => null),
        client
          .request(
            'liveCandles',
            {
              ...base,
              timeframe: '1h',
              date: {
                from: new Date(Date.parse(observedAt) - 86_400_000).toISOString(),
                to: observedAt,
              },
            },
            requestSchema,
            candleResponse,
          )
          .then((response) => response.data)
          .catch(() => null),
        client
          .request(
            'liveTrades',
            {
              ...base,
              date: {
                from: new Date(Date.parse(observedAt) - 86_400_000).toISOString(),
                to: observedAt,
              },
              only_smart_money: true,
              filters: {
                include_smart_money_labels: ['Whale', 'Fund', 'Smart Trader'],
              },
              pagination: { page: 1, per_page: 50 },
              order_by: [{ field: 'value_usd', direction: 'DESC' }],
            },
            requestSchema,
            tradesResponse,
          )
          .then((response) => response.data)
          .catch(() => null),
        client
          .request(
            'liveTransfers',
            {
              ...base,
              date: {
                from: new Date(Date.parse(observedAt) - 86_400_000).toISOString(),
                to: observedAt,
              },
              pagination: { page: 1, per_page: 50 },
              filters: {
                only_smart_money: true,
                from_include_smart_money_labels: ['Whale', 'Fund', 'Smart Trader'],
                to_include_smart_money_labels: ['Whale', 'Fund', 'Smart Trader'],
              },
              order_by: [{ field: 'transfer_value_usd', direction: 'DESC' }],
            },
            requestSchema,
            transfersResponse,
          )
          .then((response) => response.data)
          .catch(() => null),
      ]);
      return { info, flowInfo, candleInfo, tradesInfo, transfersInfo };
    }),
  );
  const stamp = observedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return {
    id: `live-nansen-${stamp}`,
    index: 1,
    mode: 'live',
    sourceLabel: 'Nansen API · 24h token signal',
    sourceUrl: 'https://nansen.ai',
    title: 'The live signal',
    subtitle: 'A current-data replay built from Nansen token discovery.',
    cutoff: observedAt,
    assets: candidates.map((candidate, index) =>
      makeAsset(
        candidate,
        enriched[index]?.info ?? null,
        enriched[index]?.flowInfo ?? null,
        smartMoneyInfo,
        enriched[index]?.candleInfo ?? null,
        enriched[index]?.tradesInfo ?? null,
        enriched[index]?.transfersInfo ?? null,
        index,
        observedAt,
      ),
    ),
  };
}
