import type { CommandMeta, IdempotencyKey, OpaqueId } from './game-rules.js';

export const HUNT_V2_VERSION = 'hunt-v2' as const;
export const HUNT_V2_ZONES = ['A', 'B', 'C'] as const;
export const HUNT_V2_MOVES = ['burst', 'drip', 'blend', 'decoy', 'wait'] as const;
export const HUNT_V2_SCANS = [
  'flow',
  'concentration',
  'rhythm',
  'timing',
  'cross-asset',
  'position-growth',
] as const;
export type HuntV2Zone = (typeof HUNT_V2_ZONES)[number];
export type HuntV2Role = 'whale' | 'tracer';
export type HuntV2Move = 'burst' | 'drip' | 'blend' | 'decoy' | 'wait';
export type HuntV2ScanKind =
  'flow' | 'concentration' | 'rhythm' | 'timing' | 'cross-asset' | 'position-growth';
export type HuntV2Phase =
  'round_intro' | 'whale_hide' | 'tracer_hunt' | 'round_reveal' | 'match_over';

export interface HuntV2Window {
  readonly zone: HuntV2Zone;
  readonly price: readonly number[];
  readonly volume: readonly number[];
  readonly pulseIndices: readonly number[];
  readonly market?: HuntV2MarketContext;
}

export interface HuntV2MarketContext {
  readonly symbol: string;
  readonly name: string;
  readonly chain: string;
  readonly sourceKind: 'synthetic' | 'nansen';
  readonly observedAt?: string;
  readonly smartMoney: {
    readonly direction: 'accumulating' | 'distributing' | 'mixed' | 'unavailable';
    readonly netFlowUsd?: number;
    readonly walletCount?: number;
  };
  /** Provider-backed whale footprint used as game evidence, never as a trade instruction. */
  readonly whalePressure?: {
    readonly buyUsd: number;
    readonly sellUsd: number;
    readonly netUsd: number;
    readonly tradeCount?: number;
    readonly largestTradeUsd?: number;
  };
  readonly whalePositionUsd?: number;
  readonly holderMetrics?: {
    readonly buyers?: number;
    readonly sellers?: number;
    readonly liquidityUsd?: number;
    readonly volumeUsd?: number;
  };
}

export interface HuntV2ScanResult {
  readonly zone: HuntV2Zone;
  readonly kind: HuntV2ScanKind;
  readonly headline: string;
  readonly detail: string;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
}

export type HuntV2RoundReason =
  'caught' | 'escaped' | 'whale-timeout' | 'tracer-timeout' | 'forfeit';

export interface HuntV2RoundResult {
  readonly roundIndex: number;
  readonly hiddenZone: HuntV2Zone;
  readonly selectedZone: HuntV2Zone | null;
  readonly selectedAsset: {
    readonly zone: HuntV2Zone;
    readonly symbol: string;
    readonly name: string;
    readonly chain: string;
  } | null;
  readonly winner: HuntV2Role;
  readonly reason: HuntV2RoundReason;
  readonly explanation: string;
  readonly whaleMove: HuntV2Move | null;
  readonly decoyZone: HuntV2Zone | null;
  readonly decisiveScan: HuntV2ScanKind;
  readonly score: { readonly whale: number; readonly tracer: number };
}

export interface HuntV2Score {
  readonly whale: number;
  readonly tracer: number;
}

export interface HuntV2ParticipantView {
  readonly role: HuntV2Role;
  readonly displayName: string;
  readonly kind: 'human' | 'computer';
  readonly connection: 'connected' | 'reconnecting' | 'disconnected';
}

export interface HuntV2MatchView {
  readonly version: typeof HUNT_V2_VERSION;
  readonly matchId: OpaqueId;
  readonly role: HuntV2Role;
  readonly phase: HuntV2Phase;
  readonly stateVersion: number;
  readonly roundIndex: number;
  readonly totalRounds: 3;
  readonly score: HuntV2Score;
  readonly deadline: { readonly phase: HuntV2Phase; readonly at: string } | null;
  readonly serverNow: string;
  readonly windows: readonly HuntV2Window[];
  readonly scansRemaining: number;
  readonly scans: readonly HuntV2ScanResult[];
  readonly roundResults: readonly HuntV2RoundResult[];
  readonly participants: readonly HuntV2ParticipantView[];
  readonly whaleSelection?: {
    readonly zone: HuntV2Zone;
    readonly move: HuntV2Move;
    readonly decoyZone: HuntV2Zone | null;
  } | null;
  readonly selectedZone?: HuntV2Zone | null;
  readonly hiddenZone?: HuntV2Zone;
  readonly roundResult?: HuntV2RoundResult | null;
  readonly matchWinner?: HuntV2Role | null;
}

export interface CreateHuntV2Command {
  readonly role: HuntV2Role;
  readonly idempotencyKey: IdempotencyKey;
}

export interface SelectWhalePlanV2Command extends CommandMeta {
  readonly kind: 'select-whale-plan';
  readonly zone: HuntV2Zone;
  readonly move: HuntV2Move;
  readonly decoyZone?: HuntV2Zone;
}

export interface HideTradeV2Command extends CommandMeta {
  readonly kind: 'hide-trade';
}

export interface ScanV2Command extends CommandMeta {
  readonly kind: 'scan';
  readonly zone: HuntV2Zone;
  readonly scan: HuntV2ScanKind;
}

export interface LockCatchV2Command extends CommandMeta {
  readonly kind: 'lock-catch';
  readonly zone: HuntV2Zone;
}

export interface ForfeitV2Command extends CommandMeta {
  readonly kind: 'forfeit';
}

export type HuntV2Command = (
  | SelectWhalePlanV2Command
  | HideTradeV2Command
  | ScanV2Command
  | LockCatchV2Command
  | ForfeitV2Command
) & {
  readonly zone?: HuntV2Zone;
  readonly move?: HuntV2Move;
  readonly decoyZone?: HuntV2Zone;
  readonly scan?: HuntV2ScanKind;
};

export interface HuntV2Transport {
  createMatch(command: CreateHuntV2Command): Promise<HuntV2MatchView>;
  joinMatch(matchId: OpaqueId, idempotencyKey: IdempotencyKey): Promise<HuntV2MatchView>;
  getMatch(matchId: OpaqueId): Promise<HuntV2MatchView>;
  command(matchId: OpaqueId, command: HuntV2Command): Promise<HuntV2MatchView>;
  rematch(matchId: OpaqueId, idempotencyKey: IdempotencyKey): Promise<HuntV2MatchView>;
}
