import { z } from 'zod';

/** Kommagetrennte Liste, leer = keine Einträge. */
const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET braucht mindestens 32 Zeichen'),
  TOTP_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'TOTP_ENCRYPTION_KEY: 32 Byte als Base64',
    ),
  NETWORK_HMAC_SECRET: z.string().min(32, 'NETWORK_HMAC_SECRET braucht mindestens 32 Zeichen'),
  APP_URL: z.url().default('http://localhost:5173'),
  ADMIN_URL: z.url().optional(),
  API_URL: z.url().default('http://localhost:3000'),
  CORS_ORIGINS: list,
  SSO_REDIRECT_ORIGINS: list,
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('TimeLog <no-reply@localhost>'),
  TRUST_PROXY: z.stringbool().default(false),
  // Kalender-Anbindung (nur lesend); ohne Client-ID ist der Anbieter abgeschaltet
  GOOGLE_CALENDAR_CLIENT_ID: z.string().optional(),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CALENDAR_CLIENT_ID: z.string().optional(),
  MICROSOFT_CALENDAR_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CALENDAR_TENANT: z.string().default('common'),
  CALENDAR_SYNC_INTERVAL_MIN: z.coerce.number().int().min(5).max(1440).default(60),
  // Homeoffice-Tagespauschale (§ 4 Abs. 5 Satz 1 Nr. 6c EStG) in Cent: je Tag und Jahreshöchstbetrag
  HOME_OFFICE_DAY_CENTS: z.coerce.number().int().min(0).default(600),
  HOME_OFFICE_MAX_CENTS: z.coerce.number().int().min(0).default(126_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Ungültige Umgebungsvariablen: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Kalender-Anbieter aus der Umgebung (nur wenn Client-ID und Secret gesetzt sind). */
export function calendarOptionsFrom(env: Env) {
  return {
    ...(env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CALENDAR_CLIENT_ID,
            clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.MICROSOFT_CALENDAR_CLIENT_ID && env.MICROSOFT_CALENDAR_CLIENT_SECRET
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CALENDAR_CLIENT_ID,
            clientSecret: env.MICROSOFT_CALENDAR_CLIENT_SECRET,
            tenant: env.MICROSOFT_CALENDAR_TENANT,
          },
        }
      : {}),
  };
}
