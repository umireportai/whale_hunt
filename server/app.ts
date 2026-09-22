import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { openDatabase } from './db/store.js';
import { HuntService } from './services/hunt-service.js';
import { HuntV2Service } from './services/hunt-v2.js';
import { HuntLobbyService } from './services/hunt-lobby.js';
import { SessionError, SessionService } from './services/session.js';
import { ProgressionService } from './domain/progression/index.js';
import { syncProgression } from './services/progression-feed.js';
import { registerHuntRoutes } from './routes/hunt.js';
import { registerHuntV2Routes } from './routes/hunt-v2.js';
import { registerSignalHuntRoutes } from './routes/signal-hunt.js';
import { registerProgressionRoutes } from './routes/progression.js';
import { registerMatchmakingRoutes } from './matchmaking/routes.js';
import { collectLiveScenario } from './domain/live.js';
import { createLiveHuntBoardFactory } from './domain/hunt/live-board.js';
import { createNansenClient, type AttemptEvent } from './nansen/client.js';
import { SCENARIOS, type SyntheticScenario } from '../fixtures/synthetic/scenarios.js';
import { createSignalHuntCases, SignalHuntEngine } from './domain/signal-hunt.js';

export interface AppOptions {
  databasePath?: string;
  production?: boolean;
  serveStatic?: boolean;
  logger?: boolean;
  rateLimitMax?: number;
  dataMode?: 'synthetic' | 'live';
}

const COOKIE = 'whale_session';

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384 });
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const db = openDatabase(
    options.databasePath ?? process.env.DATABASE_PATH ?? './data/whale-hunt.sqlite',
  );
  const sessions = new SessionService(db);
  const requestedMode =
    options.dataMode ?? (process.env.DATA_MODE === 'live' ? 'live' : 'synthetic');
  const apiKey = process.env.NANSEN_API_KEY?.trim();
  const liveHuntEnabled = requestedMode === 'live' && process.env.NANSEN_LIVE_HUNT !== 'false';
  const attemptLog: AttemptEvent[] = [];
  const nansen =
    liveHuntEnabled && apiKey
      ? createNansenClient({
          enabled: true,
          apiKey,
          creditBudget: Number(process.env.NANSEN_CREDIT_BUDGET ?? 24),
          verifiedCreditHeader: 'x-nansen-credits-cost',
          onAttempt: (event) => {
            if (attemptLog.length >= 100) attemptLog.shift();
            attemptLog.push(event);
          },
        })
      : null;

  const historicalScenarios: SyntheticScenario[] = [...SCENARIOS];
  let liveScenario: SyntheticScenario | null = null;
  let liveAvailable = false;
  let liveReason =
    requestedMode !== 'live'
      ? 'Whale Hunt is running with the five included historical replay cases.'
      : liveHuntEnabled
        ? apiKey
          ? 'Nansen live collection is starting.'
          : 'Set NANSEN_API_KEY to enable the live Whale Hunt feed.'
        : 'Live Whale Hunt collection is disabled. Set NANSEN_LIVE_HUNT=true to enable it.';

  const providerFailureReason = () => {
    const error = attemptLog.at(-1)?.error;
    if (error === 'credits')
      return 'Nansen rejected the request because the configured account has insufficient API credits.';
    if (error === 'credentials')
      return 'Nansen rejected the configured API key or endpoint permissions.';
    return 'Nansen live data could not be collected. Whale Hunt is using the five included historical replay cases.';
  };

  if (nansen) {
    try {
      const live = await collectLiveScenario(nansen);
      liveScenario = live;
      liveAvailable = true;
      liveReason = 'Live Nansen data is ready alongside the five historical replay cases.';
    } catch {
      liveReason = providerFailureReason();
    }
  }

  await app.register(cookie);
  await app.register(rateLimit, { max: options.rateLimitMax ?? 240, timeWindow: '1 minute' });
  app.addHook('onClose', async () => db.close());
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (production)
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    const origin = request.headers.origin;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && origin) {
      const allowed = new Set([
        `http://${request.headers.host}`,
        `https://${request.headers.host}`,
        process.env.APP_ORIGIN,
      ]);
      if (!production) {
        allowed.add('http://127.0.0.1:8311');
        allowed.add('http://localhost:8311');
      }
      if (!allowed.has(origin))
        throw new SessionError('This request came from an unrecognized origin.', 403);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ message: 'Invalid Whale Hunt request.' });
    const status =
      error instanceof SessionError
        ? error.statusCode
        : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) app.log.error(error);
    return reply.code(status).send({
      message:
        status >= 500
          ? 'Whale Hunt hit a snag. Your saved match state is safe; please retry.'
          : error instanceof Error
            ? error.message
            : 'Invalid request.',
    });
  });

  function sessionId(request: FastifyRequest): string {
    const id = request.cookies[COOKIE];
    if (!id) throw new SessionError('Start a session to enter Whale Hunt.', 401);
    sessions.read(id);
    return id;
  }

  const hunt = new HuntService(db);
  const progression = new ProgressionService(db);
  syncProgression(db, progression);
  const huntV2 = new HuntV2Service(db, {
    boardFactory: liveScenario ? createLiveHuntBoardFactory(liveScenario) : undefined,
    progression,
  });
  const caseScenarios = liveScenario
    ? [liveScenario, ...historicalScenarios]
    : historicalScenarios;
  const signalHunt = new SignalHuntEngine(db, createSignalHuntCases(null, caseScenarios));
  const huntLobby = new HuntLobbyService(huntV2);
  app.addHook('onClose', async () => {
    hunt.dispose();
    huntV2.dispose();
    huntLobby.dispose();
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') && reply.statusCode < 400) syncProgression(db, progression);
    return payload;
  });

  await registerHuntRoutes(app, {
    engine: hunt,
    playerId: sessionId,
    replaySummary: (id, actor) => hunt.replaySummary(id, actor),
  });
  await registerHuntV2Routes(app, { service: huntV2, lobby: huntLobby, playerId: sessionId });
  await registerSignalHuntRoutes(app, { engine: signalHunt, playerId: sessionId });
  await registerMatchmakingRoutes(app, { engine: hunt, playerId: sessionId });
  await registerProgressionRoutes(app, { service: progression, playerId: sessionId });

  const sessionSchema = z.object({}).strict();
  const accountNameSchema = z.object({ displayName: z.string().min(2).max(24) }).strict();
  app.post('/api/sessions', async (request, reply) => {
    sessionSchema.parse(request.body ?? {});
    const existing = request.cookies[COOKIE];
    if (existing) {
      try {
        return sessions.read(existing);
      } catch (error) {
        if (!(error instanceof SessionError) || error.statusCode !== 401) throw error;
      }
    }
    const session = sessions.create();
    reply.setCookie(COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return session;
  });
  app.post('/api/sessions/reset', async (request, reply) => {
    sessionSchema.parse(request.body ?? {});
    const session = sessions.create();
    reply.setCookie(COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return session;
  });
  app.get('/api/session', async (request) => sessions.read(sessionId(request)));
  app.get('/api/account', async (request) => {
    const session = sessions.read(sessionId(request));
    return { playerId: session.id, displayName: session.name };
  });
  app.post('/api/account/name', async (request) =>
    sessions.rename(sessionId(request), accountNameSchema.parse(request.body).displayName),
  );
  app.get('/healthz', async () => ({
    status: 'ok',
    mode: liveAvailable ? 'live' : requestedMode === 'live' ? 'unavailable' : 'synthetic',
    provider: liveAvailable ? 'nansen' : requestedMode === 'live' ? 'unavailable' : 'disabled',
    scenarioVersion: liveAvailable
      ? 'nansen-live-v1'
      : requestedMode === 'live'
        ? 'provider-unavailable'
        : 'synthetic-v1',
    liveAvailable,
    realHuntAvailable: true,
    realHuntMode: liveAvailable ? 'live' : 'historical',
    reason: liveReason,
  }));
  app.get('/api/admin/usage', async (request, reply) => {
    if (
      !process.env.ADMIN_TOKEN ||
      request.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`
    )
      return reply.code(401).send({ message: 'Administrator authentication required.' });
    return {
      projectId: 'whale-hunt',
      mode: liveAvailable ? 'live' : requestedMode === 'live' ? 'unavailable' : 'synthetic',
      ...nansen?.usage(),
      attempts: nansen?.usage().attempts ?? 0,
      successfulCalls: nansen?.usage().successfulHttpCalls ?? 0,
      validCalls: nansen?.usage().dataValidCalls ?? 0,
      deductedCredits: nansen?.usage().actualDeductedCredits ?? 0,
      reason: liveReason,
    };
  });
  if (options.serveStatic) {
    const root = resolve('dist');
    if (!existsSync(resolve(root, 'index.html')))
      throw new Error('Build the web app before starting production: npm run build');
    await app.register(staticFiles, { root });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/') || !request.headers.accept?.includes('text/html')
        ? reply.code(404).send({ message: 'Route not found.' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
