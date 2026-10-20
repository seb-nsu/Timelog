import { z } from 'zod';

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
  APP_URL: z.url().default('http://localhost:5173'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('TimeLog <no-reply@localhost>'),
  TRUST_PROXY: z.stringbool().default(false),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Ungültige Umgebungsvariablen: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
