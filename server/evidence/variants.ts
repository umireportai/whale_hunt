import { createHash } from 'node:crypto';
import { EvidenceValidationError } from './normalize.js';
import type {
  CompiledHuntCase,
  VariantAssignment,
  VariantFamily,
  VariantMatchResult,
  VariantPack,
  VariantRejection,
} from './types.js';
import { VARIANT_MATCHING_VERSION } from './types.js';

export const VARIANT_MATCHING_CONFIG = Object.freeze({
  version: VARIANT_MATCHING_VERSION,
  expectedRounds: 5,
  terminalReturnTolerancePct: 1,
  volatilityTolerancePct: 1.5,
  excursionTolerancePct: 5,
  requireExactLiquidationSignature: true,
  returnBuckets: ['under-1', '1-to-3', '3-to-7', '7-to-15', 'above-15'] as const,
});

export interface VariantMatchingOptions {
  readonly expectedRounds?: number;
  readonly terminalReturnTolerancePct?: number;
  readonly volatilityTolerancePct?: number;
  readonly excursionTolerancePct?: number;
}

export interface VariantAssignmentOptions {
  readonly seed?: string;
  readonly assignedAt?: string;
  readonly practiceOnly?: boolean;
}

type CandidatePack = readonly CompiledHuntCase[];
type MatchableInput = readonly CompiledHuntCase[] | readonly CandidatePack[];

function isNested(value: MatchableInput): value is readonly CandidatePack[] {
  return value.length > 0 && Array.isArray(value[0]);
}

function assetKey(value: CompiledHuntCase): string {
  return `${value.chain.toLowerCase()}:${value.tokenAddress.toLowerCase()}`;
}

function sameArray(left: readonly boolean[], right: readonly boolean[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function close(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function comparable(
  left: CompiledHuntCase,
  right: CompiledHuntCase,
  options: Required<VariantMatchingOptions>,
): boolean {
  const a = left.matching;
  const b = right.matching;
  return (
    left.sourceKind === right.sourceKind &&
    a.terminalSign === b.terminalSign &&
    a.returnBucket === b.returnBucket &&
    a.priorPattern === b.priorPattern &&
    a.coverageProfile === b.coverageProfile &&
    close(
      a.signedTerminalReturnPct,
      b.signedTerminalReturnPct,
      options.terminalReturnTolerancePct,
    ) &&
    close(a.realizedVolatilityPct, b.realizedVolatilityPct, options.volatilityTolerancePct) &&
    close(
      a.longFavorableExcursionPct,
      b.longFavorableExcursionPct,
      options.excursionTolerancePct,
    ) &&
    close(a.longAdverseExcursionPct, b.longAdverseExcursionPct, options.excursionTolerancePct) &&
    close(
      a.shortFavorableExcursionPct,
      b.shortFavorableExcursionPct,
      options.excursionTolerancePct,
    ) &&
    close(a.shortAdverseExcursionPct, b.shortAdverseExcursionPct, options.excursionTolerancePct) &&
    sameArray(a.liquidation.long, b.liquidation.long) &&
    sameArray(a.liquidation.short, b.liquidation.short)
  );
}

function validPack(pack: CandidatePack, expectedRounds: number): VariantRejection['reason'] | null {
  if (pack.length !== expectedRounds) return 'incomplete-pack';
  const ids = new Set<string>();
  const assets = new Set<string>();
  for (const value of pack) {
    if (ids.has(value.caseId)) return 'duplicate-case';
    ids.add(value.caseId);
    const key = assetKey(value);
    if (assets.has(key)) return 'repeated-real-asset';
    assets.add(key);
  }
  const source = pack[0]!.sourceKind;
  if (pack.some((value) => value.sourceKind !== source)) return 'unsupported-source';
  return null;
}

function optionsWithDefaults(options: VariantMatchingOptions): Required<VariantMatchingOptions> {
  const result = {
    expectedRounds: options.expectedRounds ?? VARIANT_MATCHING_CONFIG.expectedRounds,
    terminalReturnTolerancePct:
      options.terminalReturnTolerancePct ?? VARIANT_MATCHING_CONFIG.terminalReturnTolerancePct,
    volatilityTolerancePct:
      options.volatilityTolerancePct ?? VARIANT_MATCHING_CONFIG.volatilityTolerancePct,
    excursionTolerancePct:
      options.excursionTolerancePct ?? VARIANT_MATCHING_CONFIG.excursionTolerancePct,
  };
  if (
    !Number.isInteger(result.expectedRounds) ||
    result.expectedRounds < 1 ||
    !Number.isFinite(result.terminalReturnTolerancePct) ||
    result.terminalReturnTolerancePct < 0 ||
    !Number.isFinite(result.volatilityTolerancePct) ||
    result.volatilityTolerancePct < 0 ||
    !Number.isFinite(result.excursionTolerancePct) ||
    result.excursionTolerancePct < 0
  )
    throw new EvidenceValidationError(
      'invalid-number',
      'Variant tolerances must be finite and non-negative.',
    );
  return result;
}

function normalizeFlat(
  cases: readonly CompiledHuntCase[],
  expectedRounds: number,
  rejected: VariantRejection[],
): CandidatePack[] {
  const byRound = new Map<number, CompiledHuntCase[]>();
  const ids = new Set<string>();
  for (const value of cases) {
    if (ids.has(value.caseId)) {
      rejected.push({ caseIds: [value.caseId], reason: 'duplicate-case' });
      continue;
    }
    ids.add(value.caseId);
    const entries = byRound.get(value.roundIndex) ?? [];
    entries.push(value);
    byRound.set(value.roundIndex, entries);
  }
  const packs: CandidatePack[] = [];
  while (true) {
    const anchor = byRound.get(1)?.[0];
    if (!anchor) break;
    const selected = [anchor];
    const selectedAssets = new Set([assetKey(anchor)]);
    let failed: VariantRejection['reason'] | null = null;
    for (let round = 2; round <= expectedRounds; round++) {
      const candidates = byRound.get(round) ?? [];
      const candidate = candidates.find(
        (item) =>
          !selectedAssets.has(assetKey(item)) && comparable(anchor, item, optionsWithDefaults({})),
      );
      if (!candidate) {
        failed = 'feature-mismatch';
        break;
      }
      selected.push(candidate);
      selectedAssets.add(assetKey(candidate));
    }
    if (failed) {
      rejected.push({ caseIds: [anchor.caseId], reason: failed });
      byRound.set(1, (byRound.get(1) ?? []).slice(1));
      continue;
    }
    const reason = validPack(selected, expectedRounds);
    if (reason) {
      rejected.push({ caseIds: selected.map((item) => item.caseId), reason });
      byRound.set(1, (byRound.get(1) ?? []).slice(1));
      continue;
    }
    packs.push(selected);
    for (const value of selected) {
      byRound.set(
        value.roundIndex,
        (byRound.get(value.roundIndex) ?? []).filter((item) => item.caseId !== value.caseId),
      );
    }
  }
  for (const [round, remaining] of byRound) {
    for (const value of remaining)
      rejected.push({
        caseIds: [value.caseId],
        reason: round > expectedRounds ? 'incomplete-pack' : 'feature-mismatch',
      });
  }
  return packs;
}

function packSignature(pack: CandidatePack): string {
  return pack.map((value) => value.caseId).join('|');
}

/** Group complete five-round packs into comparable families without relaxing any configured constraint. */
export function matchVariants(
  input: MatchableInput,
  options: VariantMatchingOptions = {},
): VariantMatchResult {
  const resolved = optionsWithDefaults(options);
  const rejected: VariantRejection[] = [];
  const candidates: CandidatePack[] = isNested(input)
    ? input.map((pack) => [...pack])
    : normalizeFlat(input, resolved.expectedRounds, rejected);
  const valid: CandidatePack[] = [];
  for (const pack of candidates) {
    const reason = validPack(pack, resolved.expectedRounds);
    if (reason) {
      rejected.push({ caseIds: pack.map((value) => value.caseId), reason });
      continue;
    }
    valid.push(pack);
  }
  const families: VariantFamily[] = [];
  for (const pack of valid) {
    const family = families.find(
      (candidate) =>
        candidate.sourceKind === pack[0]!.sourceKind &&
        candidate.packs[0]!.cases.every((baseCase, index) =>
          comparable(baseCase, pack[index]!, resolved),
        ),
    );
    const variant: VariantPack = {
      variantId: `variant-${createHash('sha256').update(packSignature(pack)).digest('hex').slice(0, 12)}`,
      cases: Object.freeze([...pack]),
      sourceKind: pack[0]!.sourceKind,
      rulesVersion: pack[0]!.rulesVersion,
      contentVersion: pack[0]!.contentVersion,
    };
    if (family) {
      (family.packs as VariantPack[]).push(variant);
    } else {
      families.push({
        familyId: `family-${families.length + 1}`,
        packs: [variant],
        sourceKind: pack[0]!.sourceKind,
        rulesVersion: pack[0]!.rulesVersion,
        configVersion: VARIANT_MATCHING_VERSION,
      });
    }
  }
  return {
    configVersion: VARIANT_MATCHING_VERSION,
    families: Object.freeze(
      families.map((family) => ({ ...family, packs: Object.freeze(family.packs) })),
    ),
    rejected: Object.freeze(rejected),
  };
}

function randomUnit(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function shuffled<T>(values: readonly T[], seed: string): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(randomUnit(`${seed}:${index}`) * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

/** Create the private, serializable assignment recorded at attempt creation. */
export function assignVariant(
  family: VariantFamily,
  attemptId: string,
  options: VariantAssignmentOptions = {},
): VariantAssignment {
  if (!attemptId.trim() || !family.packs.length)
    throw new EvidenceValidationError(
      'invalid-record',
      'A variant assignment needs an attempt and a pack.',
    );
  const seed = options.seed ?? attemptId;
  const pack = family.packs[Math.floor(randomUnit(`${seed}:pack`) * family.packs.length)]!;
  const order = shuffled(pack.cases, `${seed}:order`);
  const colorIndexes = shuffled(
    order.map((_, index) => index),
    `${seed}:color`,
  );
  const assignedAt = options.assignedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(assignedAt)))
    throw new EvidenceValidationError('invalid-timestamp', 'Assignment time must be a timestamp.');
  return Object.freeze({
    assignmentVersion: 'variant-assignment-v1' as const,
    attemptId,
    familyId: family.familyId,
    variantId: pack.variantId,
    caseIds: Object.freeze(order.map((value) => value.caseId)),
    aliases: Object.freeze(
      order.map((_, index) => `Mystery Asset ${String.fromCharCode(65 + index)}`),
    ),
    colorIndexes: Object.freeze(colorIndexes),
    assignedAt: new Date(assignedAt).toISOString(),
    comparisonScope: 'exact-variant' as const,
    practiceOnly: options.practiceOnly ?? false,
  });
}

export const createVariantAssignment = assignVariant;

/** Validate a private assignment after a process restart; it contains no public outcome fields. */
export function restoreVariantAssignment(
  value: unknown,
  family?: VariantFamily,
): VariantAssignment {
  if (!value || typeof value !== 'object')
    throw new EvidenceValidationError('invalid-record', 'Variant assignment must be an object.');
  const item = value as Partial<VariantAssignment>;
  if (
    item.assignmentVersion !== 'variant-assignment-v1' ||
    typeof item.attemptId !== 'string' ||
    typeof item.familyId !== 'string' ||
    typeof item.variantId !== 'string' ||
    !Array.isArray(item.caseIds) ||
    !Array.isArray(item.aliases) ||
    !Array.isArray(item.colorIndexes) ||
    typeof item.assignedAt !== 'string' ||
    item.comparisonScope !== 'exact-variant' ||
    typeof item.practiceOnly !== 'boolean'
  )
    throw new EvidenceValidationError('invalid-record', 'Variant assignment shape is invalid.');
  if (
    item.caseIds.length !== item.aliases.length ||
    item.caseIds.length !== item.colorIndexes.length ||
    new Set(item.caseIds).size !== item.caseIds.length ||
    new Set(item.colorIndexes).size !== item.colorIndexes.length ||
    item.caseIds.some((id) => typeof id !== 'string') ||
    item.aliases.some((alias) => typeof alias !== 'string') ||
    item.colorIndexes.some((index) => !Number.isInteger(index) || index < 0)
  )
    throw new EvidenceValidationError('invalid-record', 'Variant assignment arrays are invalid.');
  if (!Number.isFinite(Date.parse(item.assignedAt)))
    throw new EvidenceValidationError('invalid-timestamp', 'Variant assignment time is invalid.');
  if (family) {
    const pack = family.packs.find((candidate) => candidate.variantId === item.variantId);
    if (
      !pack ||
      pack.cases.length !== item.caseIds.length ||
      !item.caseIds.every((id) => pack.cases.some((value) => value.caseId === id))
    )
      throw new EvidenceValidationError(
        'invalid-record',
        'Variant assignment does not belong to its family.',
      );
  }
  return Object.freeze({
    assignmentVersion: 'variant-assignment-v1',
    attemptId: item.attemptId,
    familyId: item.familyId,
    variantId: item.variantId,
    caseIds: Object.freeze([...item.caseIds] as string[]),
    aliases: Object.freeze([...item.aliases] as string[]),
    colorIndexes: Object.freeze([...item.colorIndexes] as number[]),
    assignedAt: new Date(item.assignedAt).toISOString(),
    comparisonScope: 'exact-variant',
    practiceOnly: item.practiceOnly,
  });
}

export function serializeVariantAssignment(value: VariantAssignment): string {
  return JSON.stringify(value);
}

export function deserializeVariantAssignment(
  value: string,
  family?: VariantFamily,
): VariantAssignment {
  try {
    return restoreVariantAssignment(JSON.parse(value) as unknown, family);
  } catch (error) {
    if (error instanceof EvidenceValidationError) throw error;
    throw new EvidenceValidationError('invalid-record', 'Variant assignment JSON is invalid.');
  }
}
