import { buildApp } from './app.js';
import { createDatabase } from './db/index.js';
import { MemoryMailer } from './mailer.js';

/** Erzeugt die OpenAPI-Spezifikation aus den Routen (ohne Datenbankverbindung). */
export async function generateOpenApi(): Promise<string> {
  const { db, pool } = createDatabase('postgres://openapi@localhost:1/none');
  const app = await buildApp({
    db,
    mailer: new MemoryMailer(),
    jwtSecret: 'x'.repeat(32),
    totpKey: Buffer.alloc(32),
    networkSecret: 'n'.repeat(32),
    appUrl: 'http://localhost',
    logLevel: 'silent',
  });
  await app.ready();
  const spec = JSON.stringify(app.swagger(), null, 2) + '\n';
  await app.close();
  await pool.end();
  return spec;
}
