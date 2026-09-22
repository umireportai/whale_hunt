import type {
  FinalAccusationCommand,
  SubmitSuspicionCommand,
  SubmitWhalePlanCommand,
} from '../../../shared/hunt.js';
import { HUNT_RULES, type OpaqueId } from '../../../shared/game-rules.js';
import { roundScore } from './rules.js';
import type {
  HuntFinalResolution,
  HuntMatchScores,
  HuntPlanRecord,
  HuntPurchaseRecord,
  HuntSuspicionRecord,
  HuntTargetPair,
} from './types.js';

export type HuntRuleErrorCode = 'INVALID_TARGETS' | 'INVALID_PLAN' | 'INVALID_COMMAND';

export class HuntRuleError extends Error {
  constructor(
    readonly code: HuntRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HuntRuleError';
  }
}

export interface WhalePlanValidationInput {
  readonly command: SubmitWhalePlanCommand;
  readonly targets: HuntTargetPair;
  readonly assets: readonly OpaqueId[];
  readonly priorPlans: readonly HuntPlanRecord[];
  readonly totalRounds?: number;
}

export interface ValidatedWhalePlan {
  readonly roundIndex: number;
  readonly action: SubmitWhalePlanCommand['action'];
  readonly assetId: OpaqueId | null;
  readonly units: number;
}

function targetPurchased(purchases: readonly HuntPlanRecord[], assetId: OpaqueId): number {
  return purchases
    .filter((plan) => plan.assetId === assetId)
    .reduce((sum, plan) => sum + plan.units, 0);
}

function decoyPurchased(
  purchases: readonly HuntPlanRecord[],
  targetIds: ReadonlySet<OpaqueId>,
): number {
  return purchases
    .filter((plan) => plan.assetId !== null && !targetIds.has(plan.assetId))
    .reduce((sum, plan) => sum + plan.units, 0);
}

/** Validates whale budgets and checks that the remaining objective still fits future rounds. */
export function validateWhalePlan(input: WhalePlanValidationInput): ValidatedWhalePlan {
  const { command, targets } = input;
  const totalRounds = input.totalRounds ?? HUNT_RULES.totalRounds;
  if (
    !Number.isInteger(command.roundIndex) ||
    command.roundIndex < 1 ||
    command.roundIndex > totalRounds
  )
    throw new HuntRuleError('INVALID_PLAN', 'The whale plan must belong to the current round.');
  if (
    !Number.isInteger(command.units) ||
    command.units < 0 ||
    command.units > HUNT_RULES.maxPurchaseUnitsPerRound
  )
    throw new HuntRuleError(
      'INVALID_PLAN',
      'A whale plan may purchase zero to four units in one round.',
    );
  if (input.priorPlans.some((plan) => plan.roundIndex === command.roundIndex))
    throw new HuntRuleError('INVALID_PLAN', 'This round already has a whale plan.');
  const targetIds = new Set([targets.primaryAssetId, targets.secondaryAssetId]);
  if (targets.primaryAssetId === targets.secondaryAssetId)
    throw new HuntRuleError('INVALID_TARGETS', 'Whale targets must be distinct.');
  if (
    !input.assets.includes(targets.primaryAssetId) ||
    !input.assets.includes(targets.secondaryAssetId)
  )
    throw new HuntRuleError('INVALID_TARGETS', 'Whale targets must use assets on this Hunt board.');

  const action = command.action;
  const assetId = command.assetId ?? null;
  if (action === 'wait') {
    if (command.units !== 0 || assetId !== null)
      throw new HuntRuleError('INVALID_PLAN', 'Wait buys no units and does not name an asset.');
  } else {
    if (!assetId || !input.assets.includes(assetId))
      throw new HuntRuleError('INVALID_PLAN', 'Choose an asset on this Hunt board.');
    if (command.units < 1)
      throw new HuntRuleError('INVALID_PLAN', 'A purchase action needs at least one unit.');
    if (action === 'decoy') {
      if (targetIds.has(assetId))
        throw new HuntRuleError('INVALID_PLAN', 'A decoy must use a non-target asset.');
    } else if (!targetIds.has(assetId)) {
      throw new HuntRuleError('INVALID_PLAN', 'Only Decoy may purchase a non-target asset.');
    }
  }

  const plans = [
    ...input.priorPlans,
    { roundIndex: command.roundIndex, action, assetId, units: command.units },
  ];
  const totalUnits = plans.reduce((sum, plan) => sum + plan.units, 0);
  if (totalUnits > HUNT_RULES.maxPurchaseUnitsPerMatch)
    throw new HuntRuleError('INVALID_PLAN', 'The match purchase budget is sixteen units.');
  const decoyUnits = decoyPurchased(plans, targetIds);
  if (decoyUnits > HUNT_RULES.maxDecoyUnitsPerMatch)
    throw new HuntRuleError('INVALID_PLAN', 'The match allows four decoy units in total.');
  for (const asset of input.assets) {
    const units = plans
      .filter((plan) => plan.assetId === asset && !targetIds.has(asset))
      .reduce((sum, plan) => sum + plan.units, 0);
    if (units > HUNT_RULES.maxDecoyUnitsPerAsset)
      throw new HuntRuleError('INVALID_PLAN', 'A non-target asset allows at most two decoy units.');
  }

  const primaryRemaining = Math.max(
    0,
    HUNT_RULES.primaryTargetUnits - targetPurchased(plans, targets.primaryAssetId),
  );
  const secondaryRemaining = Math.max(
    0,
    HUNT_RULES.secondaryTargetUnits - targetPurchased(plans, targets.secondaryAssetId),
  );
  if (totalUnits + primaryRemaining + secondaryRemaining > HUNT_RULES.maxPurchaseUnitsPerMatch)
    throw new HuntRuleError(
      'INVALID_PLAN',
      'This plan leaves insufficient match budget to complete both targets.',
    );
  const roundsAfter = totalRounds - command.roundIndex;
  const roundsNeeded =
    Math.ceil(primaryRemaining / HUNT_RULES.maxPurchaseUnitsPerRound) +
    Math.ceil(secondaryRemaining / HUNT_RULES.maxPurchaseUnitsPerRound);
  if (roundsNeeded > roundsAfter)
    throw new HuntRuleError(
      'INVALID_PLAN',
      'This plan leaves too few future rounds to complete both targets.',
    );

  return { roundIndex: command.roundIndex, action, assetId, units: command.units };
}

function pairSet(pair: HuntTargetPair): Set<OpaqueId> {
  return new Set([pair.primaryAssetId, pair.secondaryAssetId]);
}

function pairMatches(left: HuntTargetPair, right: HuntTargetPair): boolean {
  const expected = pairSet(left);
  const actual = pairSet(right);
  return expected.size === actual.size && [...expected].every((assetId) => actual.has(assetId));
}

function correctMentions(pair: HuntTargetPair, value: HuntTargetPair): number {
  const targets = pairSet(pair);
  return Number(targets.has(value.primaryAssetId)) + Number(targets.has(value.secondaryAssetId));
}

function objectiveUnits(
  purchases: readonly HuntPurchaseRecord[],
  targets: HuntTargetPair,
): { primary: number; secondary: number } {
  return {
    primary: purchases
      .filter((purchase) => purchase.assetId === targets.primaryAssetId)
      .reduce((sum, purchase) => sum + purchase.units, 0),
    secondary: purchases
      .filter((purchase) => purchase.assetId === targets.secondaryAssetId)
      .reduce((sum, purchase) => sum + purchase.units, 0),
  };
}

/** Calculates the Hunt result and scores only after the final accusation is locked. */
export function scoreMatch(input: {
  readonly targets: HuntTargetPair;
  readonly purchases: readonly HuntPurchaseRecord[];
  readonly suspicions: readonly HuntSuspicionRecord[];
  readonly accusation: HuntTargetPair;
  /** Crew scoring uses the captain's record; each other suspicion remains persisted separately. */
  readonly earlySuspicionActorId?: OpaqueId;
  readonly technicalFailure?: boolean;
}): HuntMatchScores {
  const units = objectiveUnits(input.purchases, input.targets);
  const objectiveComplete =
    units.primary >= HUNT_RULES.primaryTargetUnits &&
    units.secondary >= HUNT_RULES.secondaryTargetUnits;
  const finalPairCorrect = pairMatches(input.targets, input.accusation);
  const correctFinalTargets = correctMentions(input.targets, input.accusation);
  const scoringSuspicions = input.earlySuspicionActorId
    ? input.suspicions.filter((suspicion) => suspicion.actorId === input.earlySuspicionActorId)
    : input.suspicions;
  const correctEarlyMentions = scoringSuspicions.reduce(
    (sum, suspicion) => sum + correctMentions(input.targets, suspicion),
    0,
  );
  if (input.technicalFailure) {
    return {
      tracerFinal: 0,
      tracerEarly: 0,
      tracerScore: 0,
      whaleCompletion: 0,
      whaleEscape: 0,
      whaleScore: 0,
      correctFinalTargets: 0,
      correctEarlyMentions: 0,
      primaryUnits: units.primary,
      secondaryUnits: units.secondary,
      objectiveComplete,
      finalPairCorrect: false,
      winner: 'voided',
      reason: 'technical-failure',
    };
  }
  const tracerFinal = 300 * correctFinalTargets;
  const tracerEarly = roundScore((400 * correctEarlyMentions) / 10);
  const whaleCompletion =
    roundScore(200 * Math.min(units.primary / HUNT_RULES.primaryTargetUnits, 1)) +
    roundScore(200 * Math.min(units.secondary / HUNT_RULES.secondaryTargetUnits, 1));
  const whaleEscape = objectiveComplete && !finalPairCorrect ? 600 : 0;
  const winner = objectiveComplete && !finalPairCorrect ? 'whale' : 'tracers';
  const reason = !objectiveComplete
    ? 'objective-incomplete'
    : finalPairCorrect
      ? 'targets-identified'
      : 'objective-complete';
  return {
    tracerFinal,
    tracerEarly,
    tracerScore: tracerFinal + tracerEarly,
    whaleCompletion,
    whaleEscape,
    whaleScore: whaleCompletion + whaleEscape,
    correctFinalTargets,
    correctEarlyMentions,
    primaryUnits: units.primary,
    secondaryUnits: units.secondary,
    objectiveComplete,
    finalPairCorrect,
    winner,
    reason,
  };
}

/** Resolves target completion and the final pair into the public reveal plus private scores. */
export function resolveFinal(input: {
  readonly targets: HuntTargetPair;
  readonly accusation: FinalAccusationCommand | HuntTargetPair;
  readonly purchases: readonly HuntPurchaseRecord[];
  readonly suspicions?: readonly HuntSuspicionRecord[];
  readonly earlySuspicionActorId?: OpaqueId;
  readonly technicalFailure?: boolean;
}): HuntFinalResolution {
  const accusation: HuntTargetPair = {
    primaryAssetId: input.accusation.primaryAssetId,
    secondaryAssetId: input.accusation.secondaryAssetId,
  };
  if (accusation.primaryAssetId === accusation.secondaryAssetId)
    throw new HuntRuleError('INVALID_COMMAND', 'The final pair must contain two distinct assets.');
  const scores = scoreMatch({
    targets: input.targets,
    purchases: input.purchases,
    suspicions: input.suspicions ?? [],
    accusation,
    earlySuspicionActorId: input.earlySuspicionActorId,
    technicalFailure: input.technicalFailure,
  });
  return {
    reveal: {
      primaryAssetId: input.targets.primaryAssetId,
      secondaryAssetId: input.targets.secondaryAssetId,
      accusation,
      winner: scores.winner,
      reason: scores.reason,
    },
    scores,
  };
}

/** Validates a pair command without returning any correctness feedback to the tracer. */
export function validateSuspicion(
  command: SubmitSuspicionCommand,
  assets: readonly OpaqueId[],
): HuntTargetPair {
  if (command.primaryAssetId === command.secondaryAssetId)
    throw new HuntRuleError('INVALID_COMMAND', 'A suspicion must contain two distinct assets.');
  if (!assets.includes(command.primaryAssetId) || !assets.includes(command.secondaryAssetId))
    throw new HuntRuleError('INVALID_COMMAND', 'A suspicion must use assets on this Hunt board.');
  return { primaryAssetId: command.primaryAssetId, secondaryAssetId: command.secondaryAssetId };
}
