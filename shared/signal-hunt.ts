import type { OpaqueId } from './game-rules.js';

export const SIGNAL_HUNT_VERSION = 'signal-hunt-v1' as const;
export const SIGNAL_HUNT_LANES = ['flow', 'whales', 'cohort', 'tape', 'market'] as const;
export const SIGNAL_HUNT_THESES = [
  'accumulation',
  'distribution',
  'whale-activity',
  'mixed-signal',
] as const;

export type SignalHuntLane = (typeof SIGNAL_HUNT_LANES)[number];
export type SignalHuntThesis = (typeof SIGNAL_HUNT_THESES)[number];
export type SignalHuntDirection = 'long' | 'short';
export type SignalHuntSourceKind =
  'synthetic' | 'historical-reconstructed' | 'historical-snapshot' | 'live-provider';
export type SignalHuntPhase = 'investigate' | 'result';

export interface SignalHuntChartPoint {
  readonly at: string;
  readonly value: number;
  readonly volume?: number;
}

export interface SignalHuntMetric {
  readonly label: string;
  readonly value: string;
}

export interface SignalHuntClueDescriptor {
  readonly clueId: OpaqueId;
  readonly lane: SignalHuntLane;
  readonly title: string;
  readonly question: string;
}

export interface SignalHuntClue {
  readonly clueId: OpaqueId;
  readonly candidateId?: OpaqueId;
  readonly candidateAlias?: string;
  readonly lane: SignalHuntLane;
  readonly title: string;
  readonly headline: string;
  readonly detail: string;
  readonly metrics: readonly SignalHuntMetric[];
  readonly limitation?: string;
  readonly observedAt: string;
  readonly sourceLabel: string;
}

export interface SignalHuntCandidateView {
  readonly assetId: OpaqueId;
  readonly alias: string;
  readonly chain: string;
  readonly chart: readonly SignalHuntChartPoint[];
  readonly currentPrice?: number;
  readonly changePct?: number;
  readonly volumeUsd?: number;
  readonly liquidityUsd?: number;
  readonly clueDescriptors: readonly SignalHuntClueDescriptor[];
  readonly unlockedClues: readonly SignalHuntClue[];
}

export interface SignalHuntCaseSummary {
  readonly caseId: OpaqueId;
  readonly title: string;
  readonly subtitle: string;
  readonly sourceKind: SignalHuntSourceKind;
  readonly sourceLabel: string;
  readonly snapshotAt: string;
  readonly candidateCount: number;
}

export interface SignalHuntRevealCandidate extends SignalHuntCandidateView {
  readonly name: string;
  readonly symbol: string;
  readonly thesis: SignalHuntThesis;
  readonly direction: SignalHuntDirection;
  readonly outcomeChart: readonly SignalHuntChartPoint[];
  readonly explanation: string;
}

export interface SignalHuntResult {
  readonly selectedAssetId: OpaqueId;
  readonly targetAssetId: OpaqueId;
  readonly selectedThesis: SignalHuntThesis;
  readonly targetThesis: SignalHuntThesis;
  readonly selectedDirection: SignalHuntDirection;
  readonly targetDirection: SignalHuntDirection;
  readonly correctAsset: boolean;
  readonly correctThesis: boolean;
  readonly correctDirection: boolean;
  readonly score: number;
  readonly target: SignalHuntRevealCandidate;
  readonly explanation: string;
}

export interface SignalHuntView {
  readonly version: typeof SIGNAL_HUNT_VERSION;
  readonly attemptId: OpaqueId;
  readonly case: SignalHuntCaseSummary;
  readonly phase: SignalHuntPhase;
  readonly stateVersion: number;
  readonly scansRemaining: number;
  readonly scans: readonly SignalHuntClue[];
  readonly candidates: readonly SignalHuntCandidateView[];
  readonly selectedAssetId: OpaqueId | null;
  readonly result: SignalHuntResult | null;
}

export interface StartSignalHuntCommand {
  readonly caseId: OpaqueId;
  readonly idempotencyKey: string;
}

export interface SignalHuntScanCommand {
  readonly kind: 'scan';
  readonly candidateId: OpaqueId;
  readonly lane: SignalHuntLane;
  readonly expectedStateVersion: number;
  readonly idempotencyKey: string;
}

export interface LockSignalHuntCommand {
  readonly kind: 'lock';
  readonly candidateId: OpaqueId;
  readonly thesis: SignalHuntThesis;
  readonly direction: SignalHuntDirection;
  readonly expectedStateVersion: number;
  readonly idempotencyKey: string;
}

export type SignalHuntCommand = SignalHuntScanCommand | LockSignalHuntCommand;

export interface SignalHuntTransport {
  listCases(): Promise<readonly SignalHuntCaseSummary[]>;
  start(command: StartSignalHuntCommand): Promise<SignalHuntView>;
  get(attemptId: OpaqueId): Promise<SignalHuntView>;
  command(attemptId: OpaqueId, command: SignalHuntCommand): Promise<SignalHuntView>;
}
