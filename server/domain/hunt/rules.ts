import { HUNT_RULES, type OpaqueId } from '../../../shared/game-rules.js';
import type { EvidenceCategory } from '../../../shared/evidence.js';

export const HUNT_ENGINE_VERSION = 'hunt-engine-v1' as const;
export const HUNT_EVIDENCE_VERSION = 'hunt-evidence-v1' as const;

export const HUNT_ENGINE_RULES = {
  ...HUNT_RULES,
  /** Kept for older callers; every Hunt phase is now capped at one minute. */
  phaseDurationMs: 60 * 1000,
  setupDurationMs: 45 * 1000,
  whalePlanningDurationMs: 45 * 1000,
  tracerInvestigationDurationMs: 60 * 1000,
  finalAccusationDurationMs: 45 * 1000,
  reconnectGraceMs: 15 * 1000,
  botDecisionMinMs: 250,
  botDecisionMaxMs: 750,
  maxNameLength: 80,
  scoreRounding: 'nearest-integer' as const,
  eventValuePerUnitUsd: 1_000,
} as const;

export type HuntScanKind =
  | 'net-buying'
  | 'purchase-concentration'
  | 'repeated-accumulation'
  | 'timing'
  | 'cross-asset-rhythm'
  | 'growing-position';

export interface HuntScanDefinition {
  readonly kind: HuntScanKind;
  readonly category: EvidenceCategory;
  readonly title: string;
  readonly question: string;
  readonly scope: 'asset' | 'board';
}

export const HUNT_SCAN_DEFINITIONS: readonly HuntScanDefinition[] = [
  {
    kind: 'net-buying',
    category: 'flow',
    title: 'Net buying',
    question: 'Was this location bought or sold?',
    scope: 'asset',
  },
  {
    kind: 'purchase-concentration',
    category: 'whale-footprint',
    title: 'Concentration',
    question: 'How concentrated was the observed activity here?',
    scope: 'asset',
  },
  {
    kind: 'repeated-accumulation',
    category: 'volume',
    title: 'Repeated accumulation',
    question: 'Did activity repeat across rounds?',
    scope: 'asset',
  },
  {
    kind: 'timing',
    category: 'volatility',
    title: 'Timing',
    question: 'When did activity arrive compared with baseline?',
    scope: 'asset',
  },
  {
    kind: 'cross-asset-rhythm',
    category: 'crowd',
    title: 'Cross asset rhythm',
    question: 'Did activity move across all locations?',
    scope: 'board',
  },
  {
    kind: 'growing-position',
    category: 'absorption',
    title: 'Growing position',
    question: 'Did the observed position grow?',
    scope: 'asset',
  },
];

/** Maps a client scan id to a stable definition without encoding a target answer in the id. */
export function scanDefinitionFor(scanId: OpaqueId): HuntScanDefinition {
  const normalized = scanId.toLowerCase();
  const explicit = HUNT_SCAN_DEFINITIONS.find(({ kind }) => normalized.includes(kind));
  if (explicit) return explicit;
  const category = HUNT_SCAN_DEFINITIONS.find(({ category }) => normalized.includes(category));
  if (category) return category;
  let hash = 2_166_136_261;
  for (const character of scanId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return HUNT_SCAN_DEFINITIONS[(hash >>> 0) % HUNT_SCAN_DEFINITIONS.length]!;
}

export function roundScore(value: number): number {
  if (!Number.isFinite(value)) throw new Error('A finite score is required.');
  return Math.round(value);
}

export function targetUnitsFor(
  assetId: OpaqueId,
  targets: { primaryAssetId: OpaqueId; secondaryAssetId: OpaqueId },
): number {
  if (assetId === targets.primaryAssetId) return HUNT_RULES.primaryTargetUnits;
  if (assetId === targets.secondaryAssetId) return HUNT_RULES.secondaryTargetUnits;
  return 0;
}
