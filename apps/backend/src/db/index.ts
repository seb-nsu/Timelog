import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Database {
  db: Db;
  pool: pg.Pool;
}

export function createDatabase(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS });
}

export interface Scope {
  userId: string;
  orgId: string | null;
}

/** Transaktion als API-Rolle mit Row-Level-Security für genau diesen Nutzer. */
export function withUser<T>(db: Db, scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role timelog_app`);
    await tx.execute(
      sql`select set_config('app.user_id', ${scope.userId}, true), set_config('app.org_id', ${scope.orgId ?? ''}, true)`,
    );
    return fn(tx);
  });
}

/** Transaktion ohne Nutzerbezug (Anmeldung, Token-Prüfung). Nur im Auth-Dienst verwenden. */
export function asSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role timelog_app`);
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export { schema };

/**
 * Transaktion als Tabellen-Eigentümer (ohne API-Rolle). Nur für Löschkonzept und Lösch-Job,
 * weil die API-Rolle Ereignisse nicht löschen darf.
 */
export function asOwner<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}
