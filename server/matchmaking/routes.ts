import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MatchmakingError } from './engine.js';

export interface MatchmakingQueuePort {
  enqueue: (
    ...args: Parameters<import('./engine.js').MatchmakingEngine['enqueue']>
  ) => ReturnType<import('./engine.js').MatchmakingEngine['enqueue']>;
  status: (
    ...args: Parameters<import('./engine.js').MatchmakingEngine['status']>
  ) => ReturnType<import('./engine.js').MatchmakingEngine['status']>;
  cancel: (
    ...args: Parameters<import('./engine.js').MatchmakingEngine['cancel']>
  ) => ReturnType<import('./engine.js').MatchmakingEngine['cancel']>;
}

export interface MatchmakingRouteOptions {
  /** HuntService and MatchmakingEngine both implement this queue port. */
  readonly engine: MatchmakingQueuePort;
  readonly playerId?: (request: FastifyRequest) => string | undefined;
  readonly cookieName?: string;
}

const queueIdSchema = z.object({ id: z.string().min(1).max(160) }).strict();
const enqueueSchema = z
  .object({
    expectedStateVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(1).max(160),
    maxTracers: z.union([z.literal(1), z.literal(5)]),
  })
  .strict();
const cancelSchema = z
  .object({
    expectedStateVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();
const querySchema = z
  .object({
    role: z.enum(['whale', 'tracer']).optional(),
    playComputersNow: z.enum(['true', 'false']).optional(),
  })
  .strict();

function identity(request: FastifyRequest, options: MatchmakingRouteOptions): string {
  const playerId =
    options.playerId?.(request) ?? request.cookies?.[options.cookieName ?? 'whale_session'];
  if (!playerId)
    throw new MatchmakingError('FORBIDDEN', 'Start a session before joining Hunt.', 401);
  return playerId;
}

function sendError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof MatchmakingError)
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  if (error instanceof z.ZodError)
    return reply
      .code(400)
      .send({ code: 'INVALID_COMMAND', message: 'Invalid Hunt queue command.', retryable: false });
  throw error;
}

async function safely<T>(reply: FastifyReply, action: () => T | Promise<T>): Promise<T | void> {
  try {
    return await action();
  } catch (error) {
    return sendError(error, reply) as void;
  }
}

/** Registers queue enqueue, status, and cancellation routes without owning app startup. */
export async function registerMatchmakingRoutes(
  app: FastifyInstance,
  options: MatchmakingRouteOptions,
): Promise<void> {
  app.post('/api/hunt/queue', async (request, reply) =>
    safely(reply, () => {
      const body = enqueueSchema.parse(request.body);
      const query = querySchema.parse(request.query);
      return options.engine.enqueue(identity(request, options), {
        ...body,
        ...(query.role ? { role: query.role } : {}),
        ...(query.playComputersNow === 'true' ? { playComputersNow: true } : {}),
      });
    }),
  );
  app.get('/api/hunt/queue/:id', async (request, reply) =>
    safely(reply, () =>
      options.engine.status(queueIdSchema.parse(request.params).id, identity(request, options)),
    ),
  );
  app.delete('/api/hunt/queue/:id', async (request, reply) =>
    safely(reply, () =>
      options.engine.cancel(
        queueIdSchema.parse(request.params).id,
        identity(request, options),
        cancelSchema.parse(request.body),
      ),
    ),
  );
}

export const matchmakingRoutes = registerMatchmakingRoutes;
