import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProgressionError, ProgressionService } from '../domain/progression/index.js';

export interface ProgressionRouteOptions {
  readonly service: ProgressionService;
  readonly playerId?: (request: FastifyRequest) => string | undefined;
  readonly cookieName?: string;
}

const idSchema = z.object({ id: z.string().min(1).max(200) }).strict();
function identity(request: FastifyRequest, options: ProgressionRouteOptions): string {
  const playerId =
    options.playerId?.(request) ?? request.cookies?.[options.cookieName ?? 'whale_session'];
  if (!playerId)
    throw new ProgressionError('FORBIDDEN', 'Start a session before viewing progression.', 401);
  return playerId;
}

function sendError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof ProgressionError)
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      retryable: false,
    });
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      code: 'INVALID_COMMAND',
      message: 'Invalid progression request.',
      retryable: false,
    });
  throw error;
}

async function safely<T>(reply: FastifyReply, action: () => T | Promise<T>): Promise<T | void> {
  try {
    return await action();
  } catch (error) {
    return sendError(error, reply) as void;
  }
}

/** Registers the Whale Hunt progression and public share boundaries. */
export async function registerProgressionRoutes(
  app: FastifyInstance,
  options: ProgressionRouteOptions,
): Promise<void> {
  app.get('/api/progression', async (request, reply) =>
    safely(reply, () => options.service.view(identity(request, options))),
  );
  app.get('/api/shares/:id', async (request, reply) =>
    safely(reply, () => options.service.readShare(idSchema.parse(request.params).id)),
  );
}

export const progressionRoutes = registerProgressionRoutes;
