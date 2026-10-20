// expo-sqlite in Tests durch node:sqlite ersetzen (gleiches SQLite, gleiche SQL-Befehle).
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlValue } from '../src/core/store';

export function memoryDb(): SqlDatabase {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  return {
    execAsync: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    runAsync: (sql, params: SqlValue[]) => {
      db.prepare(sql).run(...params);
      return Promise.resolve();
    },
    getAllAsync: <T>(sql: string, params: SqlValue[]) =>
      Promise.resolve(db.prepare(sql).all(...params) as T[]),
    withTransactionAsync: async (task) => {
      if (depth > 0) return task();
      depth += 1;
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth -= 1;
      }
    },
  };
}
