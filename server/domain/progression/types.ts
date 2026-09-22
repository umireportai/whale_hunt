import type { HuntFinalResolution, HuntMatchScores } from '../hunt/types.js';
import type { HuntReveal } from '../../../shared/hunt.js';
import type { ProgressionView, ShareResult } from '../../../shared/progression.js';

export type ProgressionHuntRole = 'whale' | 'tracer' | 'captain';
export type ProgressionMatchKind = 'human' | 'computer' | 'substituted';

export interface HuntProgressionInput {
  readonly playerId: string;
  readonly matchId: string;
  readonly completedAt: string;
  readonly role: ProgressionHuntRole;
  readonly matchKind: ProgressionMatchKind;
  readonly maxTracers: 1 | 5;
  readonly resolution?: HuntFinalResolution;
  readonly reveal?: HuntReveal;
  readonly scores?: HuntMatchScores;
  readonly won?: boolean;
  readonly finalPairCorrect?: boolean;
  readonly correctPairBeforeFinal?: boolean;
  readonly finalIncludesDecoy?: boolean;
  readonly rulesVersion?: 'hunt-v1';
  readonly finalized?: true;
}

export interface ProgressionShareInput {
  readonly ownerPlayerId: string;
  readonly result: ShareResult;
  readonly targetMatchId?: string;
  readonly roleSwap?: boolean;
  readonly practiceOnly?: boolean;
}

export interface ProgressionLink {
  readonly shareId: string;
  readonly activity: 'hunt';
  readonly roleSwap: boolean;
  readonly practiceOnly: boolean;
  readonly href: string;
}

export interface ProgressionServiceOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface ProgressionSnapshot extends ProgressionView {}

export interface PublicShareRecord {
  readonly result: ShareResult;
  readonly roleSwap: boolean;
  readonly practiceOnly: boolean;
}
