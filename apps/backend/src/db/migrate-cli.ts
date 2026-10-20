import { createDatabase, runMigrations } from './index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL fehlt');
const { db, pool } = createDatabase(url);
await runMigrations(db);
await pool.end();
process.stdout.write('Migrationen ausgeführt\n');
