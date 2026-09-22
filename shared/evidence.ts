import type { OpaqueId, Price } from './game-rules.js';

export type SourceKind =
  'synthetic' | 'historical-reconstructed' | 'historical-snapshot' | 'live-provider';

export type EvidenceCategory =
  'flow' | 'crowd' | 'whale-footprint' | 'volume' | 'volatility' | 'absorption';

export interface EvidenceWindow {
  readonly startAt: string;
  readonly endAt: string;
  readonly label?: string;
}

export interface EvidenceMetric {
  readonly label: string;
  readonly value: string;
  /** Optional machine-readable value for v2 readers; v1 rendering uses `value`. */
  readonly numericValue?: number;
  readonly unit?: 'usd' | 'percent' | 'count' | 'ratio' | 'price' | 'units' | 'text';
  readonly window?: EvidenceWindow;
  readonly baseline?: {
    readonly label: string;
    readonly value: string;
    readonly numericValue?: number;
  };
}

export type EvidenceScope =
  | { readonly kind: 'asset'; readonly assetId: OpaqueId; readonly label?: string }
  | { readonly kind: 'board'; readonly label: string };

export interface EvidenceCoverage {
  readonly status: 'complete' | 'partial';
  readonly description: string;
  readonly observedAt: string;
}

export interface EvidenceAttribution {
  readonly label: string;
  readonly sourceKind: SourceKind;
  readonly url?: string;
}

export interface PreDecisionChartPoint {
  readonly at: string;
  readonly value: Price;
  readonly volume?: string;
}

/** Deliberately contains no answer, direction, sentiment, or hidden metadata. */
export interface UnopenedClueDescriptor {
  readonly clueId: OpaqueId;
  readonly category: EvidenceCategory;
  readonly title: string;
  readonly question: string;
}

export interface RevealedClue {
  readonly clueId: OpaqueId;
  readonly category: EvidenceCategory;
  readonly title: string;
  readonly factualHeadline: string;
  readonly metrics: readonly [EvidenceMetric] | readonly [EvidenceMetric, EvidenceMetric];
  readonly interpretation: string;
  readonly limitation?: string;
  readonly conflict?: string;
  readonly evidenceCutoff: string;
  /** Explicit scope prevents clients from guessing an asset from display text. */
  readonly scope?: EvidenceScope;
  readonly roundIndex?: number;
  readonly window?: EvidenceWindow;
  readonly sourceKind: SourceKind;
  readonly coverage: EvidenceCoverage;
  readonly attribution: readonly EvidenceAttribution[];
}

export interface PublicAssetEvidence {
  /** This identifier is stable only within the attempt and carries no provider identity. */
  readonly assetId: OpaqueId;
  /** This alias is assigned for the attempt and is independent of outcome. */
  readonly attemptAlias: string;
  /** Stable visual index assigned independently of outcome. */
  readonly colorIndex: number;
  readonly chart: readonly PreDecisionChartPoint[];
  readonly currentPrice?: Price;
  readonly changePct?: string;
  readonly volumeUsd?: string;
  readonly liquidityUsd?: string;
  readonly clueDescriptors: readonly UnopenedClueDescriptor[];
  readonly unlockedClues: readonly RevealedClue[];
  readonly coverage: EvidenceCoverage;
  readonly attribution: readonly EvidenceAttribution[];
}

export interface EvidenceAvailability {
  readonly status: 'available' | 'unavailable';
  readonly sourceKind: SourceKind;
  readonly coverage?: EvidenceCoverage;
  readonly reasonCode?: 'provider-outage' | 'incomplete-window' | 'unsupported-measurement';
  readonly message?: string;
}

export const EVIDENCE_CATEGORIES: readonly EvidenceCategory[] = [
  'flow',
  'crowd',
  'whale-footprint',
  'volume',
  'volatility',
  'absorption',
];

export function isPreDecisionPoint(point: PreDecisionChartPoint, cutoff: string): boolean {
  const pointAt = Date.parse(point.at);
  const cutoffAt = Date.parse(cutoff);
  return Number.isFinite(pointAt) && Number.isFinite(cutoffAt) && pointAt < cutoffAt;
}

export function isRevealedClue(
  value: UnopenedClueDescriptor | RevealedClue,
): value is RevealedClue {
  return 'factualHeadline' in value;
}
