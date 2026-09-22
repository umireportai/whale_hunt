import type { OpaqueId } from './game-rules.js';

export interface ProgressionBadge {
  readonly badgeId: OpaqueId;
  readonly title: string;
  readonly description: string;
  readonly earnedAt: string;
}

export interface HuntHistoryEntry {
  readonly matchKind?: 'human' | 'computer' | 'substituted';
  readonly matchId: OpaqueId;
  readonly completedAt: string;
  readonly role: 'whale' | 'tracer' | 'captain';
  readonly won: boolean;
  readonly rulesVersion: 'hunt-v1';
}

export interface ProgressionView {
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly huntHistory: readonly HuntHistoryEntry[];
  readonly badges: readonly ProgressionBadge[];
}

export interface ShareResult {
  readonly shareId: OpaqueId;
  readonly activity: 'hunt';
  readonly createdAt: string;
  readonly winner?: 'whale' | 'tracers';
}

export const PROGRESSION_ROUTES = {
  history: 'GET /api/progression',
  share: 'GET /api/shares/:id',
} as const;
