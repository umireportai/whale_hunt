import type { IdempotencyKey, OpaqueId } from './game-rules.js';
import type { HuntV2Role } from './hunt-v2.js';

export const HUNT_LOBBY_TIMEOUT_MS = 60_000;

export type HuntLobbyStatus = 'queued' | 'matched' | 'cancelled';

export interface HuntLobbyView {
  readonly lobbyId: OpaqueId;
  readonly status: HuntLobbyStatus;
  readonly role: HuntV2Role;
  readonly queuedAt: string;
  readonly deadlineAt: string;
  readonly remainingMs: number;
  readonly queuePosition: number;
  readonly waitingFor: HuntV2Role;
  readonly opponentKind?: 'human' | 'computer';
  readonly matchId?: OpaqueId;
  readonly roomCode?: string;
}

export interface JoinHuntLobbyCommand {
  readonly role: HuntV2Role;
  readonly idempotencyKey: IdempotencyKey;
}

export interface HuntLobbyTransport {
  joinLobby(command: JoinHuntLobbyCommand): Promise<HuntLobbyView>;
  getLobby(lobbyId: OpaqueId): Promise<HuntLobbyView>;
  cancelLobby(lobbyId: OpaqueId, idempotencyKey: IdempotencyKey): Promise<HuntLobbyView>;
}
