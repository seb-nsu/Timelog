import { buildApp } from './app.js';
import { createDatabase, runMigrations } from './db/index.js';
import { loadEnv } from './env.js';
import { schedulePurge } from './jobs/purge.js';
import { ConsoleMailer, type Mailer, SmtpMailer } from './mailer.js';

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
await runMigrations(db);

let mailer: Mailer;
if (env.SMTP_URL) mailer = new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
else if (env.NODE_ENV === 'production') throw new Error('SMTP_URL fehlt');
else mailer = new ConsoleMailer();

const app = await buildApp({
  db,
  mailer,
  jwtSecret: env.JWT_SECRET,
  totpKey: Buffer.from(env.TOTP_ENCRYPTION_KEY, 'base64'),
  networkSecret: env.NETWORK_HMAC_SECRET,
  appUrl: env.APP_URL,
  ...(env.ADMIN_URL ? { adminUrl: env.ADMIN_URL } : {}),
  apiUrl: env.API_URL,
  corsOrigins: env.CORS_ORIGINS,
  sso: { redirectOrigins: env.SSO_REDIRECT_ORIGINS },
  logLevel: env.LOG_LEVEL,
  trustProxy: env.TRUST_PROXY,
});

const stopPurge = schedulePurge(db, (msg) => {
  app.log.info(msg);
});

const shutdown = async (): Promise<void> => {
  stopPurge();
  await app.close();
  await pool.end();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: env.HOST, port: env.PORT });
