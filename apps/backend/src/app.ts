import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
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
import { type CalendarOptions, CalendarService } from './calendar/service.js';
import type { Db } from './db/index.js';
import { logSerializers } from './log.js';
import type { Mailer } from './mailer.js';
import { RateLimiter } from './rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { calendarCallbackRoutes, calendarRoutes } from './routes/calendar.js';
import { correctionRoutes } from './routes/corrections.js';
import { locationRoutes } from './routes/locations.js';
import { orgExtrasRoutes } from './routes/org/extras.js';
import { projectRoutes } from './routes/projects.js';
import { privacyRoutes } from './routes/privacy.js';
import { profileRoutes } from './routes/profile.js';
import { promptRoutes } from './routes/prompts.js';
import { type PushHook, noPush } from './leave/notify.js';
import { daysRoutes } from './routes/days.js';
import { leaveRoutes } from './routes/leave.js';
import { orgLeaveRoutes } from './routes/org/leave.js';
import { orgPayrollRoutes } from './routes/org/payroll.js';
import { deviceRoutes } from './routes/devices.js';
import { eventRoutes } from './routes/events.js';
import { requireAuth } from './routes/guard.js';
import { invitationRoutes, membershipRoutes } from './routes/membership.js';
import { requireOrgRole } from './routes/org/access.js';
import { orgApprovalRoutes } from './routes/org/approvals.js';
import { orgManageRoutes } from './routes/org/manage.js';
import { ssoRoutes } from './routes/sso.js';
import type { AccessClaims } from './security/jwt.js';
import { TokenSigner } from './security/jwt.js';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface SsoOptions {
  /** Nur für Tests mit lokalem IdP: http statt https erlauben. */
  allowInsecure: boolean;
  /** Liest ein Secret (nur Namen mit Präfix SSO_), Standard: process.env. */
  secret: (name: string) => string | undefined;
  /** Zusätzlich erlaubte Rücksprung-Ursprünge neben ADMIN_URL und APP_URL. */
  redirectOrigins: string[];
}

export interface AppOptions {
  db: Db;
  mailer: Mailer;
  jwtSecret: string;
  totpKey: Buffer;
  networkSecret: string;
  appUrl: string;
  /** Web-Admin (Einladungslinks, SSO-Rücksprung); Standard: appUrl. */
  adminUrl?: string;
  /** Öffentliche Adresse der API (SSO-Callback, SAML-Metadaten); Standard: http://localhost:3000. */
  apiUrl?: string;
  /** Ursprünge, die die API per CORS aufrufen dürfen (z. B. der Web-Admin). */
  corsOrigins?: string[];
  sso?: Partial<SsoOptions>;
  logLevel?: string;
  trustProxy?: boolean;
  /** Uhr für Tests; Standard Date.now. */
  now?: () => number;
  /** Anfragen je Minute: /auth/* je IP und Konto (10), /events und /presence je Gerät (60). */
  limits?: { auth: number; device: number };
  /** Hook-Stelle für Push zu Anträgen (Urlaub, Überstundenabbau); Standard: kein Push. */
  push?: PushHook;
  /** Personio-API (Tests: Attrappe). */
  personio?: Partial<PersonioOptions>;
  /** Kalender-Anbindung: Client-IDs/Secrets aus der Umgebung; fehlt ein Anbieter, ist er aus. */
  calendar?: CalendarOptions;
  /** Vorhandener Dienst (Server teilt ihn mit dem periodischen Abruf); sonst aus `calendar` gebaut. */
  calendarService?: CalendarService;
  /** Homeoffice-Tagespauschale in Cent (Konfiguration, Standard 600 je Tag, höchstens 126000). */
  homeOffice?: { perDayCents: number; maxPerYearCents: number };
}

export interface PersonioOptions {
  baseUrl: string;
  fetch: typeof fetch;
}

export interface AppContext {
  db: Db;
  mailer: Mailer;
  signer: TokenSigner;
  totpKey: Buffer;
  networkSecret: string;
  appUrl: string;
  adminUrl: string;
  apiUrl: string;
  sso: SsoOptions;
  now: () => number;
  limiter: RateLimiter;
  limits: { auth: number; device: number };
  push: PushHook;
  personio: PersonioOptions;
  calendar: CalendarService;
  homeOffice: { perDayCents: number; maxPerYearCents: number };
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
      serializers: logSerializers,
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
    networkSecret: options.networkSecret,
    appUrl: options.appUrl,
    adminUrl: (options.adminUrl ?? options.appUrl).replace(/\/$/, ''),
    apiUrl: (options.apiUrl ?? 'http://localhost:3000').replace(/\/$/, ''),
    sso: {
      allowInsecure: options.sso?.allowInsecure ?? false,
      // Nur Variablen mit Präfix SSO_: ein Admin darf nie andere Secrets (z. B. JWT_SECRET) an einen IdP senden.
      secret:
        options.sso?.secret ??
        ((name) => (/^SSO_[A-Z0-9_]+$/.test(name) ? process.env[name] : undefined)),
      redirectOrigins: options.sso?.redirectOrigins ?? [],
    },
    now,
    limiter: new RateLimiter(now),
    limits: options.limits ?? { auth: 10, device: 60 },
    push: options.push ?? noPush,
    personio: {
      baseUrl: (options.personio?.baseUrl ?? 'https://api.personio.de').replace(/\/$/, ''),
      fetch: options.personio?.fetch ?? ((input, init) => fetch(input, init)),
    },
    calendar:
      options.calendarService ??
      new CalendarService(options.db, options.totpKey, options.calendar ?? {}),
    homeOffice: options.homeOffice ?? { perDayCents: 600, maxPerYearCents: 126_000 },
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

  // SAML-IdPs senden die Antwort als Formular (HTTP-POST-Binding).
  await app.register(formbody, { bodyLimit: 512 * 1024 });
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    await app.register(cors, { origin: options.corsOrigins, maxAge: 600 });
  }

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
        invitationRoutes(scope, ctx);
        ssoRoutes(scope, ctx);
        calendarCallbackRoutes(scope, ctx);
        done();
      });
      await api.register((scope, _opts, done) => {
        scope.addHook('onRequest', requireAuth(ctx));
        deviceRoutes(scope, ctx);
        eventRoutes(scope, ctx);
        daysRoutes(scope, ctx);
        correctionRoutes(scope, ctx);
        profileRoutes(scope, ctx);
        privacyRoutes(scope, ctx);
        promptRoutes(scope, ctx);
        membershipRoutes(scope, ctx);
        leaveRoutes(scope, ctx);
        projectRoutes(scope, ctx);
        locationRoutes(scope, ctx);
        calendarRoutes(scope, ctx);
        void scope.register(
          (org, _o, next) => {
            org.decorateRequest('actor', null);
            org.addHook('onRequest', requireOrgRole(ctx));
            orgManageRoutes(org, ctx);
            orgApprovalRoutes(org, ctx);
            orgLeaveRoutes(org, ctx);
            orgPayrollRoutes(org, ctx);
            orgExtrasRoutes(org, ctx);
            next();
          },
          { prefix: '/org' },
        );
        done();
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
