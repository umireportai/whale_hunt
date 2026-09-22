import type {
  SignalHuntCaseSummary,
  SignalHuntCommand,
  SignalHuntTransport,
  SignalHuntView,
  StartSignalHuntCommand,
} from '../../shared/signal-hunt.js';
import type { OpaqueId } from '../../shared/game-rules.js';

export class SignalHuntApiError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly stateVersion?: number;

  constructor(
    message: string,
    details?: { code?: string; retryable?: boolean; stateVersion?: number },
  ) {
    super(message);
    this.name = 'SignalHuntApiError';
    this.code = details?.code;
    this.retryable = details?.retryable;
    this.stateVersion = details?.stateVersion;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, {
    ...init,
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
    const details =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    throw new SignalHuntApiError(
      typeof details.message === 'string'
        ? details.message
        : 'The historical current slipped away.',
      {
        code: typeof details.code === 'string' ? details.code : undefined,
        retryable: details.retryable === true,
        stateVersion: typeof details.stateVersion === 'number' ? details.stateVersion : undefined,
      },
    );
  }
  return payload as T;
}

export function createSignalHuntApiTransport(): SignalHuntTransport {
  return {
    listCases: async () => {
      const payload = await requestJson<{ cases: readonly SignalHuntCaseSummary[] }>(
        '/signal-hunt/cases',
      );
      return payload.cases;
    },
    start: (command: StartSignalHuntCommand) =>
      requestJson('/signal-hunt/attempts', { method: 'POST', body: JSON.stringify(command) }),
    get: (attemptId: OpaqueId) =>
      requestJson(`/signal-hunt/attempts/${encodeURIComponent(attemptId)}`),
    command: (attemptId: OpaqueId, command: SignalHuntCommand) =>
      requestJson(`/signal-hunt/attempts/${encodeURIComponent(attemptId)}/commands`, {
        method: 'POST',
        body: JSON.stringify(command),
      }),
  };
}
