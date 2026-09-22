import type {
  HuntPhase,
  HuntReveal,
  HuntParticipantView,
  ParticipantKind,
  WhaleAction,
} from '../../../shared/hunt.js';
import type {
  EvidenceCategory,
  PublicAssetEvidence,
  RevealedClue,
} from '../../../shared/evidence.js';
import type { CompiledHuntBoard } from '../../evidence/types.js';
import type { OpaqueId } from '../../../shared/game-rules.js';

export interface HuntTargetPair {
  readonly primaryAssetId: OpaqueId;
  readonly secondaryAssetId: OpaqueId;
}

export interface HuntPlanRecord {
  readonly roundIndex: number;
  readonly action: WhaleAction;
  readonly assetId: OpaqueId | null;
  readonly units: number;
}

export interface HuntMarketEvent {
  readonly eventId: string;
  readonly roundIndex: number;
  readonly assetId: OpaqueId;
  readonly at: string;
  readonly side: 'buy' | 'sell';
  readonly units: number;
  readonly valueUsd: number;
  readonly source: 'historical' | 'simulated';
  readonly action?: WhaleAction;
}

export interface HuntPurchaseRecord extends HuntMarketEvent {
  readonly source: 'simulated';
  readonly action: WhaleAction;
}

export interface HuntEventRecord {
  readonly board: CompiledHuntBoard;
  readonly historical: readonly HuntMarketEvent[];
  readonly simulated: readonly HuntPurchaseRecord[];
  readonly events: readonly HuntMarketEvent[];
}

export interface HuntScanRecord {
  readonly scanId: OpaqueId;
  readonly roundIndex: number;
  readonly actorId: OpaqueId;
  readonly clue: RevealedClue;
}

export interface HuntSuspicionRecord extends HuntTargetPair {
  readonly roundIndex: number;
  readonly actorId: OpaqueId;
}

export interface HuntMatchScores {
  readonly tracerFinal: number;
  readonly tracerEarly: number;
  readonly tracerScore: number;
  readonly whaleCompletion: number;
  readonly whaleEscape: number;
  readonly whaleScore: number;
  readonly correctFinalTargets: number;
  readonly correctEarlyMentions: number;
  readonly primaryUnits: number;
  readonly secondaryUnits: number;
  readonly objectiveComplete: boolean;
  readonly finalPairCorrect: boolean;
  readonly winner: 'whale' | 'tracers' | 'voided';
  readonly reason:
    'targets-identified' | 'objective-complete' | 'objective-incomplete' | 'technical-failure';
}

export interface HuntFinalResolution {
  readonly reveal: HuntReveal;
  readonly scores: HuntMatchScores;
}

export interface HuntReconstruction {
  readonly matchId: OpaqueId;
  readonly roomCode: string;
  readonly phase: HuntPhase;
  readonly board: CompiledHuntBoard;
  readonly targets: HuntTargetPair | null;
  readonly plans: readonly HuntPlanRecord[];
  readonly eventRecord: HuntEventRecord;
  readonly scans: readonly HuntScanRecord[];
  readonly suspicions: readonly HuntSuspicionRecord[];
  readonly finalAccusation: HuntTargetPair | null;
  readonly reveal: HuntReveal | null;
  readonly scores: HuntMatchScores | null;
  readonly events: readonly HuntPersistedEvent[];
}

export interface HuntPersistedEvent {
  readonly eventIndex: number;
  readonly roundIndex: number;
  readonly kind: string;
  readonly visibility: 'shared' | 'private-whale' | 'private-tracer' | 'system';
  readonly actorId: OpaqueId | null;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface HuntParticipantRecord {
  readonly participantId: OpaqueId;
  readonly displayName: string;
  readonly role: 'whale' | 'tracer';
  readonly kind: ParticipantKind;
  readonly connection: HuntParticipantView['connection'];
  readonly isCaptain: boolean;
  readonly reconnectUntil: string;
}

export interface HuntStateSnapshot {
  readonly matchId: OpaqueId;
  readonly roomId: OpaqueId;
  readonly roomCode: string;
  readonly maxTracers: 1 | 5;
  readonly phase: HuntPhase;
  readonly roundIndex: number;
  readonly stateVersion: number;
  readonly deadlineAt: string;
  readonly reconnectUntil: string;
  readonly board: CompiledHuntBoard;
  readonly targets: HuntTargetPair | null;
  readonly plans: readonly HuntPlanRecord[];
  readonly eventRecord: HuntEventRecord;
  readonly scans: readonly HuntScanRecord[];
  readonly pinnedEvidence: Readonly<Record<OpaqueId, readonly OpaqueId[]>>;
  readonly suspicions: readonly HuntSuspicionRecord[];
  readonly finalAccusation: HuntTargetPair | null;
  readonly reveal: HuntReveal | null;
  readonly scores: HuntMatchScores | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export function publicAssets(board: CompiledHuntBoard): readonly PublicAssetEvidence[] {
  return board.publicAssets;
}

export function evidenceCategoryForScan(category: EvidenceCategory): EvidenceCategory {
  return category;
}
