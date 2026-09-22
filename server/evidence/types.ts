import type {
  EvidenceAttribution,
  EvidenceCategory,
  EvidenceCoverage,
  PublicAssetEvidence,
  SourceKind,
} from '../../shared/evidence.js';

export const EVIDENCE_CONTENT_VERSION = 'whale-hunt-evidence-v1' as const;
export const EVIDENCE_RULES_VERSION = 'whale-hunt-evidence-v1' as const;
export const VARIANT_MATCHING_VERSION = 'variant-matching-v1' as const;

export const LIQUIDATION_PRESETS = [1, 5, 10, 25, 50, 100] as const;
export type LiquidationPreset = (typeof LIQUIDATION_PRESETS)[number];

export interface NormalizedCandle {
  readonly at: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | null;
  readonly closed: boolean;
}

export interface NormalizedTrade {
  readonly at: string;
  readonly side: 'buy' | 'sell';
  readonly price: number;
  readonly amount: number | null;
  readonly valueUsd: number | null;
  readonly wallet: string | null;
  readonly sourceId: string | null;
}

export interface NormalizedSnapshot {
  readonly at: string;
  readonly capturedAt: string;
  readonly values: Readonly<Record<string, number | string | boolean | null>>;
}

export interface CoverageRecord extends EvidenceCoverage {
  readonly startAt: string;
  readonly cutoffAt: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly missingAssets: readonly string[];
  readonly missingMeasurements: readonly string[];
  readonly expectedCandleIntervalMinutes: number | null;
}

export interface EvidenceRecordInput {
  readonly caseId: string;
  readonly roundIndex: number;
  readonly sourceKind: SourceKind;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly symbol?: string | null;
  readonly name?: string | null;
  readonly evidenceStartAt: string;
  readonly cutoffAt: string;
  readonly entryAt: string;
  readonly exitAt: string;
  readonly entryPrice?: number;
  readonly exitPrice?: number;
  readonly collectionAt: string;
  readonly preDecisionCandles: readonly NormalizedCandle[];
  readonly outcomeCandles: readonly NormalizedCandle[];
  readonly trades: readonly NormalizedTrade[];
  readonly snapshots: readonly NormalizedSnapshot[];
  readonly coverage: CoverageRecord;
  readonly attribution: readonly EvidenceAttribution[];
  readonly rulesVersion?: string;
  readonly contentVersion?: string;
}

export interface DerivedClue {
  readonly category: EvidenceCategory;
  readonly factualHeadline: string;
  readonly metrics:
    | readonly [{ readonly label: string; readonly value: string }]
    | readonly [
        { readonly label: string; readonly value: string },
        { readonly label: string; readonly value: string },
      ];
  readonly interpretation: string;
  readonly limitation?: string;
  readonly conflict?: string;
  readonly evidenceCutoff: string;
  readonly sourceKind: SourceKind;
  readonly coverage: CoverageRecord;
  readonly attribution: readonly EvidenceAttribution[];
}

export type DerivedClues = Readonly<Record<EvidenceCategory, DerivedClue>>;

export type ReturnBucket = 'under-1' | '1-to-3' | '3-to-7' | '7-to-15' | 'above-15';
export type PriorPattern = 'down' | 'flat' | 'up';

export interface LiquidationSignature {
  readonly long: readonly boolean[];
  readonly short: readonly boolean[];
}

export interface MatchingFeatures {
  readonly signedTerminalReturnPct: number;
  readonly terminalSign: 'negative' | 'neutral' | 'positive';
  readonly returnBucket: ReturnBucket;
  readonly priorPattern: PriorPattern;
  readonly realizedVolatilityPct: number;
  readonly favorableExcursionPct: number;
  readonly adverseExcursionPct: number;
  readonly longFavorableExcursionPct: number;
  readonly longAdverseExcursionPct: number;
  readonly shortFavorableExcursionPct: number;
  readonly shortAdverseExcursionPct: number;
  readonly liquidation: LiquidationSignature;
  readonly coverageProfile: string;
  readonly clueCategories: readonly EvidenceCategory[];
}

export interface CompiledHuntCase {
  readonly kind: 'hunt-case';
  readonly caseId: string;
  readonly roundIndex: number;
  readonly sourceKind: SourceKind;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly evidenceStartAt: string;
  readonly cutoffAt: string;
  readonly entryAt: string;
  readonly exitAt: string;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly collectionAt: string;
  readonly preDecisionCandles: readonly NormalizedCandle[];
  readonly outcomeCandles: readonly NormalizedCandle[];
  readonly trades: readonly NormalizedTrade[];
  readonly snapshots: readonly NormalizedSnapshot[];
  readonly coverage: CoverageRecord;
  readonly attribution: readonly EvidenceAttribution[];
  readonly clues: DerivedClues;
  readonly matching: MatchingFeatures;
  readonly rulesVersion: string;
  readonly contentVersion: string;
  readonly publicEvidence: PublicAssetEvidence;
}

export interface CompiledHuntBoard {
  readonly kind: 'hunt-board';
  readonly boardId: string;
  readonly sourceKind: SourceKind;
  readonly cutoffAt: string;
  readonly assets: readonly CompiledHuntCase[];
  readonly publicAssets: readonly PublicAssetEvidence[];
  readonly rulesVersion: string;
  readonly contentVersion: string;
}

export interface VariantPack {
  readonly variantId: string;
  readonly cases: readonly CompiledHuntCase[];
  readonly sourceKind: SourceKind;
  readonly rulesVersion: string;
  readonly contentVersion: string;
}

export interface VariantFamily {
  readonly familyId: string;
  readonly packs: readonly VariantPack[];
  readonly sourceKind: SourceKind;
  readonly rulesVersion: string;
  readonly configVersion: string;
}

export interface VariantRejection {
  readonly caseIds: readonly string[];
  readonly reason:
    | 'incomplete-pack'
    | 'repeated-real-asset'
    | 'feature-mismatch'
    | 'unsupported-source'
    | 'duplicate-case';
}

export interface VariantMatchResult {
  readonly configVersion: string;
  readonly families: readonly VariantFamily[];
  readonly rejected: readonly VariantRejection[];
}

export interface VariantAssignment {
  readonly assignmentVersion: 'variant-assignment-v1';
  readonly attemptId: string;
  readonly familyId: string;
  readonly variantId: string;
  readonly caseIds: readonly string[];
  readonly aliases: readonly string[];
  readonly colorIndexes: readonly number[];
  readonly assignedAt: string;
  readonly comparisonScope: 'exact-variant';
  readonly practiceOnly: boolean;
}

export interface CollectedGameEvidence {
  readonly collectionId: string;
  readonly collectedAt: string;
  readonly sourceKind: SourceKind;
  readonly evidenceStartAt: string;
  readonly cutoffAt: string;
  readonly entryAt: string;
  readonly exitAt: string;
  readonly assets: readonly EvidenceRecordInput[];
}
