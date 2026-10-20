// Integrationstests laufen gegen eine echte PostgreSQL 16:
// TEST_DATABASE_URL gesetzt → diese Instanz, sonst Testcontainers (Docker).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createDatabase, runMigrations } from '../src/db/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;
let adminUrl: string;
let dbName: string;

export async function setup(project: TestProject): Promise<void> {
  if (process.env.TEST_DATABASE_URL) {
    adminUrl = process.env.TEST_DATABASE_URL;
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    adminUrl = container.getConnectionUri();
  }
  dbName = `timelog_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const { db, pool } = createDatabase(url.toString());
  await runMigrations(db);
  await pool.end();
  project.provide('databaseUrl', url.toString());
}

export async function teardown(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
  await container?.stop();
}
