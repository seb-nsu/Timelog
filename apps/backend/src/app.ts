import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  type ZodTypeProvider,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { API_PREFIX } from '@timelog/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import type { Mailer } from './mailer.js';
import { RateLimiter } from './rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { daysRoutes } from './routes/days.js';
import { deviceRoutes } from './routes/devices.js';
import { eventRoutes } from './routes/events.js';
import { requireAuth } from './routes/guard.js';
import type { AccessClaims } from './security/jwt.js';
import { TokenSigner } from './security/jwt.js';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface AppOptions {
  db: Db;
  mailer: Mailer;
  jwtSecret: string;
  totpKey: Buffer;
  appUrl: string;
  logLevel?: string;
  trustProxy?: boolean;
  /** Uhr für Tests; Standard Date.now. */
  now?: () => number;
  /** Anfragen je Minute: /auth/* je IP und Konto (10), /events und /presence je Gerät (60). */
  limits?: { auth: number; device: number };
}

export interface AppContext {
  db: Db;
  mailer: Mailer;
  signer: TokenSigner;
  totpKey: Buffer;
  appUrl: string;
  now: () => number;
  limiter: RateLimiter;
  limits: { auth: number; device: number };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessClaims | null;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Zählt einen Treffer und wirft 429, wenn das Limit erreicht ist. */
export function limit(ctx: AppContext, reply: FastifyReply, key: string, max: number): void {
  const retry = ctx.limiter.hit(key, max, 60_000);
  if (retry !== undefined) {
    void reply.header('retry-after', String(retry));
    throw new HttpError(429, 'rate_limited');
  }
}

export const BODY_LIMIT = 256 * 1024;

export async function buildApp(options: AppOptions): Promise<App> {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    trustProxy: options.trustProxy ?? false,
    logger: {
      level: options.logLevel ?? 'info',
      // Keine personenbezogenen Inhalte: Bodies werden nie geloggt, Tokens geschwärzt.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);

  const now = options.now ?? Date.now;
  const ctx: AppContext = {
    db: options.db,
    mailer: options.mailer,
    signer: new TokenSigner(options.jwtSecret),
    totpKey: options.totpKey,
    appUrl: options.appUrl,
    now,
    limiter: new RateLimiter(now),
    limits: options.limits ?? { auth: 10, device: 60 },
  };

  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: err.validation
          .map((v) => `${v.instancePath || '/'} ${v.message ?? ''}`)
          .join('; '),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err: { message: err.message } }, 'response serialization failed');
      return reply.code(500).send({ error: 'internal_error' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const code = (err as { code?: string }).code;
      return reply.code(status).send({
        error: status === 413 ? 'payload_too_large' : 'bad_request',
        message: code ?? 'bad request',
      });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'TimeLog API',
        version: '0.1.0',
        description: 'Automatische Arbeitszeiterfassung: Ereignisse rein, Arbeitstage raus.',
      },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });

  app.get('/health', { schema: { hide: true } }, async () => {
    await options.db.execute(sql`select 1`);
    return { ok: true };
  });

  await app.register(
    async (api) => {
      await api.register((scope, _opts, done) => {
        authRoutes(scope, ctx);
        done();
      });
      await api.register((scope, _opts, done) => {
        scope.addHook('onRequest', requireAuth(ctx));
        deviceRoutes(scope, ctx);
        eventRoutes(scope, ctx);
        daysRoutes(scope, ctx);
        done();
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
