import type { EvidenceAvailability, PublicAssetEvidence, RevealedClue } from './evidence.js';
import type { CommandMeta, HuntRules, IdempotencyKey, OpaqueId } from './game-rules.js';

export type HuntRole = 'whale' | 'tracer' | 'captain';
export type ParticipantKind = 'human' | 'computer';
export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected' | 'substituted';

export type HuntPhase =
  | 'lobby'
  | 'setup'
  | 'whale-planning'
  | 'tracer-investigation'
  | 'round-complete'
  | 'final-accusation'
  | 'reveal'
  | 'finished'
  | 'voided';

interface HuntParticipantBase {
  readonly participantId: OpaqueId;
  readonly displayName: string;
  readonly role: 'whale' | 'tracer';
  readonly connection: ConnectionState;
  readonly isCaptain: boolean;
}

export type HuntParticipantView =
  | (HuntParticipantBase & { readonly kind: 'human'; readonly computerLabel?: never })
  | (HuntParticipantBase & { readonly kind: 'computer'; readonly computerLabel: 'Computer' });

export interface HuntDeadline {
  readonly phase: HuntPhase;
  readonly at: string;
}

export interface HuntReconnectState {
  readonly reconnectUntil: string;
  readonly canReconnect: boolean;
  readonly substitution: 'none' | 'eligible' | 'active';
}

export interface HuntCaptainState {
  readonly participantId: OpaqueId | null;
  readonly transfer: 'stable' | 'pending' | 'transferred';
  readonly canSubmitFinalAccusation: boolean;
}

export interface HuntRoomView {
  readonly matchId?: OpaqueId;
  readonly roomCode: string;
  readonly roomId: OpaqueId;
  readonly phase: 'lobby' | 'setup';
  readonly participants: readonly HuntParticipantView[];
  readonly maxTracers: 1 | 5;
  readonly deadline: HuntDeadline | null;
}

export interface HuntCommonView {
  readonly matchId: OpaqueId;
  readonly roomCode: string;
  readonly phase: HuntPhase;
  readonly stateVersion: number;
  readonly roundIndex: number;
  readonly totalRounds: HuntRules['totalRounds'];
  readonly assets: readonly PublicAssetEvidence[];
  readonly participants: readonly HuntParticipantView[];
  readonly captain: HuntCaptainState;
  readonly deadline: HuntDeadline | null;
  /** Server clock sample used to render a refresh safe countdown. */
  readonly serverNow?: string;
  readonly reconnect: HuntReconnectState;
  readonly evidence: EvidenceAvailability;
}

/** The tracer view has no target IDs, whale plans, or correctness feedback. */
export interface HuntTracerView extends HuntCommonView {
  readonly viewerRole: 'tracer' | 'captain';
  readonly scansRemaining: number;
  readonly availableScanIds?: readonly OpaqueId[];
  readonly sharedEvidence: readonly RevealedClue[];
  readonly pinnedEvidenceIds: readonly OpaqueId[];
  readonly ownSuspicion: {
    readonly primaryAssetId: OpaqueId;
    readonly secondaryAssetId: OpaqueId;
  } | null;
}

/** Only the whale's own role-filtered view can contain its selected targets. */
export interface HuntWhaleView extends HuntCommonView {
  readonly viewerRole: 'whale';
  readonly ownTargets: {
    readonly primaryAssetId: OpaqueId;
    readonly secondaryAssetId: OpaqueId;
  } | null;
  readonly unitsPurchased: number;
  readonly decoyUnits: number;
  readonly targetUnits?: { readonly primary: number; readonly secondary: number };
}

export type HuntMatchView = HuntTracerView | HuntWhaleView;

export interface SelectHuntTargetsCommand extends CommandMeta {
  readonly kind: 'select-targets';
  readonly primaryAssetId: OpaqueId;
  readonly secondaryAssetId: OpaqueId;
}

export type WhaleAction = 'burst' | 'drip' | 'blend' | 'decoy' | 'wait';

export interface SubmitWhalePlanCommand extends CommandMeta {
  readonly kind: 'submit-whale-plan';
  readonly roundIndex: number;
  readonly action: WhaleAction;
  readonly assetId?: OpaqueId;
  readonly units: number;
}

export interface PurchaseScanCommand extends CommandMeta {
  readonly kind: 'purchase-scan';
  readonly roundIndex: number;
  readonly scanId: OpaqueId;
  /** Required for asset scans; omitted only for an explicit board scope scan. */
  readonly assetId?: OpaqueId;
}

export interface PinEvidenceCommand extends CommandMeta {
  readonly kind: 'pin-evidence';
  readonly roundIndex: number;
  readonly evidenceId: OpaqueId;
}

export interface SubmitSuspicionCommand extends CommandMeta {
  readonly kind: 'submit-suspicion';
  readonly roundIndex: number;
  readonly primaryAssetId: OpaqueId;
  readonly secondaryAssetId: OpaqueId;
}

export interface FinishInvestigationCommand extends CommandMeta {
  readonly kind: 'finish-investigation';
  readonly roundIndex: number;
}

export interface FinalAccusationCommand extends CommandMeta {
  readonly kind: 'final-accusation';
  readonly primaryAssetId: OpaqueId;
  readonly secondaryAssetId: OpaqueId;
}

export type HuntQueueStatus = 'queued' | 'matched' | 'cancelled' | 'expired';

export interface HuntQueueEntryView {
  readonly queueId: OpaqueId;
  readonly status: HuntQueueStatus;
  readonly maxTracers: 1 | 5;
  readonly roomCode?: string;
  readonly matchId?: OpaqueId;
  readonly queuedAt: string;
}

export interface EnqueueHuntCommand extends CommandMeta {
  readonly role?: 'whale' | 'tracer';
  readonly playComputersNow?: boolean;
  readonly maxTracers: 1 | 5;
}

export interface HuntQueueTransport {
  enqueue(command: EnqueueHuntCommand): Promise<HuntQueueEntryView>;
  status(queueId: OpaqueId): Promise<HuntQueueEntryView>;
  cancel(queueId: OpaqueId, command: CommandMeta): Promise<HuntQueueEntryView>;
}

export type HuntCommand =
  | SelectHuntTargetsCommand
  | SubmitWhalePlanCommand
  | PurchaseScanCommand
  | PinEvidenceCommand
  | SubmitSuspicionCommand
  | FinishInvestigationCommand
  | FinalAccusationCommand;

export interface HuntReveal {
  readonly primaryAssetId: OpaqueId;
  readonly secondaryAssetId: OpaqueId;
  readonly accusation: {
    readonly primaryAssetId: OpaqueId;
    readonly secondaryAssetId: OpaqueId;
  } | null;
  /** Compiled provider identity is released only after the match is resolved. */
  readonly identities?: readonly HuntAssetIdentity[];
  readonly winner: 'whale' | 'tracers' | 'voided';
  readonly reason:
    'targets-identified' | 'objective-complete' | 'objective-incomplete' | 'technical-failure';
}

export interface HuntAssetIdentity {
  readonly assetId: OpaqueId;
  readonly symbol: string | null;
  readonly name: string | null;
}

export interface HuntReplaySummary {
  readonly reveal: HuntReveal | null;
  readonly rounds: readonly {
    readonly roundIndex: number;
    readonly whaleAction: WhaleAction;
    readonly whaleAssetId?: OpaqueId;
    readonly whaleUnits: number;
    readonly scans: readonly OpaqueId[];
    readonly pinnedEvidenceIds: readonly OpaqueId[];
    readonly suspicion: {
      readonly primaryAssetId: OpaqueId;
      readonly secondaryAssetId: OpaqueId;
    } | null;
  }[];
  readonly decisiveExplanation: string;
  readonly distraction: string;
  readonly badges: readonly string[];
  readonly score: { readonly whale: number; readonly tracers: number };
}

export interface HuntTransport extends HuntQueueTransport {
  replaySummary?(matchId: OpaqueId): Promise<HuntReplaySummary>;
  disconnect?(matchId: OpaqueId): Promise<HuntMatchView>;
  reconnect?(matchId: OpaqueId): Promise<HuntMatchView>;
  createRoom(command: {
    readonly idempotencyKey: IdempotencyKey;
    readonly maxTracers: 1 | 5;
  }): Promise<HuntRoomView>;
  joinRoom(
    roomCode: string,
    command: { readonly idempotencyKey: IdempotencyKey },
  ): Promise<HuntRoomView>;
  getMatch(matchId: OpaqueId, viewerRole: HuntRole): Promise<HuntMatchView>;
  command(
    matchId: OpaqueId,
    command: HuntCommand,
    viewerRole: HuntRole,
  ): Promise<HuntMatchView | HuntReveal>;
  replay(matchId: OpaqueId): Promise<readonly HuntReveal[]>;
}

export const HUNT_ROUTES = {
  rooms: 'POST /api/hunt/rooms',
  join: 'POST /api/hunt/rooms/:code/join',
  match: 'GET /api/hunt/matches/:id',
  commands: 'POST /api/hunt/matches/:id/commands',
  replay: 'GET /api/hunt/matches/:id/replay',
  queue: 'POST|GET|DELETE /api/hunt/queue',
  queueEnqueue: 'POST /api/hunt/queue',
  queueStatus: 'GET /api/hunt/queue/:id',
  queueCancel: 'DELETE /api/hunt/queue/:id',
} as const;
