import type {
  HuntMatchView,
  HuntTracerView,
  HuntWhaleView,
  WhaleAction,
} from '../../shared/hunt.js';
import type { OpaqueId } from '../../shared/game-rules.js';
import type { PublicAssetEvidence } from '../../shared/evidence.js';
import type { BotPersonality } from '../matchmaking/store.js';

export interface BotProgress {
  readonly primaryUnits: number;
  readonly secondaryUnits: number;
  readonly decoyUnits: number;
  readonly decisionIndex: number;
}

export interface SanitizedWhaleObservation {
  readonly role: 'whale';
  readonly matchId: OpaqueId;
  readonly phase: HuntWhaleView['phase'];
  readonly stateVersion: number;
  readonly roundIndex: number;
  readonly totalRounds: number;
  readonly assets: readonly PublicAssetEvidence[];
  readonly ownTargets: HuntWhaleView['ownTargets'];
  readonly unitsPurchased: number;
  readonly decoyUnits: number;
  readonly progress: BotProgress;
  readonly seed: string;
}

export interface SanitizedTracerObservation {
  readonly role: 'tracer' | 'captain';
  readonly matchId: OpaqueId;
  readonly phase: HuntTracerView['phase'];
  readonly stateVersion: number;
  readonly roundIndex: number;
  readonly totalRounds: number;
  readonly assets: readonly PublicAssetEvidence[];
  readonly sharedEvidence: HuntTracerView['sharedEvidence'];
  readonly scansRemaining: number;
  readonly availableScanIds?: readonly OpaqueId[];
  readonly pinnedEvidenceIds: readonly OpaqueId[];
  readonly ownSuspicion: HuntTracerView['ownSuspicion'];
  readonly personality: BotPersonality;
  readonly seed: string;
  readonly decisionIndex: number;
}

export type BotDecision =
  | {
      readonly kind: 'select-targets';
      readonly primaryAssetId: OpaqueId;
      readonly secondaryAssetId: OpaqueId;
    }
  | {
      readonly kind: 'submit-whale-plan';
      readonly roundIndex: number;
      readonly action: WhaleAction;
      readonly assetId?: OpaqueId;
      readonly units: number;
    }
  | {
      readonly kind: 'purchase-scan';
      readonly roundIndex: number;
      readonly scanId: OpaqueId;
      readonly assetId?: OpaqueId;
    }
  | {
      readonly kind: 'submit-suspicion';
      readonly roundIndex: number;
      readonly primaryAssetId: OpaqueId;
      readonly secondaryAssetId: OpaqueId;
    }
  | {
      readonly kind: 'finish-investigation';
      readonly roundIndex: number;
    }
  | {
      readonly kind: 'final-accusation';
      readonly primaryAssetId: OpaqueId;
      readonly secondaryAssetId: OpaqueId;
    };

export class BotPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotPolicyError';
  }
}

function hash(seed: string, salt: string): number {
  let value = 2_166_136_261;
  for (const character of `${seed}:${salt}`) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

function choose<T>(values: readonly T[], seed: string, salt: string): T {
  const value = values[hash(seed, salt) % values.length];
  if (value === undefined) throw new BotPolicyError('A bot needs at least one legal choice.');
  return value;
}

function safeAssets(view: HuntMatchView): readonly PublicAssetEvidence[] {
  return view.assets.map((asset) => ({
    assetId: asset.assetId,
    attemptAlias: asset.attemptAlias,
    colorIndex: asset.colorIndex,
    chart: asset.chart,
    clueDescriptors: asset.clueDescriptors,
    unlockedClues: asset.unlockedClues,
    coverage: asset.coverage,
    attribution: asset.attribution,
  }));
}

/** Removes private match fields before a whale policy is invoked. */
export function sanitizeWhaleObservation(
  view: HuntMatchView,
  seed: string,
  progress: BotProgress,
): SanitizedWhaleObservation {
  if (view.viewerRole !== 'whale') throw new BotPolicyError('A whale policy needs a whale view.');
  return {
    role: 'whale',
    matchId: view.matchId,
    phase: view.phase,
    stateVersion: view.stateVersion,
    roundIndex: view.roundIndex,
    totalRounds: view.totalRounds,
    assets: safeAssets(view),
    ownTargets: view.ownTargets,
    unitsPurchased: view.unitsPurchased,
    decoyUnits: view.decoyUnits,
    progress,
    seed,
  };
}

/** Removes targets, plans, and hidden events before a tracer policy is invoked. */
export function sanitizeTracerObservation(
  view: HuntMatchView,
  seed: string,
  personality: BotPersonality,
  decisionIndex: number,
): SanitizedTracerObservation {
  if (view.viewerRole !== 'tracer' && view.viewerRole !== 'captain')
    throw new BotPolicyError('A tracer policy needs a tracer view.');
  return {
    role: view.viewerRole,
    matchId: view.matchId,
    phase: view.phase,
    stateVersion: view.stateVersion,
    roundIndex: view.roundIndex,
    totalRounds: view.totalRounds,
    assets: safeAssets(view),
    sharedEvidence: view.sharedEvidence,
    scansRemaining: view.availableScanIds?.length === 0 ? 0 : view.scansRemaining,
    availableScanIds: view.availableScanIds,
    pinnedEvidenceIds: view.pinnedEvidenceIds,
    ownSuspicion: view.ownSuspicion,
    personality,
    seed,
    decisionIndex,
  };
}

/** Selects two public assets deterministically; targets are never read by this policy. */
export function chooseWhaleTargets(
  observation: SanitizedWhaleObservation,
): Extract<BotDecision, { readonly kind: 'select-targets' }> {
  if (observation.assets.length < 2)
    throw new BotPolicyError('A whale needs two public assets to select targets.');
  const firstIndex = hash(observation.seed, 'targets-primary') % observation.assets.length;
  const secondOffset =
    1 + (hash(observation.seed, 'targets-secondary') % (observation.assets.length - 1));
  const secondIndex = (firstIndex + secondOffset) % observation.assets.length;
  return {
    kind: 'select-targets',
    primaryAssetId: observation.assets[firstIndex]!.assetId,
    secondaryAssetId: observation.assets[secondIndex]!.assetId,
  };
}

/** Plans a legal budget-preserving whale action with deterministic style variation. */
export function chooseWhalePlan(
  observation: SanitizedWhaleObservation,
): Extract<BotDecision, { readonly kind: 'submit-whale-plan' }> {
  if (!observation.ownTargets)
    throw new BotPolicyError('A whale must select targets before planning.');
  const primaryRemaining = Math.max(0, 8 - observation.progress.primaryUnits);
  const secondaryRemaining = Math.max(0, 4 - observation.progress.secondaryUnits);
  const targetRemaining = primaryRemaining + secondaryRemaining;
  const roundsAfter = observation.totalRounds - observation.roundIndex;
  const canDecoy =
    observation.progress.decoyUnits < 4 &&
    observation.progress.primaryUnits +
      observation.progress.secondaryUnits +
      observation.progress.decoyUnits +
      1 +
      targetRemaining <=
      16 &&
    Math.ceil(primaryRemaining / 4) + Math.ceil(secondaryRemaining / 4) <= roundsAfter;
  if (targetRemaining === 0)
    return {
      kind: 'submit-whale-plan',
      roundIndex: observation.roundIndex,
      action: 'wait',
      units: 0,
    };
  if (canDecoy && hash(observation.seed, `decoy:${observation.roundIndex}`) % 7 === 0) {
    const decoy = choose(
      observation.assets.filter(
        (asset) =>
          asset.assetId !== observation.ownTargets!.primaryAssetId &&
          asset.assetId !== observation.ownTargets!.secondaryAssetId,
      ),
      observation.seed,
      `decoy-asset:${observation.roundIndex}`,
    );
    return {
      kind: 'submit-whale-plan',
      roundIndex: observation.roundIndex,
      action: 'decoy',
      assetId: decoy.assetId,
      units: 1,
    };
  }
  const assetId =
    primaryRemaining > 0
      ? observation.ownTargets.primaryAssetId
      : observation.ownTargets.secondaryAssetId;
  const action = choose(
    ['burst', 'drip', 'blend'] as const,
    observation.seed,
    `action:${observation.roundIndex}`,
  );
  return {
    kind: 'submit-whale-plan',
    roundIndex: observation.roundIndex,
    action,
    assetId,
    units: Math.min(4, primaryRemaining > 0 ? primaryRemaining : secondaryRemaining),
  };
}

function preferredCategories(personality: BotPersonality): readonly string[] {
  switch (personality) {
    case 'flow-analyst':
      return ['flow', 'volume', 'absorption'];
    case 'timing-analyst':
      return ['volatility', 'crowd', 'flow'];
    case 'concentration-analyst':
      return ['whale-footprint', 'absorption', 'volume'];
    case 'skeptic':
      return ['crowd', 'volatility', 'volume'];
    case 'coordinator':
      return ['flow', 'whale-footprint', 'timing', 'absorption'];
  }
}

/** Chooses an unused public clue according to the bot's crew personality. */
export function chooseTracerScan(
  observation: SanitizedTracerObservation,
): Extract<BotDecision, { readonly kind: 'purchase-scan' }> | null {
  if (observation.scansRemaining <= 0) return null;
  const used = new Set(observation.sharedEvidence.map((clue) => clue.clueId));
  const descriptors = observation.assets.flatMap((asset) =>
    asset.clueDescriptors.map((descriptor) => ({ asset, descriptor })),
  );
  const unused = descriptors.filter(({ descriptor }) =>
    observation.availableScanIds
      ? observation.availableScanIds.includes(descriptor.clueId)
      : !used.has(descriptor.clueId),
  );
  if (!unused.length) return null;
  const priorities = preferredCategories(observation.personality);
  const ranked = [...unused].sort(
    (left, right) =>
      (priorities.indexOf(left.descriptor.category) < 0
        ? 99
        : priorities.indexOf(left.descriptor.category)) -
        (priorities.indexOf(right.descriptor.category) < 0
          ? 99
          : priorities.indexOf(right.descriptor.category)) ||
      left.descriptor.clueId.localeCompare(right.descriptor.clueId),
  );
  const selected =
    ranked[
      hash(observation.seed, `scan:${observation.decisionIndex}`) % Math.min(3, ranked.length)
    ]!;
  return {
    kind: 'purchase-scan',
    roundIndex: observation.roundIndex,
    scanId: selected.descriptor.clueId,
    assetId: selected.asset.assetId,
  };
}

/** Picks a reproducible suspicion pair from visible assets and can therefore be wrong. */
export function chooseTracerSuspicion(
  observation: SanitizedTracerObservation,
): Extract<BotDecision, { readonly kind: 'submit-suspicion' }> {
  if (observation.assets.length < 2)
    throw new BotPolicyError('A tracer needs two public assets to submit a suspicion.');
  const first =
    hash(observation.seed, `suspicion-primary:${observation.roundIndex}`) %
    observation.assets.length;
  const second =
    (first +
      1 +
      (hash(observation.seed, `suspicion-secondary:${observation.roundIndex}`) %
        (observation.assets.length - 1))) %
    observation.assets.length;
  return {
    kind: 'submit-suspicion',
    roundIndex: observation.roundIndex,
    primaryAssetId: observation.assets[first]!.assetId,
    secondaryAssetId: observation.assets[second]!.assetId,
  };
}

export function chooseTracerFinalAccusation(
  observation: SanitizedTracerObservation,
): Extract<BotDecision, { readonly kind: 'final-accusation' }> {
  const suspicion = chooseTracerSuspicion(observation);
  return {
    kind: 'final-accusation',
    primaryAssetId: suspicion.primaryAssetId,
    secondaryAssetId: suspicion.secondaryAssetId,
  };
}
