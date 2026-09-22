import type {
  CreateHuntV2Command,
  HuntV2Command,
  HuntV2MatchView,
  HuntV2Transport,
} from '../../shared/hunt-v2.js';
import type {
  HuntLobbyTransport,
  HuntLobbyView,
  JoinHuntLobbyCommand,
} from '../../shared/hunt-lobby.js';
import type { ApiError, OpaqueId } from '../../shared/game-rules.js';

export class HuntV2ApiError extends Error {
  readonly code?: ApiError['code'] | string;
  readonly retryable?: boolean;
  readonly stateVersion?: number;

  constructor(message: string, details?: Partial<ApiError> & { stateVersion?: number }) {
    super(message);
    this.name = 'HuntV2ApiError';
    this.code = details?.code;
    this.retryable = details?.retryable;
    this.stateVersion = details?.stateVersion;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const body = init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body;
  if (body !== undefined && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, {
    ...init,
    body,
    credentials: 'same-origin',
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const details = payload && typeof payload === 'object' ? (payload as Partial<ApiError>) : {};
    throw new HuntV2ApiError(
      typeof details.message === 'string'
        ? details.message
        : 'The Hunt connection slipped. Try again.',
      details,
    );
  }
  return payload as T;
}

/** Browser transport for the Duello contract. */
export function createHuntV2ApiTransport(): HuntV2Transport {
  return {
    createMatch: (command: CreateHuntV2Command) =>
      requestJson('/hunt/v2/matches', { method: 'POST', body: JSON.stringify(command) }),
    joinMatch: (matchId: OpaqueId, idempotencyKey: string) =>
      requestJson(`/hunt/v2/matches/${encodeURIComponent(matchId)}/join`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey }),
      }),
    getMatch: (matchId: OpaqueId) => requestJson(`/hunt/v2/matches/${encodeURIComponent(matchId)}`),
    command: (matchId: OpaqueId, command: HuntV2Command) =>
      requestJson(`/hunt/v2/matches/${encodeURIComponent(matchId)}/commands`, {
        method: 'POST',
        body: JSON.stringify(command),
      }),
    rematch: (matchId: OpaqueId, idempotencyKey: string) =>
      requestJson(`/hunt/v2/matches/${encodeURIComponent(matchId)}/rematch`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey }),
      }),
  };
}

export function createHuntLobbyApiTransport(): HuntLobbyTransport {
  return {
    joinLobby: (command: JoinHuntLobbyCommand) =>
      requestJson<HuntLobbyView>('/hunt/v2/lobby', {
        method: 'POST',
        body: JSON.stringify(command),
      }),
    getLobby: (lobbyId: string) =>
      requestJson<HuntLobbyView>(`/hunt/v2/lobby/${encodeURIComponent(lobbyId)}`),
    cancelLobby: (lobbyId: string, idempotencyKey: string) =>
      requestJson<HuntLobbyView>(`/hunt/v2/lobby/${encodeURIComponent(lobbyId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ idempotencyKey }),
      }),
  };
}
