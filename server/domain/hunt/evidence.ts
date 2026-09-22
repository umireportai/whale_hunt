import type {
  EvidenceAttribution,
  EvidenceCategory,
  RevealedClue,
} from '../../../shared/evidence.js';
import type { OpaqueId } from '../../../shared/game-rules.js';
import { HUNT_EVIDENCE_VERSION, HUNT_ENGINE_RULES, scanDefinitionFor } from './rules.js';
import type {
  HuntEventRecord,
  HuntMarketEvent,
  HuntPlanRecord,
  HuntPurchaseRecord,
} from './types.js';
import type { CompiledHuntBoard } from '../../evidence/types.js';

function timestamp(value: string, offsetMs: number): string {
  const parsed = Date.parse(value);
  return new Date((Number.isFinite(parsed) ? parsed : 0) + offsetMs).toISOString();
}

function roundForAsset(assetRoundIndex: number): number {
  return ((assetRoundIndex - 1) % 5) + 1;
}

function stableEvents(events: readonly HuntMarketEvent[]): readonly HuntMarketEvent[] {
  return [...events].sort(
    (left, right) => left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId),
  );
}

function historicalEvents(board: CompiledHuntBoard): readonly HuntMarketEvent[] {
  return stableEvents(
    board.assets.flatMap((asset) =>
      asset.trades.map((trade, index) => ({
        eventId: `historical:${asset.caseId}:${trade.sourceId ?? index}`,
        roundIndex: (index % 5) + 1,
        assetId: asset.caseId,
        at: trade.at,
        side: trade.side,
        units: Math.max(1, trade.amount ?? 1),
        valueUsd: Math.abs(trade.valueUsd ?? 0),
        source: 'historical' as const,
      })),
    ),
  );
}

/** Combines fixed historical observations and simulated purchases into one replayable record. */
export function createEventRecord(
  board: CompiledHuntBoard,
  simulated: readonly HuntPurchaseRecord[] = [],
): HuntEventRecord {
  const historical = historicalEvents(board);
  return {
    board,
    historical,
    simulated: [...simulated],
    events: stableEvents([...historical, ...simulated]),
  };
}

function busiestInterval(events: readonly HuntMarketEvent[], fallback: string): string {
  const byMinute = new Map<string, number>();
  for (const event of events) {
    const minute = event.at.slice(0, 16);
    byMinute.set(minute, (byMinute.get(minute) ?? 0) + event.valueUsd);
  }
  const selected = [...byMinute.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
  return selected ? `${selected}:00.000Z` : fallback;
}

function simulatedValue(assetId: OpaqueId, units: number, board: CompiledHuntBoard): number {
  const index = Math.max(
    0,
    board.assets.findIndex((asset) => asset.caseId === assetId),
  );
  return units * (HUNT_ENGINE_RULES.eventValuePerUnitUsd + index * 100);
}

function simulatedPurchaseEvents(
  board: CompiledHuntBoard,
  plan: HuntPlanRecord,
  priorPurchaseCount: number,
): readonly HuntPurchaseRecord[] {
  if (plan.action === 'wait' || !plan.assetId || plan.units === 0) return [];
  const assetEvents = historicalEvents(board).filter(
    (event) => event.assetId === plan.assetId && event.roundIndex === plan.roundIndex,
  );
  const fallback = board.cutoffAt;
  const busy = busiestInterval(assetEvents, fallback);
  const baseOffset = (priorPurchaseCount + 1) * 1_000 + plan.roundIndex * 10_000;
  const count = plan.action === 'drip' ? plan.units : 1;
  return Array.from({ length: count }, (_, index) => {
    const units = plan.action === 'drip' ? 1 : plan.units;
    const at =
      plan.action === 'blend'
        ? timestamp(busy, index * 1_000)
        : timestamp(fallback, baseOffset + index * 60_000);
    return {
      eventId: `simulated:${plan.roundIndex}:${priorPurchaseCount + index + 1}`,
      roundIndex: plan.roundIndex,
      assetId: plan.assetId!,
      at,
      side: 'buy' as const,
      units,
      valueUsd: simulatedValue(plan.assetId!, units, board),
      source: 'simulated' as const,
      action: plan.action,
    };
  });
}

/** Applies one validated whale plan while leaving historical prices and candles unchanged. */
export function applyPlan(record: HuntEventRecord, plan: HuntPlanRecord): HuntEventRecord {
  const purchases = simulatedPurchaseEvents(record.board, plan, record.simulated.length);
  return createEventRecord(record.board, [...record.simulated, ...purchases]);
}

function signedFlow(events: readonly HuntMarketEvent[]): number {
  return events.reduce(
    (total, event) => total + (event.side === 'buy' ? event.valueUsd : -event.valueUsd),
    0,
  );
}

function money(value: number): string {
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(0)}`;
}

function percent(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;
}

function coverageFor(record: HuntEventRecord, scanId: OpaqueId) {
  const asset =
    record.board.publicAssets.find((candidate) =>
      candidate.clueDescriptors.some((clue) => clue.clueId === scanId),
    ) ?? record.board.publicAssets[0];
  if (!asset) throw new Error('A Hunt board needs one public asset.');
  return { coverage: asset.coverage, attribution: asset.attribution };
}

function clue(
  record: HuntEventRecord,
  scanId: OpaqueId,
  roundIndex: number,
  category: EvidenceCategory,
  title: string,
  factualHeadline: string,
  metrics: RevealedClue['metrics'],
  interpretation: string,
  limitation?: string,
): RevealedClue {
  const definition = scanDefinitionFor(scanId);
  const scopedAsset = record.board.publicAssets.find((asset) =>
    asset.clueDescriptors.some((descriptor) => descriptor.clueId === scanId),
  );
  const { coverage, attribution } = coverageFor(record, scanId);
  return {
    clueId: scanId,
    category,
    title,
    factualHeadline,
    metrics,
    interpretation,
    limitation,
    evidenceCutoff: record.board.cutoffAt,
    scope:
      definition.scope === 'board'
        ? { kind: 'board', label: 'All locations' }
        : {
            kind: 'asset',
            assetId: scopedAsset?.assetId ?? 'unknown-asset',
            label: scopedAsset?.attemptAlias,
          },
    roundIndex,
    window: {
      startAt: record.board.assets[0]?.evidenceStartAt ?? record.board.cutoffAt,
      endAt: record.board.cutoffAt,
      label: 'Observed Hunt window',
    },
    sourceKind: record.board.sourceKind,
    coverage,
    attribution: attribution as readonly EvidenceAttribution[],
  };
}

function availableMetric(
  label: string,
  value: number | null,
  formatter: (value: number) => string = (item) => String(item),
): { label: string; value: string } {
  return {
    label,
    value: value === null ? 'Unavailable' : formatter(value),
    ...(value === null ? {} : { numericValue: value }),
  };
}

/** Resolves a scan from the stored event record; it never reads hidden targets. */
export function resolveScan(
  record: HuntEventRecord,
  input: { readonly roundIndex: number; readonly scanId: OpaqueId; readonly assetId?: OpaqueId },
): RevealedClue {
  const definition = scanDefinitionFor(input.scanId);
  const inferredAssetId = record.board.publicAssets.find((asset) =>
    asset.clueDescriptors.some((clue) => clue.clueId === input.scanId),
  )?.assetId;
  const scopedAssetId =
    definition.scope === 'asset' ? (input.assetId ?? inferredAssetId) : undefined;
  if (definition.scope === 'asset' && !scopedAssetId)
    throw new Error('An asset-scoped Hunt scan needs a selected location.');
  const inScope = (event: HuntMarketEvent) => !scopedAssetId || event.assetId === scopedAssetId;
  const observed = record.events.filter(
    (event) => event.roundIndex <= input.roundIndex && inScope(event),
  );
  const simulated = record.simulated.filter(
    (event) => event.roundIndex <= input.roundIndex && inScope(event),
  );
  const currentHistorical = record.historical.filter(
    (event) => event.roundIndex === input.roundIndex && inScope(event),
  );
  const currentSimulated = simulated.filter((event) => event.roundIndex === input.roundIndex);
  const signed = signedFlow([...currentHistorical, ...currentSimulated]);
  const total = [...currentHistorical, ...currentSimulated].reduce(
    (sum, event) => sum + event.valueUsd,
    0,
  );

  switch (definition.kind) {
    case 'net-buying':
      return clue(
        record,
        input.scanId,
        input.roundIndex,
        definition.category,
        definition.title,
        `${signed >= 0 ? 'Buying' : 'Selling'} was larger in the observed window`,
        [
          availableMetric('Net observed flow', signed, money),
          availableMetric('Observed activity', total, money),
        ],
        'The scan adds fixed historical observations and simulated purchases from the same event record.',
        'This game signal is a bounded observation and does not state what the historical market would have done next.',
      );
    case 'purchase-concentration': {
      const largest = simulated.length
        ? Math.max(...simulated.map((event) => event.valueUsd))
        : null;
      const simulatedTotal = simulated.reduce((sum, event) => sum + event.valueUsd, 0);
      const concentration =
        largest !== null && simulatedTotal > 0 ? (largest / simulatedTotal) * 100 : null;
      return clue(
        record,
        input.scanId,
        input.roundIndex,
        definition.category,
        definition.title,
        concentration === null
          ? 'Simulated purchase concentration is unavailable'
          : 'Simulated purchases clustered in one or more intervals',
        [
          availableMetric('Largest purchase share', concentration, percent),
          availableMetric('Simulated activity', simulatedTotal, money),
        ],
        'Concentration compares the largest simulated event with total simulated purchase activity.',
        concentration === null ? 'No simulated purchase baseline is available yet.' : undefined,
      );
    }
    case 'repeated-accumulation': {
      const byAssetRound = new Set(
        simulated.map((event) => `${event.assetId}:${event.roundIndex}`),
      );
      const assets = new Set(simulated.map((event) => event.assetId)).size;
      return clue(
        record,
        input.scanId,
        input.roundIndex,
        definition.category,
        definition.title,
        simulated.length
          ? 'Simulated buying appeared across repeated observations'
          : 'Repeated simulated accumulation is unavailable',
        [
          availableMetric(
            'Positive asset-round observations',
            simulated.length ? byAssetRound.size : null,
          ),
          availableMetric('Assets with simulated activity', simulated.length ? assets : null),
        ],
        'Repeated accumulation counts positive simulated position growth by asset and round.',
        simulated.length ? undefined : 'No simulated purchase baseline is available yet.',
      );
    }
    case 'timing': {
      const baseline = record.historical.filter((event) => event.roundIndex < input.roundIndex);
      const current = [...currentHistorical, ...currentSimulated];
      const first = current[0]?.at;
      const last = current.at(-1)?.at;
      return clue(
        record,
        input.scanId,
        input.roundIndex,
        definition.category,
        definition.title,
        current.length
          ? 'Observed activity had a repeatable time placement'
          : 'Timing evidence is unavailable',
        [
          {
            label: 'Earlier baseline',
            value: baseline.length ? `${baseline.length} events` : 'Unavailable',
          },
          {
            label: 'Observed placement',
            value:
              first && last ? `${first.slice(11, 16)}–${last.slice(11, 16)} UTC` : 'Unavailable',
          },
        ],
        'Timing compares the current activity placement with earlier historical activity in the fixed background.',
        baseline.length ? undefined : 'An earlier baseline is unavailable for this round.',
      );
    }
    case 'cross-asset-rhythm': {
      const assets = new Set(
        observed.filter((event) => event.source === 'simulated').map((event) => event.assetId),
      );
      const historicalAssets = new Set(observed.map((event) => event.assetId));
      return clue(
        record,
        input.scanId,
        input.roundIndex,
        definition.category,
        definition.title,
        assets.size
          ? 'Activity appeared in a cross-asset rhythm'
          : 'Cross-asset simulated rhythm is unavailable',
        [
          availableMetric('Assets with simulated activity', assets.size ? assets.size : null),
          availableMetric('Observed asset locations', historicalAssets.size),
        ],
        'The scan compares event timing across asset locations without assigning a target flag.',
        assets.size ? undefined : 'No simulated cross-asset baseline is available yet.',
      );
    }
    case 'growing-position': {
      const currentUnits = currentSimulated.reduce((sum, event) => sum + event.units, 0);
      const priorUnits = simulated
        .filter((event) => event.roundIndex < input.roundIndex)
        .reduce((sum, event) => sum + event.units, 0);
      const baseline = input.roundIndex > 1 ? priorUnits : null;
      return clue(
        record,
        input.scanId,
        input.roundIndex,
        definition.category,
        definition.title,
        currentUnits
          ? 'The simulated position grew during this round'
          : 'Growing simulated position is unavailable',
        [
          availableMetric('Current simulated units', currentUnits || null),
          availableMetric('Earlier baseline units', baseline),
        ],
        'Position growth is calculated from simulated purchases in the stored event record.',
        baseline === null ? 'An earlier baseline is unavailable for the first round.' : undefined,
      );
    }
  }
}
