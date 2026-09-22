import { createHash, randomUUID } from 'node:crypto';

/** Documentation-derived paths and estimates; responses are validated at collection time. */
export const NANSEN_OPERATIONS = {
  liveCandidates: { path: '/api/v1/token-screener', credits: 1, ttlMs: 300_000 },
  liveSmartMoneyNetflow: { path: '/api/v1/smart-money/netflow', credits: 5, ttlMs: 300_000 },
  liveTokenInfo: { path: '/api/v1/tgm/token-information', credits: 1, ttlMs: 300_000 },
  liveFlow: { path: '/api/v1/tgm/flow-intelligence', credits: 1, ttlMs: 300_000 },
  liveCandles: { path: '/api/v1/tgm/token-ohlcv', credits: 1, ttlMs: 60_000 },
  liveTrades: { path: '/api/v1/tgm/dex-trades', credits: 1, ttlMs: 300_000 },
  liveTransfers: { path: '/api/v1/tgm/transfers', credits: 1, ttlMs: 300_000 },
} as const;

export type Operation = keyof typeof NANSEN_OPERATIONS;
export type Schema<T> = { parse(input: unknown): T };
export type ProviderErrorCode =
  | 'disabled'
  | 'configuration'
  | 'endpoint'
  | 'request-schema'
  | 'schema'
  | 'budget'
  | 'credentials'
  | 'credits'
  | 'rate-limit'
  | 'http'
  | 'timeout'
  | 'network';

/** Only controlled messages escape this boundary: provider errors may contain secrets or raw data. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly status: number | null = null,
  ) {
    super(`Nansen request failed: ${code}`);
    this.name = 'ProviderError';
  }
}

export interface Usage {
  attempts: number;
  successfulHttpCalls: number;
  dataValidCalls: number;
  cacheHits: number;
  accountedCredits: number;
  actualDeductedCredits: number;
  attemptsWithUnknownCredits: number;
}

export interface AttemptEvent {
  id: string;
  operation: Operation;
  requestHash: string;
  startedAt: string;
  status: number | null;
  dataValid: boolean;
  estimatedCredits: number;
  actualCredits: number | null;
  error: ProviderErrorCode | null;
}

export interface ClientOptions {
  enabled?: boolean;
  apiKey?: string;
  creditBudget: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  timeoutMs?: number;
  /** Set only after verifying the provider's actual per-request credit header; never infer one. */
  verifiedCreditHeader?: string;
  /** Persist redacted accounting before live deployment. No payloads, request bodies, or credentials. */
  onAttempt?: (event: AttemptEvent) => void;
}

/** Stable JSON hashing lets equivalent object property order share a cache entry. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

/** Retry-After supports HTTP dates and seconds; missing/invalid values use jittered backoff. */
export function retryDelay(
  value: string | null,
  now: number,
  attempt: number,
  random: number,
): number {
  if (value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1_000;
  if (value !== null) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 500 * 2 ** attempt + Math.floor(random * 250);
}

/** Isolated, disabled-by-default transport. It is never connected to synthetic player requests. */
export function createNansenClient(options: ClientOptions) {
  if (
    !Number.isFinite(options.creditBudget) ||
    options.creditBudget < 0 ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
  ) {
    throw new ProviderError('configuration');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const usage: Usage = {
    attempts: 0,
    successfulHttpCalls: 0,
    dataValidCalls: 0,
    cacheHits: 0,
    accountedCredits: 0,
    actualDeductedCredits: 0,
    attemptsWithUnknownCredits: 0,
  };
  const cache = new Map<string, { expiresAt: number; data: unknown }>();
  const queue: Array<() => void> = [];
  let active = 0;
  let nextDispatchAt = 0;

  async function acquire() {
    if (active >= 2) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    const delay = Math.max(0, nextDispatchAt - now());
    nextDispatchAt = Math.max(nextDispatchAt, now()) + 500;
    await sleep(delay);
  }

  function release() {
    const next = queue.shift();
    if (next) next();
    else active--;
  }

  async function request<T>(
    operation: Operation,
    body: unknown,
    requestSchema: Schema<unknown>,
    responseSchema: Schema<T>,
  ): Promise<{ data: T; cached: boolean }> {
    if (!options.enabled) throw new ProviderError('disabled');
    if (!options.apiKey?.trim()) throw new ProviderError('configuration');
    if (!Object.hasOwn(NANSEN_OPERATIONS, operation)) throw new ProviderError('endpoint');
    const endpoint = NANSEN_OPERATIONS[operation];
    let serialized: string;
    try {
      // JSON round-trip rejects cyclic/bigint requests and removes unsupported undefined fields.
      serialized = stableJson(JSON.parse(JSON.stringify(requestSchema.parse(body))));
    } catch {
      throw new ProviderError('request-schema');
    }
    const hash = createHash('sha256').update(`${endpoint.path}:${serialized}`).digest('hex');
    const hit = cache.get(hash);
    if (hit && hit.expiresAt > now()) {
      try {
        const data = responseSchema.parse(structuredClone(hit.data));
        usage.cacheHits++;
        return { data, cached: true };
      } catch {
        throw new ProviderError('schema');
      }
    }
    cache.delete(hash);

    for (let attempt = 0; attempt <= 2; attempt++) {
      await acquire();
      let retryAfter: string | null = null;
      let error: ProviderError | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let event: AttemptEvent | undefined;
      const controller = new AbortController();
      try {
        // Reserve synchronously before fetch, so overlapping calls cannot both spend the same credits.
        if (usage.accountedCredits + endpoint.credits > options.creditBudget)
          throw new ProviderError('budget');
        usage.accountedCredits += endpoint.credits;
        usage.attempts++;
        usage.attemptsWithUnknownCredits++;
        event = {
          id: randomUUID(),
          operation,
          requestHash: hash,
          startedAt: new Date(now()).toISOString(),
          status: null,
          dataValid: false,
          estimatedCredits: endpoint.credits,
          actualCredits: null,
          error: null,
        };
        const task = async () => {
          const response = await fetcher(`https://api.nansen.ai${endpoint.path}`, {
            method: 'POST',
            // Nansen documents the canonical lowercase spelling. HTTP header names are
            // case-insensitive, but keeping the wire format identical to their examples
            // avoids proxy/auth middleware edge cases.
            headers: { apikey: options.apiKey!, 'Content-Type': 'application/json' },
            body: serialized,
            signal: controller.signal,
            redirect: 'error',
          });
          // A non-cooperative injected fetch may finish after timeout; do not mutate accounting twice.
          if (controller.signal.aborted) throw new ProviderError('timeout');
          event!.status = response.status;
          retryAfter = response.headers.get('Retry-After');
          if (options.verifiedCreditHeader) {
            const rawCredits = response.headers.get(options.verifiedCreditHeader);
            const credits = rawCredits?.trim() ? Number(rawCredits) : NaN;
            if (Number.isFinite(credits) && credits >= 0) {
              event!.actualCredits = credits;
              usage.actualDeductedCredits += credits;
              usage.accountedCredits += credits - endpoint.credits;
              usage.attemptsWithUnknownCredits--;
            }
          }
          if (response.ok) usage.successfulHttpCalls++;
          if (!response.ok) {
            // Read only the documented machine code. Never surface or retain the
            // provider body because it may contain request context or secrets.
            let providerCode: unknown;
            try {
              const payload = (await response.clone().json()) as {
                code?: unknown;
                error?: { code?: unknown };
              };
              providerCode =
                payload.code ??
                (payload.error && typeof payload.error === 'object'
                  ? payload.error.code
                  : undefined);
            } catch {
              providerCode = undefined;
            }
            await response.body?.cancel().catch(() => {});
            const code =
              providerCode === 'insufficient_credits' || response.status === 402
                ? 'credits'
                : response.status === 401 || response.status === 403
                  ? 'credentials'
                  : response.status === 429
                    ? 'rate-limit'
                    : 'http';
            throw new ProviderError(code, response.status);
          }
          let raw: unknown;
          try {
            raw = await response.json();
          } catch {
            throw new ProviderError('schema', response.status);
          }
          if (controller.signal.aborted) throw new ProviderError('timeout');
          let data: T;
          try {
            data = responseSchema.parse(structuredClone(raw));
          } catch {
            throw new ProviderError('schema', response.status);
          }
          usage.dataValidCalls++;
          event!.dataValid = true;
          if (cache.size >= 200) cache.delete(cache.keys().next().value!);
          cache.set(hash, { data: raw, expiresAt: now() + endpoint.ttlMs });
          return { data, cached: false };
        };
        return await Promise.race([
          task(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new ProviderError('timeout'));
            }, options.timeoutMs ?? 15_000);
          }),
        ]);
      } catch (cause) {
        error = cause instanceof ProviderError ? cause : new ProviderError('network');
        if (event) event.error = error.code;
      } finally {
        clearTimeout(timeout);
        release();
        if (event) options.onAttempt?.({ ...event });
      }
      const transient =
        error!.code === 'timeout' ||
        error!.code === 'network' ||
        error!.code === 'rate-limit' ||
        (error!.code === 'http' && (error!.status ?? 0) >= 500);
      if (!transient || attempt === 2) throw error;
      await sleep(retryDelay(retryAfter, now(), attempt, random()));
    }
    throw new ProviderError('network');
  }

  return { request, usage: (): Usage => ({ ...usage }) };
}
