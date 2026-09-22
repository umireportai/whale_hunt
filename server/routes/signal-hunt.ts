import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SIGNAL_HUNT_LANES,
  SIGNAL_HUNT_THESES,
  type SignalHuntCommand,
} from '../../shared/signal-hunt.js';
import { SignalHuntError, type SignalHuntEngine } from '../domain/signal-hunt.js';

export interface SignalHuntRouteOptions {
  readonly engine: SignalHuntEngine;
  readonly playerId: (request: FastifyRequest) => string;
}

const idSchema = z.object({ id: z.string().min(1).max(160) }).strict();
const startSchema = z
  .object({ caseId: z.string().min(1).max(160), idempotencyKey: z.string().min(1).max(160) })
  .strict();
const meta = z.object({
  expectedStateVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(1).max(160),
});
const commandSchema = z.discriminatedUnion('kind', [
  meta
    .extend({
      kind: z.literal('scan'),
      candidateId: z.string().min(1).max(160),
      lane: z.enum(SIGNAL_HUNT_LANES),
    })
    .strict(),
  meta
    .extend({
      kind: z.literal('lock'),
      candidateId: z.string().min(1).max(160),
      thesis: z.enum(SIGNAL_HUNT_THESES),
      direction: z.enum(['long', 'short']),
    })
    .strict(),
]);

function sendError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof SignalHuntError)
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.stateVersion === undefined ? {} : { stateVersion: error.stateVersion }),
    });
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      code: 'INVALID_COMMAND',
      message: 'Invalid Signal Hunt command.',
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

export async function registerSignalHuntRoutes(
  app: FastifyInstance,
  options: SignalHuntRouteOptions,
): Promise<void> {
  app.get('/api/signal-hunt/cases', async () => ({ cases: options.engine.listCases() }));
  app.post('/api/signal-hunt/attempts', async (request, reply) =>
    safely(reply, () =>
      options.engine.start(options.playerId(request), startSchema.parse(request.body)),
    ),
  );
  app.get('/api/signal-hunt/attempts/:id', async (request, reply) =>
    safely(reply, () =>
      options.engine.get(idSchema.parse(request.params).id, options.playerId(request)),
    ),
  );
  app.post('/api/signal-hunt/attempts/:id/commands', async (request, reply) =>
    safely(reply, () => {
      const command = commandSchema.parse(request.body) as SignalHuntCommand;
      return options.engine.command(
        idSchema.parse(request.params).id,
        options.playerId(request),
        command,
      );
    }),
  );
}
