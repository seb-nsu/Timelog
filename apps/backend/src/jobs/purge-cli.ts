import { createDatabase } from '../db/index.js';
import { purgeExpired } from './purge.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL fehlt');
const { db, pool } = createDatabase(url);
const result = await purgeExpired(db, Date.now());
await pool.end();
process.stdout.write(`${JSON.stringify(result)}\n`);
