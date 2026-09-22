import type { ProgressionBadge } from '../../../shared/progression.js';
import type { ProgressionHuntRole } from './types.js';

export const PROGRESSION_BADGES = {
  firstContact: 'first-contact',
  patternReader: 'pattern-reader',
  quietCurrent: 'quiet-current',
  falseWake: 'false-wake',
  bothSides: 'both-sides',
  tracerTen: 'tracer-ten',
  tracerHundred: 'tracer-hundred',
  whaleTen: 'whale-ten',
  whaleHundred: 'whale-hundred',
} as const;

export type ProgressionBadgeId = (typeof PROGRESSION_BADGES)[keyof typeof PROGRESSION_BADGES];

export const BADGE_DEFINITIONS: readonly Omit<ProgressionBadge, 'earnedAt'>[] = [
  {
    badgeId: PROGRESSION_BADGES.firstContact,
    title: 'First Contact',
    description: 'Identify both Hunt targets.',
  },
  {
    badgeId: PROGRESSION_BADGES.patternReader,
    title: 'Pattern Reader',
    description: 'Find the Hunt pair before the final round in three matches.',
  },
  {
    badgeId: PROGRESSION_BADGES.quietCurrent,
    title: 'Quiet Current',
    description: 'Complete a whale objective and evade capture.',
  },
  {
    badgeId: PROGRESSION_BADGES.falseWake,
    title: 'False Wake',
    description: 'Win as whale while the final accusation includes a decoy.',
  },
  {
    badgeId: PROGRESSION_BADGES.bothSides,
    title: 'Both Sides',
    description: 'Win at least once as whale and once as tracer.',
  },
  {
    badgeId: PROGRESSION_BADGES.tracerTen,
    title: 'Harpoon Crew',
    description: 'Catch ten whales as the tracer.',
  },
  {
    badgeId: PROGRESSION_BADGES.tracerHundred,
    title: 'Apex Tracker',
    description: 'Catch one hundred whales as the tracer.',
  },
  {
    badgeId: PROGRESSION_BADGES.whaleTen,
    title: 'Deepwater Ghost',
    description: 'Escape ten times as the whale.',
  },
  {
    badgeId: PROGRESSION_BADGES.whaleHundred,
    title: 'Untouchable',
    description: 'Escape one hundred times as the whale.',
  },
];

export function badgeDefinition(id: string): Omit<ProgressionBadge, 'earnedAt'> | undefined {
  return BADGE_DEFINITIONS.find((badge) => badge.badgeId === id);
}

export function huntBadgeIds(input: {
  readonly role: ProgressionHuntRole;
  readonly won: boolean;
  readonly finalPairCorrect: boolean;
  readonly finalIncludesDecoy: boolean;
}): readonly ProgressionBadgeId[] {
  const badges: ProgressionBadgeId[] = [];
  const tracerRole = input.role === 'tracer' || input.role === 'captain';
  if (tracerRole && input.finalPairCorrect) badges.push(PROGRESSION_BADGES.firstContact);
  if (input.role === 'whale' && input.won) {
    badges.push(PROGRESSION_BADGES.quietCurrent);
    if (input.finalIncludesDecoy) badges.push(PROGRESSION_BADGES.falseWake);
  }
  return badges;
}
