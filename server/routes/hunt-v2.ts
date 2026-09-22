import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HUNT_V2_MOVES, HUNT_V2_SCANS } from '../../shared/hunt-v2.js';
import type { HuntV2Command } from '../../shared/hunt-v2.js';
import type { HuntV2Service } from '../services/hunt-v2.js';
import { HuntLobbyError, HuntLobbyService } from '../services/hunt-lobby.js';
import { HuntV2Error } from '../domain/hunt/v2.js';

export interface HuntV2RouteOptions {
  readonly service: HuntV2Service;
  readonly lobby?: HuntLobbyService;
  readonly playerId: (request: FastifyRequest) => string;
}

const idSchema = z.object({ id: z.string().min(1).max(160) }).strict();
const createSchema = z
  .object({ role: z.enum(['whale', 'tracer']), idempotencyKey: z.string().min(1).max(160) })
  .strict();
const joinSchema = z.object({ idempotencyKey: z.string().min(1).max(160) }).strict();
const meta = z.object({
  expectedStateVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(1).max(160),
});
const commandSchema = z.discriminatedUnion('kind', [
  meta
    .extend({
      kind: z.literal('select-whale-plan'),
      zone: z.enum(['A', 'B', 'C']),
      move: z.enum(HUNT_V2_MOVES),
      decoyZone: z.enum(['A', 'B', 'C']).optional(),
    })
    .strict(),
  meta.extend({ kind: z.literal('hide-trade') }).strict(),
  meta
    .extend({
      kind: z.literal('scan'),
      zone: z.enum(['A', 'B', 'C']),
      scan: z.enum(HUNT_V2_SCANS),
    })
    .strict(),
  meta.extend({ kind: z.literal('lock-catch'), zone: z.enum(['A', 'B', 'C']) }).strict(),
  meta.extend({ kind: z.literal('forfeit') }).strict(),
]);
const rematchSchema = z.object({ idempotencyKey: z.string().min(1).max(160) }).strict();
const lobbyJoinSchema = z
  .object({ role: z.enum(['whale', 'tracer']), idempotencyKey: z.string().min(1).max(160) })
  .strict();
const lobbyCancelSchema = z.object({ idempotencyKey: z.string().min(1).max(160) }).strict();

function sendError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof HuntV2Error)
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.stateVersion === undefined ? {} : { stateVersion: error.stateVersion }),
    });
  if (error instanceof HuntLobbyError)
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      retryable: false,
    });
  if (error instanceof z.ZodError)
    return reply
      .code(400)
      .send({ code: 'INVALID_COMMAND', message: 'Invalid Hunt v2 command.', retryable: false });
  throw error;
}

async function safely<T>(reply: FastifyReply, action: () => T | Promise<T>): Promise<T | void> {
  try {
    return await action();
  } catch (error) {
    return sendError(error, reply) as void;
  }
}

/** Registers the Duello HTTP contract. */
export async function registerHuntV2Routes(
  app: FastifyInstance,
  options: HuntV2RouteOptions,
): Promise<void> {
  if (options.lobby) {
    app.post('/api/hunt/v2/lobby', async (request, reply) =>
      safely(reply, () => {
        const command = lobbyJoinSchema.parse(request.body);
        return options.lobby!.join(options.playerId(request), command.role, command.idempotencyKey);
      }),
    );
    app.get('/api/hunt/v2/lobby/:id', async (request, reply) =>
      safely(reply, () =>
        options.lobby!.status(idSchema.parse(request.params).id, options.playerId(request)),
      ),
    );
    app.delete('/api/hunt/v2/lobby/:id', async (request, reply) =>
      safely(reply, () => {
        lobbyCancelSchema.parse(request.body ?? {});
        return options.lobby!.cancel(idSchema.parse(request.params).id, options.playerId(request));
      }),
    );
  }
  app.post('/api/hunt/v2/matches', async (request, reply) =>
    safely(reply, () =>
      options.service.createMatch(options.playerId(request), createSchema.parse(request.body)),
    ),
  );
  app.post('/api/hunt/v2/matches/:id/join', async (request, reply) =>
    safely(reply, () => {
      joinSchema.parse(request.body);
      return options.service.joinMatch(
        idSchema.parse(request.params).id,
        options.playerId(request),
      );
    }),
  );
  app.get('/api/hunt/v2/matches/:id', async (request, reply) =>
    safely(reply, () =>
      options.service.getMatch(idSchema.parse(request.params).id, options.playerId(request)),
    ),
  );
  app.post('/api/hunt/v2/matches/:id/commands', async (request, reply) =>
    safely(reply, () => {
      const command = commandSchema.parse(request.body) as HuntV2Command;
      return options.service.command(
        idSchema.parse(request.params).id,
        options.playerId(request),
        command,
      );
    }),
  );
  app.post('/api/hunt/v2/matches/:id/rematch', async (request, reply) =>
    safely(reply, () =>
      options.service.rematch(
        idSchema.parse(request.params).id,
        options.playerId(request),
        rematchSchema.parse(request.body).idempotencyKey,
      ),
    ),
  );
}
