import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  FinalAccusationCommand,
  FinishInvestigationCommand,
  HuntCommand,
  PinEvidenceCommand,
  PurchaseScanCommand,
  SelectHuntTargetsCommand,
  SubmitSuspicionCommand,
  SubmitWhalePlanCommand,
} from '../../shared/hunt.js';
import { HuntEngine, HuntError } from '../domain/hunt/index.js';
import { HuntRuleError } from '../domain/hunt/lifecycle.js';

export interface HuntRouteOptions {
  readonly engine: Pick<
    HuntEngine,
    'createRoom' | 'joinRoom' | 'getMatch' | 'command' | 'replay' | 'disconnect' | 'reconnect'
  >;
  readonly replaySummary?: (
    matchId: string,
    playerId: string,
  ) => import('../../shared/hunt.js').HuntReplaySummary;
  readonly playerId?: (request: FastifyRequest) => string | undefined;
  readonly cookieName?: string;
}

const idSchema = z.object({ id: z.string().min(1).max(160) }).strict();
const roomSchema = z.object({ code: z.string().min(1).max(160) }).strict();
const createSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(160),
    maxTracers: z.union([z.literal(1), z.literal(5)]),
  })
  .strict();
const joinSchema = z.object({ idempotencyKey: z.string().min(1).max(160) }).strict();
const commandMeta = z
  .object({
    expectedStateVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();
const targetsSchema = commandMeta
  .extend({
    kind: z.literal('select-targets'),
    primaryAssetId: z.string().min(1).max(160),
    secondaryAssetId: z.string().min(1).max(160),
  })
  .strict();
const planSchema = commandMeta
  .extend({
    kind: z.literal('submit-whale-plan'),
    roundIndex: z.number().int().min(1).max(5),
    action: z.enum(['burst', 'drip', 'blend', 'decoy', 'wait']),
    assetId: z.string().min(1).max(160).optional(),
    units: z.number().int().min(0).max(4),
  })
  .strict();
const scanSchema = commandMeta
  .extend({
    kind: z.literal('purchase-scan'),
    roundIndex: z.number().int().min(1).max(5),
    scanId: z.string().min(1).max(200),
    assetId: z.string().min(1).max(160).optional(),
  })
  .strict();
const pinSchema = commandMeta
  .extend({
    kind: z.literal('pin-evidence'),
    roundIndex: z.number().int().min(1).max(5),
    evidenceId: z.string().min(1).max(200),
  })
  .strict();
const suspicionSchema = commandMeta
  .extend({
    kind: z.literal('submit-suspicion'),
    roundIndex: z.number().int().min(1).max(5),
    primaryAssetId: z.string().min(1).max(160),
    secondaryAssetId: z.string().min(1).max(160),
  })
  .strict();
const finishSchema = commandMeta
  .extend({ kind: z.literal('finish-investigation'), roundIndex: z.number().int().min(1).max(5) })
  .strict();
const accusationSchema = commandMeta
  .extend({
    kind: z.literal('final-accusation'),
    primaryAssetId: z.string().min(1).max(160),
    secondaryAssetId: z.string().min(1).max(160),
  })
  .strict();
const commandSchema = z.discriminatedUnion('kind', [
  targetsSchema,
  planSchema,
  scanSchema,
  pinSchema,
  suspicionSchema,
  finishSchema,
  accusationSchema,
]);

function sendError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof HuntError || error instanceof HuntRuleError)
    return reply.code(error instanceof HuntError ? error.statusCode : 400).send({
      code: error.code,
      message: error.message,
      retryable: error instanceof HuntError ? error.retryable : false,
      ...(error instanceof HuntError && error.stateVersion === undefined
        ? {}
        : { stateVersion: error instanceof HuntError ? error.stateVersion : undefined }),
    });
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      code: 'INVALID_COMMAND',
      message: 'Invalid Hunt command.',
      retryable: false,
    });
  throw error;
}

function identity(request: FastifyRequest, options: HuntRouteOptions): string {
  const playerId =
    options.playerId?.(request) ?? request.cookies?.[options.cookieName ?? 'whale_session'];
  if (!playerId)
    throw new HuntError('FORBIDDEN', 'Start a session before entering Whale Hunt.', 401);
  return playerId;
}

async function safely<T>(reply: FastifyReply, action: () => T | Promise<T>): Promise<T | void> {
  try {
    return await action();
  } catch (error) {
    return sendError(error, reply) as void;
  }
}

/** Registers the Whale Hunt HTTP boundary without owning app startup or cookies. */
export async function registerHuntRoutes(
  app: FastifyInstance,
  options: HuntRouteOptions,
): Promise<void> {
  app.post('/api/hunt/rooms', async (request, reply) =>
    safely(reply, () => {
      const command = createSchema.parse(request.body) as {
        idempotencyKey: string;
        maxTracers: 1 | 5;
      };
      return options.engine.createRoom(identity(request, options), command);
    }),
  );
  app.post('/api/hunt/rooms/:code/join', async (request, reply) =>
    safely(reply, () => {
      const { code } = roomSchema.parse(request.params);
      const command = joinSchema.parse(request.body);
      return options.engine.joinRoom(identity(request, options), code, command);
    }),
  );
  app.get('/api/hunt/matches/:id', async (request, reply) =>
    safely(reply, () =>
      options.engine.getMatch(idSchema.parse(request.params).id, identity(request, options)),
    ),
  );
  app.post('/api/hunt/matches/:id/commands', async (request, reply) =>
    safely(reply, () => {
      const command = commandSchema.parse(request.body) as HuntCommand;
      const id = idSchema.parse(request.params).id;
      const actor = identity(request, options);
      const result = options.engine.command(id, actor, command);
      return 'winner' in result ? result : options.engine.getMatch(id, actor);
    }),
  );
  for (const action of ['disconnect', 'reconnect'] as const) {
    app.post(`/api/hunt/matches/:id/${action}`, async (request, reply) =>
      safely(reply, () => {
        z.object({})
          .strict()
          .parse(request.body ?? {});
        return options.engine[action](
          idSchema.parse(request.params).id,
          identity(request, options),
        );
      }),
    );
  }
  if (options.replaySummary)
    app.get('/api/hunt/matches/:id/replay-summary', async (request, reply) =>
      safely(reply, () =>
        options.replaySummary!(idSchema.parse(request.params).id, identity(request, options)),
      ),
    );
  app.get('/api/hunt/matches/:id/replay', async (request, reply) =>
    safely(reply, () =>
      options.engine.replay(idSchema.parse(request.params).id, identity(request, options)),
    ),
  );
}

export const huntRoutes = registerHuntRoutes;

export type HuntRouteCommand =
  | FinalAccusationCommand
  | FinishInvestigationCommand
  | PinEvidenceCommand
  | PurchaseScanCommand
  | SelectHuntTargetsCommand
  | SubmitSuspicionCommand
  | SubmitWhalePlanCommand;
