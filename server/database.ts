import path from 'node:path';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface QueryResult<T> { rows: T[]; rowCount: number }
export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(callback: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PGlite's filesystem belongs to one process, including administration tools. */
async function lockDirectory(dataDir: string): Promise<() => Promise<void>> {
  const lockPath = `${await realpath(dataDir)}.lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token })); }
      catch (error) { await file.close(); await unlink(lockPath); throw error; }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owned = await file.stat();
        await file.close();
        try {
          const current = await stat(lockPath);
          const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
          if (owned.ino === current.ino && owned.dev === current.dev && metadata.token === token) await unlink(lockPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const before = await stat(lockPath);
        const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown; hostname?: unknown };
        if (metadata.hostname === hostname() && typeof metadata.pid === 'number' && Number.isSafeInteger(metadata.pid) && metadata.pid > 0) {
          try { process.kill(metadata.pid, 0); }
          catch (checkError) { stale = (checkError as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        if (stale) {
          const after = await stat(lockPath);
          if (before.ino === after.ino && before.dev === after.dev && before.mtimeMs === after.mtimeMs) await unlink(lockPath);
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Unknown ownership, foreign hosts and malformed metadata stay locked.
      }
      throw new Error(`The local Print Shop database is already open or locked (${lockPath}). Stop the running server before opening another local database process.`);
    }
  }
  throw new Error('Could not acquire the local Print Shop database lock.');
}

/** One adapter for durable local PostgreSQL and a conventional PostgreSQL server. */
export async function openDatabase(options: { dataDir?: string; connectionString?: string } = {}): Promise<Database> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (connectionString) {
    const pool = new pg.Pool({ connectionString });
    const wrap = (client: pg.Pool | pg.PoolClient): Database => ({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await client.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
      async exec(sql) { await client.query(sql); },
      async transaction(callback) {
        if (client !== pool) throw new Error('Nested transactions are not supported.');
        const lease = await pool.connect();
        try {
          await lease.query('BEGIN');
          const result = await callback(wrap(lease));
          await lease.query('COMMIT');
          return result;
        } catch (error) {
          await lease.query('ROLLBACK');
          throw error;
        } finally { lease.release(); }
      },
      async close() { if (client === pool) await pool.end(); },
    });
    const db = wrap(pool);
    try { await db.query('SELECT 1'); }
    catch (error) { await pool.end(); throw error; }
    return db;
  }

  const dataDir = options.dataDir ?? process.env.PRINT_SHOP_DATA_DIR ?? path.resolve('.print-shop.local/database');
  if (dataDir !== 'memory://') await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = dataDir === 'memory://' ? async () => {} : await lockDirectory(dataDir);
  let embedded: PGlite;
  try { embedded = await PGlite.create(dataDir); }
  catch (error) { await release(); throw error; }
  type EmbeddedClient = Pick<PGlite, 'query' | 'exec'>;
  const wrap = (client: EmbeddedClient): Database => ({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql) { await client.exec(sql); },
    async transaction(callback) {
      if (client !== embedded) throw new Error('Nested transactions are not supported.');
      return embedded.transaction((tx) => callback(wrap(tx)));
    },
    async close() {
      if (client === embedded) {
        try { if (!embedded.closed) await embedded.close(); }
        finally { await release(); }
      }
    },
  });
  return wrap(embedded);
}
