import type {
  EnqueueHuntCommand,
  HuntCommand,
  HuntMatchView,
  HuntQueueEntryView,
  HuntReveal,
  HuntRole,
  HuntRoomView,
  HuntTransport,
} from '../../shared/hunt.js';
import type { ApiError, CommandMeta, OpaqueId } from '../../shared/game-rules.js';

export type HuntRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export class HuntApiError extends Error {
  readonly code?: ApiError['code'];
  readonly retryable?: boolean;
  readonly stateVersion?: number;

  constructor(message: string, details?: Partial<ApiError>) {
    super(message);
    this.name = 'HuntApiError';
    this.code = details?.code;
    this.retryable = details?.retryable;
    this.stateVersion = details?.stateVersion;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (body !== undefined && typeof body !== 'string') body = JSON.stringify(body);
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
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' ? (payload as Partial<ApiError>) : {};
    throw new HuntApiError(
      typeof error.message === 'string'
        ? error.message
        : 'The hunt connection slipped. Please try again.',
      error,
    );
  }
  return payload as T;
}

function withRole(path: string, viewerRole: HuntRole): string {
  return `${path}${path.includes('?') ? '&' : '?'}viewerRole=${encodeURIComponent(viewerRole)}`;
}

/** Create the browser transport for the versioned Whale Hunt HTTP contract. */
export function createHuntApiTransport(request: HuntRequest = requestJson): HuntTransport {
  return {
    replaySummary: (id) => request(`/hunt/matches/${encodeURIComponent(id)}/replay-summary`),
    disconnect: (id) =>
      request(`/hunt/matches/${encodeURIComponent(id)}/disconnect`, { method: 'POST', body: '{}' }),
    reconnect: (id) =>
      request(`/hunt/matches/${encodeURIComponent(id)}/reconnect`, { method: 'POST', body: '{}' }),
    async enqueue(command: EnqueueHuntCommand): Promise<HuntQueueEntryView> {
      const { role, playComputersNow, ...body } = command;
      const query = new URLSearchParams();
      if (role) query.set('role', role);
      if (playComputersNow) query.set('playComputersNow', 'true');
      return request(`/hunt/queue${query.size ? `?${query}` : ''}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    async status(queueId: OpaqueId): Promise<HuntQueueEntryView> {
      return request(`/hunt/queue/${encodeURIComponent(queueId)}`);
    },
    async cancel(queueId: OpaqueId, command: CommandMeta): Promise<HuntQueueEntryView> {
      return request(`/hunt/queue/${encodeURIComponent(queueId)}`, {
        method: 'DELETE',
        body: JSON.stringify(command),
      });
    },
    async createRoom(command): Promise<HuntRoomView> {
      return request('/hunt/rooms', { method: 'POST', body: JSON.stringify(command) });
    },
    async joinRoom(roomCode, command): Promise<HuntRoomView> {
      return request(`/hunt/rooms/${encodeURIComponent(roomCode)}/join`, {
        method: 'POST',
        body: JSON.stringify(command),
      });
    },
    async getMatch(matchId, viewerRole): Promise<HuntMatchView> {
      return request(withRole(`/hunt/matches/${encodeURIComponent(matchId)}`, viewerRole));
    },
    async command(matchId, command: HuntCommand, viewerRole): Promise<HuntMatchView | HuntReveal> {
      return request(
        withRole(`/hunt/matches/${encodeURIComponent(matchId)}/commands`, viewerRole),
        {
          method: 'POST',
          body: JSON.stringify(command),
        },
      );
    },
    async replay(matchId): Promise<readonly HuntReveal[]> {
      return request(`/hunt/matches/${encodeURIComponent(matchId)}/replay`);
    },
  };
}
