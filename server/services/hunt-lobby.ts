import { randomUUID } from 'node:crypto';
import type { HuntV2Role } from '../../shared/hunt-v2.js';
import { HUNT_LOBBY_TIMEOUT_MS, type HuntLobbyView } from '../../shared/hunt-lobby.js';
import { HuntV2Error } from '../domain/hunt/v2.js';
import type { HuntV2Service } from './hunt-v2.js';

interface LobbyEntry {
  readonly lobbyId: string;
  readonly playerId: string;
  role: HuntV2Role;
  readonly queuedAt: Date;
  readonly deadlineAt: Date;
  status: HuntLobbyView['status'];
  matchId?: string;
  roomCode?: string;
  opponentKind?: 'human' | 'computer';
  timer?: ReturnType<typeof setTimeout>;
}

export class HuntLobbyError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_COMMAND',
    message: string,
    readonly statusCode = code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 400,
  ) {
    super(message);
    this.name = 'HuntLobbyError';
  }
}

function required(value: string, label: string): string {
  if (!value.trim() || value.length > 160)
    throw new HuntLobbyError('INVALID_COMMAND', `${label} is required.`);
  return value;
}

function opposite(role: HuntV2Role): HuntV2Role {
  return role === 'whale' ? 'tracer' : 'whale';
}

/** A small process-local lobby; match state and progression remain durable in SQLite. */
export class HuntLobbyService {
  private readonly entries = new Map<string, LobbyEntry>();
  private readonly joinKeys = new Map<string, string>();

  constructor(private readonly hunt: HuntV2Service) {}

  dispose(): void {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
    this.joinKeys.clear();
  }

  join(playerId: string, requestedRole: HuntV2Role, idempotencyKey: string): HuntLobbyView {
    const actor = required(playerId, 'Player identity');
    const key = required(idempotencyKey, 'Idempotency key');
    if (requestedRole !== 'whale' && requestedRole !== 'tracer')
      throw new HuntLobbyError('INVALID_COMMAND', 'Choose whale or tracer.');
    const prior = this.joinKeys.get(`${actor}:${key}`);
    if (prior) {
      const previous = this.entries.get(prior);
      if (previous) return this.view(previous);
    }
    const existing = [...this.entries.values()].find(
      (entry) => entry.playerId === actor && entry.status === 'queued',
    );
    if (existing) return this.view(existing);

    const waiting = [...this.entries.values()].filter((entry) => entry.status === 'queued');
    // If both users clicked the same seat, the second click becomes the opposite seat.
    const role =
      waiting.length > 0 && !waiting.some((entry) => entry.role !== requestedRole)
        ? opposite(waiting[0]!.role)
        : requestedRole;
    const now = new Date();
    const entry: LobbyEntry = {
      lobbyId: randomUUID(),
      playerId: actor,
      role,
      queuedAt: now,
      deadlineAt: new Date(now.getTime() + HUNT_LOBBY_TIMEOUT_MS),
      status: 'queued',
    };
    this.entries.set(entry.lobbyId, entry);
    this.joinKeys.set(`${actor}:${key}`, entry.lobbyId);
    entry.timer = setTimeout(() => this.promoteToComputer(entry.lobbyId), HUNT_LOBBY_TIMEOUT_MS);
    entry.timer.unref?.();
    this.tryPair(entry);
    return this.view(entry);
  }

  status(lobbyId: string, playerId: string): HuntLobbyView {
    const entry = this.authorize(lobbyId, playerId);
    if (entry.status === 'queued' && Date.now() >= entry.deadlineAt.getTime())
      this.promoteToComputer(entry.lobbyId);
    return this.view(entry);
  }

  cancel(lobbyId: string, playerId: string): HuntLobbyView {
    const entry = this.authorize(lobbyId, playerId);
    if (entry.status === 'queued') {
      entry.status = 'cancelled';
      if (entry.timer) clearTimeout(entry.timer);
    }
    return this.view(entry);
  }

  private authorize(lobbyId: string, playerId: string): LobbyEntry {
    const entry = this.entries.get(required(lobbyId, 'Lobby id'));
    if (!entry) throw new HuntLobbyError('NOT_FOUND', 'This lobby seat has expired.', 404);
    if (entry.playerId !== required(playerId, 'Player identity'))
      throw new HuntLobbyError('FORBIDDEN', 'This lobby seat belongs to another player.', 403);
    return entry;
  }

  private tryPair(entry: LobbyEntry): void {
    if (entry.status !== 'queued') return;
    const opponent = [...this.entries.values()].find(
      (candidate) =>
        candidate.status === 'queued' &&
        candidate.lobbyId !== entry.lobbyId &&
        candidate.role !== entry.role,
    );
    if (!opponent) return;
    const whale = entry.role === 'whale' ? entry : opponent;
    const tracer = whale === entry ? opponent : entry;
    try {
      const created = this.hunt.createMatch(whale.playerId, {
        role: 'whale',
        idempotencyKey: `lobby-create-${whale.lobbyId}`,
      });
      this.hunt.joinMatch(created.matchId, tracer.playerId);
      for (const member of [whale, tracer]) {
        member.status = 'matched';
        member.matchId = created.matchId;
        member.roomCode = created.matchId.slice(0, 8).toUpperCase();
        member.opponentKind = 'human';
        if (member.timer) clearTimeout(member.timer);
      }
    } catch (error) {
      if (error instanceof HuntV2Error) throw error;
      throw new HuntLobbyError('INVALID_COMMAND', 'Whale Hunt could not create the duel.', 409);
    }
  }

  private promoteToComputer(lobbyId: string): void {
    const entry = this.entries.get(lobbyId);
    if (!entry || entry.status !== 'queued') return;
    try {
      const created = this.hunt.createMatch(entry.playerId, {
        role: entry.role,
        idempotencyKey: `lobby-ai-${entry.lobbyId}`,
      });
      entry.status = 'matched';
      entry.matchId = created.matchId;
      entry.roomCode = created.matchId.slice(0, 8).toUpperCase();
      entry.opponentKind = 'computer';
    } catch {
      entry.timer = setTimeout(() => this.promoteToComputer(lobbyId), 1000);
      entry.timer.unref?.();
    }
  }

  private view(entry: LobbyEntry): HuntLobbyView {
    const queued = [...this.entries.values()]
      .filter((candidate) => candidate.status === 'queued')
      .sort((left, right) => left.queuedAt.getTime() - right.queuedAt.getTime());
    return {
      lobbyId: entry.lobbyId,
      status: entry.status,
      role: entry.role,
      queuedAt: entry.queuedAt.toISOString(),
      deadlineAt: entry.deadlineAt.toISOString(),
      remainingMs:
        entry.status === 'queued' ? Math.max(0, entry.deadlineAt.getTime() - Date.now()) : 0,
      queuePosition:
        entry.status === 'queued'
          ? Math.max(1, queued.findIndex((item) => item.lobbyId === entry.lobbyId) + 1)
          : 0,
      waitingFor: opposite(entry.role),
      ...(entry.opponentKind ? { opponentKind: entry.opponentKind } : {}),
      ...(entry.matchId ? { matchId: entry.matchId } : {}),
      ...(entry.roomCode ? { roomCode: entry.roomCode } : {}),
    };
  }
}
