import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HuntReveal } from '../../../shared/hunt.js';
import {
  type HuntHistoryEntry,
  type ProgressionBadge,
  type ProgressionView,
  type ShareResult,
} from '../../../shared/progression.js';
import {
  initializeProgressionDatabase,
  insertProgressionBadge,
  insertProgressionHuntResult,
  insertProgressionShare,
  progressionTransaction,
  readProgressionBadges,
  readProgressionHuntResult,
  readProgressionHuntResults,
  readProgressionShare,
  type ProgressionHuntRow,
} from '../../db/progression.js';
import {
  BADGE_DEFINITIONS,
  PROGRESSION_BADGES,
  badgeDefinition,
  huntBadgeIds,
  type ProgressionBadgeId,
} from './badges.js';
import type {
  HuntProgressionInput,
  ProgressionLink,
  ProgressionServiceOptions,
  ProgressionShareInput,
  PublicShareRecord,
} from './types.js';

export type ProgressionErrorCode = 'INVALID_RESULT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT';

export class ProgressionError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ProgressionErrorCode,
    message: string,
    statusCode = code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 409,
  ) {
    super(message);
    this.name = 'ProgressionError';
    this.statusCode = statusCode;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value)
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  throw new ProgressionError('INVALID_RESULT', 'Finalized results must contain finite JSON values.', 400);
}

function requireText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ProgressionError('INVALID_RESULT', `${label} is required.`, 400);
  return value;
}

function validInstant(value: string, label: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at))
    throw new ProgressionError('INVALID_RESULT', `${label} must be a valid timestamp.`, 400);
  return new Date(at).toISOString();
}

function dateKey(value: string): string {
  return validInstant(value, 'Completion time').slice(0, 10);
}

function ordinal(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
}

/** Calculates current and best streaks using UTC Hunt completion days. */
export function calculateUtcStreak(
  completedAt: readonly string[],
  now = new Date(),
): { readonly currentStreak: number; readonly bestStreak: number } {
  const unique = [...new Set(completedAt.map(dateKey))].sort();
  if (!unique.length) return { currentStreak: 0, bestStreak: 0 };
  let bestStreak = 1;
  let run = 1;
  for (let index = 1; index < unique.length; index += 1) {
    if (ordinal(unique[index]!) === ordinal(unique[index - 1]!) + 1) run += 1;
    else run = 1;
    bestStreak = Math.max(bestStreak, run);
  }
  const today = ordinal(now.toISOString().slice(0, 10));
  const newest = ordinal(unique.at(-1)!);
  if (today - newest > 1) return { currentStreak: 0, bestStreak };
  let currentStreak = 1;
  for (let index = unique.length - 1; index > 0; index -= 1) {
    if (ordinal(unique[index]!) === ordinal(unique[index - 1]!) + 1) currentStreak += 1;
    else break;
  }
  return { currentStreak, bestStreak };
}

function huntHistory(row: ProgressionHuntRow): HuntHistoryEntry {
  return {
    matchId: row.match_id,
    matchKind: row.match_kind,
    completedAt: row.completed_at,
    role: row.role,
    won: row.won === 1,
    rulesVersion: row.rules_version,
  };
}

function badgeView(row: { readonly badge_id: string; readonly earned_at: string }): ProgressionBadge {
  const definition = badgeDefinition(row.badge_id);
  if (!definition) throw new Error(`Unknown progression badge ${row.badge_id}.`);
  return { ...definition, earnedAt: row.earned_at };
}

function pairIncludesDecoy(reveal: HuntReveal | undefined): boolean {
  return Boolean(reveal?.accusation && reveal.accusation.primaryAssetId === 'decoy');
}

function winningRole(role: 'whale' | 'tracer' | 'captain'): 'whale' | 'tracer' {
  return role === 'whale' ? 'whale' : 'tracer';
}

export class ProgressionService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly db: DatabaseSync,
    options: ProgressionServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    initializeProgressionDatabase(db);
  }

  view(playerId: string): ProgressionView {
    const id = requireText(playerId, 'Player identity');
    const hunts = readProgressionHuntResults(this.db, id);
    return {
      ...calculateUtcStreak(
        hunts.map((row) => row.completed_at),
        this.now(),
      ),
      huntHistory: hunts.map(huntHistory),
      badges: readProgressionBadges(this.db, id).map(badgeView),
    };
  }

  history(playerId: string): ProgressionView {
    return this.view(playerId);
  }

  recordHuntResult(input: HuntProgressionInput): ProgressionView {
    const normalized = this.normalizeHunt(input);
    progressionTransaction(this.db, () => {
      const existing = readProgressionHuntResult(
        this.db,
        normalized.row.match_id,
        normalized.row.player_id,
      );
      if (existing) {
        if (existing.finalized_payload !== normalized.row.finalized_payload)
          throw new ProgressionError(
            'CONFLICT',
            'This Hunt completion was already recorded with different data.',
          );
        return;
      }
      insertProgressionHuntResult(this.db, normalized.row);
      for (const badgeId of huntBadgeIds({
        role: normalized.row.role,
        won: normalized.row.won === 1,
        finalPairCorrect: normalized.row.final_pair_correct === 1,
        finalIncludesDecoy: normalized.row.final_includes_decoy === 1,
      }))
        this.award(normalized.row.player_id, badgeId);
      const history = readProgressionHuntResults(this.db, normalized.row.player_id);
      const qualifying = new Set(
        history
          .filter(
            (row) =>
              row.correct_pair_before_final === 1 &&
              (row.role === 'tracer' || row.role === 'captain'),
          )
          .map((row) => row.match_id),
      );
      if (qualifying.size >= 3)
        this.award(normalized.row.player_id, PROGRESSION_BADGES.patternReader);
      const winningSides = new Set(
        history.filter((row) => row.won === 1).map((row) => winningRole(row.role)),
      );
      if (winningSides.has('whale') && winningSides.has('tracer'))
        this.award(normalized.row.player_id, PROGRESSION_BADGES.bothSides);
      const tracerWins = history.filter((row) => row.role === 'tracer' && row.won === 1).length;
      const whaleWins = history.filter((row) => row.role === 'whale' && row.won === 1).length;
      if (tracerWins >= 10) this.award(normalized.row.player_id, PROGRESSION_BADGES.tracerTen);
      if (tracerWins >= 100) this.award(normalized.row.player_id, PROGRESSION_BADGES.tracerHundred);
      if (whaleWins >= 10) this.award(normalized.row.player_id, PROGRESSION_BADGES.whaleTen);
      if (whaleWins >= 100) this.award(normalized.row.player_id, PROGRESSION_BADGES.whaleHundred);
    });
    return this.view(normalized.row.player_id);
  }

  recordHuntCompletion(input: HuntProgressionInput): ProgressionView {
    return this.recordHuntResult(input);
  }

  createShare(input: ProgressionShareInput): PublicShareRecord {
    const owner = requireText(input.ownerPlayerId, 'Share owner');
    const createdAt = this.now().toISOString();
    const shareId = requireText(this.idFactory(), 'Share id');
    const result: ShareResult = {
      shareId,
      activity: 'hunt',
      createdAt,
      ...(input.result.winner === undefined ? {} : { winner: input.result.winner }),
    };
    const row = {
      share_id: shareId,
      owner_player_id: owner,
      activity: 'hunt' as const,
      created_at: createdAt,
      public_payload: stableJson(result),
      target_match_id: input.targetMatchId ?? null,
      role_swap: input.roleSwap ? 1 : 0,
      practice_only: input.practiceOnly ? 1 : 0,
    } as const;
    progressionTransaction(this.db, () => insertProgressionShare(this.db, row));
    return { result, roleSwap: row.role_swap === 1, practiceOnly: row.practice_only === 1 };
  }

  readShare(shareId: string): ShareResult {
    const row = readProgressionShare(this.db, requireText(shareId, 'Share id'));
    if (!row) throw new ProgressionError('NOT_FOUND', 'Share not found.', 404);
    return JSON.parse(row.public_payload) as ShareResult;
  }

  readShareLink(shareId: string): ProgressionLink {
    const row = readProgressionShare(this.db, requireText(shareId, 'Share id'));
    if (!row) throw new ProgressionError('NOT_FOUND', 'Share not found.', 404);
    return {
      shareId: row.share_id,
      activity: 'hunt',
      roleSwap: row.role_swap === 1,
      practiceOnly: row.practice_only === 1,
      href: `/share/${encodeURIComponent(row.share_id)}`,
    };
  }

  createHuntRematchLink(input: {
    readonly ownerPlayerId: string;
    readonly matchId: string;
    readonly roleSwap?: boolean;
  }): ProgressionLink {
    const share = this.createShare({
      ownerPlayerId: input.ownerPlayerId,
      result: { shareId: '', activity: 'hunt', createdAt: this.now().toISOString() },
      targetMatchId: requireText(input.matchId, 'Match id'),
      roleSwap: input.roleSwap ?? true,
      practiceOnly: true,
    });
    return this.readShareLink(share.result.shareId);
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new ProgressionError('INVALID_RESULT', 'A valid progression clock is required.', 500);
    return value;
  }

  private normalizeHunt(input: HuntProgressionInput): { row: ProgressionHuntRow } {
    if ((input as unknown as { finalized?: boolean }).finalized === false)
      throw new ProgressionError(
        'INVALID_RESULT',
        'Only finalized Hunt results can enter progression.',
        400,
      );
    const playerId = requireText(input.playerId, 'Player identity');
    const matchId = requireText(input.matchId, 'Match id');
    const completedAt = validInstant(input.completedAt, 'Completion time');
    const resolution = input.resolution;
    const reveal = input.reveal ?? resolution?.reveal;
    const scores = input.scores ?? resolution?.scores;
    if (!reveal && !scores && input.finalized !== true)
      throw new ProgressionError('INVALID_RESULT', 'A finalized Hunt result payload is required.', 400);
    if (reveal?.winner === 'voided')
      throw new ProgressionError('INVALID_RESULT', 'Voided Hunt matches do not award progression.', 400);
    const tracerRole = input.role === 'tracer' || input.role === 'captain';
    const won = input.won ?? reveal?.winner === (tracerRole ? 'tracers' : 'whale');
    const finalPairCorrect =
      input.finalPairCorrect ?? scores?.finalPairCorrect ?? reveal?.reason === 'targets-identified';
    const correctPairBeforeFinal = input.correctPairBeforeFinal ?? false;
    const finalIncludesDecoy = input.finalIncludesDecoy ?? pairIncludesDecoy(reveal);
    const payload = stableJson({
      matchId,
      playerId,
      completedAt,
      role: input.role,
      matchKind: input.matchKind,
      maxTracers: input.maxTracers,
      won,
      finalPairCorrect,
      correctPairBeforeFinal,
      finalIncludesDecoy,
      reveal,
      scores,
    });
    return {
      row: {
        match_id: matchId,
        player_id: playerId,
        completed_at: completedAt,
        role: input.role,
        won: won ? 1 : 0,
        rules_version: input.rulesVersion ?? 'hunt-v1',
        match_kind: input.matchKind,
        max_tracers: input.maxTracers,
        final_pair_correct: finalPairCorrect ? 1 : 0,
        correct_pair_before_final: correctPairBeforeFinal ? 1 : 0,
        final_includes_decoy: finalIncludesDecoy ? 1 : 0,
        finalized_payload: payload,
        created_at: this.now().toISOString(),
      },
    };
  }

  private award(playerId: string, badgeId: ProgressionBadgeId): void {
    if (!badgeDefinition(badgeId)) throw new Error(`Unknown progression badge ${badgeId}.`);
    insertProgressionBadge(this.db, {
      player_id: playerId,
      badge_id: badgeId,
      earned_at: this.now().toISOString(),
    });
  }
}

export { BADGE_DEFINITIONS };
