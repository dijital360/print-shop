import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.ts';
import type { Database } from './database.ts';
import { hashPassword } from './http.ts';
import { RepoError, ShopRepository } from './repository.ts';

const API_PORT = 4100;
const CADDY_CONFIG = '/app/deploy/Caddyfile.hosted';

export interface HostedConfig {
  publicOrigin: string;
  port: number;
  connectionString: string;
  initialStaff?: { email: string; password: string };
}

/** Only fixed messages from this class may reach hosted startup logs. */
export class HostedStartupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message); this.name = 'HostedStartupError'; this.code = code;
  }
}

function invalid(code: string, message: string): never { throw new HostedStartupError(code, message); }

export function readHostedConfig(env: NodeJS.ProcessEnv): HostedConfig {
  const candidate = env.PRINT_SHOP_PUBLIC_ORIGIN !== undefined ? env.PRINT_SHOP_PUBLIC_ORIGIN
    : env.RAILWAY_PUBLIC_DOMAIN !== undefined ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
      : env.RENDER_EXTERNAL_URL;
  let publicOrigin: string;
  try {
    if (!candidate) throw new Error();
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.origin !== candidate || parsed.username || parsed.password || !parsed.hostname) throw new Error();
    publicOrigin = candidate;
  } catch { return invalid('INVALID_ORIGIN', 'Hosted setup requires an exact HTTPS origin.'); }
  const rawPort = env.PORT ?? '8080';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || port === API_PORT) return invalid('INVALID_PORT', 'Hosted setup requires a valid public TCP port distinct from the internal API port.');
  const connectionString = env.DATABASE_URL;
  try {
    if (!connectionString || connectionString.trim() !== connectionString) throw new Error();
    const parsed = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch { return invalid('DATABASE_REQUIRED', 'Hosted setup requires a valid PostgreSQL DATABASE_URL.'); }
  const email = env.PRINT_SHOP_INITIAL_STAFF_EMAIL;
  const password = env.PRINT_SHOP_INITIAL_STAFF_PASSWORD;
  if ((email === undefined) !== (password === undefined)) return invalid('PARTIAL_STAFF', 'Provide both initial staff credentials together.');
  let initialStaff: HostedConfig['initialStaff'];
  if (email !== undefined && password !== undefined) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || !password) return invalid('INVALID_STAFF', 'Provide a valid initial staff account email and password.');
    initialStaff = { email: normalized, password };
  }
  return { publicOrigin, port, connectionString: connectionString!, ...(initialStaff ? { initialStaff } : {}) };
}

export interface HostedBootstrapDependencies {
  openDatabase?: (options: { connectionString: string }) => Promise<Database>;
}

/** Complete migration and account provisioning before any public listener exists. */
export async function bootstrapHosted(config: HostedConfig, dependencies: HostedBootstrapDependencies = {}): Promise<void> {
  let db: Database | undefined;
  try {
    db = await (dependencies.openDatabase ?? openDatabase)({ connectionString: config.connectionString });
    const repository = new ShopRepository(db);
    await repository.initialize();
    if (config.initialStaff && !await repository.findStaff(config.initialStaff.email)) {
      let passwordHash: string;
      try { passwordHash = await hashPassword(config.initialStaff.password); }
      catch { return invalid('INVALID_STAFF_PASSWORD', 'Initial staff password must contain between 12 and 1024 characters.'); }
      try { await repository.createStaff(config.initialStaff.email, passwordHash); }
      catch (error) {
        // Concurrent starts may create the same account; its password stays intact.
        if (!(error instanceof RepoError) || error.code !== 'CONFLICT' || !await repository.findStaff(config.initialStaff.email)) throw error;
      }
    }
    if (!(await db.query('SELECT 1 FROM print_shop.staff LIMIT 1')).rows.length) return invalid('STAFF_REQUIRED', 'Configure an initial staff account before the first hosted start.');
  } catch (error) {
    if (error instanceof HostedStartupError) throw error;
    throw new HostedStartupError('BOOTSTRAP_FAILED', 'Hosted database initialization failed. Check the database and account settings.');
  } finally {
    if (db) {
      try { await db.close(); }
      catch { throw new HostedStartupError('DATABASE_CLOSE_FAILED', 'Hosted database initialization could not close cleanly.'); }
    }
  }
}

interface ManagedChild { process: ChildProcess; closed: boolean; finished: Promise<void> }

/** Run the private API first, then expose Caddy after the API reports healthy. */
export async function runHosted(config: HostedConfig, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  await bootstrapHosted(config);
  const children: ManagedChild[] = [];
  const abort = new AbortController();
  let stopping = false;
  let finish!: (status: number) => void;
  const completion = new Promise<number>((resolve) => { finish = resolve; });
  const stop = (status: number, signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM'): void => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    for (const child of children) {
      if (!child.closed) { try { child.process.kill(signal); } catch { /* Already gone. */ } }
    }
    void (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(children.map((child) => child.finished)),
          new Promise<void>((resolve) => { deadline = setTimeout(resolve, 10_000); }),
        ]);
        for (const child of children) if (!child.closed) {
          try { child.process.kill('SIGKILL'); } catch { /* Already gone. */ }
          child.process.unref();
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
        finish(status);
      }
    })();
  };
  const onInterrupt = () => stop(130, 'SIGINT');
  const onTerminate = () => stop(143, 'SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const startChild = (executable: string, args: string[], childEnv: NodeJS.ProcessEnv): ManagedChild => {
    const childProcess = spawn(executable, args, { env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    let markFinished!: () => void;
    const child: ManagedChild = { process: childProcess, closed: false, finished: new Promise((resolve) => { markFinished = resolve; }) };
    children.push(child);
    childProcess.once('close', () => { child.closed = true; markFinished(); });
    childProcess.once('error', () => {
      console.error('A hosted service could not start.');
      stop(1);
    });
    childProcess.once('exit', (code, signal) => {
      if (stopping) return;
      console.error('A hosted service stopped unexpectedly.');
      stop(code && code > 0 ? Math.min(code, 255) : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
    return child;
  };
  const apiEnv: NodeJS.ProcessEnv = {
    ...env, NODE_ENV: 'production', DATABASE_URL: config.connectionString,
    PRINT_SHOP_PUBLIC_ORIGIN: config.publicOrigin, PRINT_SHOP_API_HOST: '127.0.0.1', PRINT_SHOP_API_PORT: String(API_PORT),
  };
  delete apiEnv.PRINT_SHOP_INITIAL_STAFF_EMAIL;
  delete apiEnv.PRINT_SHOP_INITIAL_STAFF_PASSWORD;
  try {
    const api = startChild(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], apiEnv);
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${API_PORT}/api/shop/health`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now())))]),
          redirect: 'error',
        });
        const body = await response.json() as { ok?: unknown };
        if (response.ok && body.ok === true && !api.closed && !stopping) { healthy = true; break; }
      } catch { /* The private API may still be starting. */ }
      if (!stopping && Date.now() < deadline) await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(250, deadline - Date.now()));
        function done() { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); }
        abort.signal.addEventListener('abort', done, { once: true });
      });
    }
    if (!stopping) {
      if (!healthy) {
        console.error('The hosted API did not become ready in time.');
        stop(1);
      } else {
        const caddyEnv: NodeJS.ProcessEnv = {
          PATH: env.PATH, TZ: env.TZ, NODE_ENV: 'production',
          XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_DATA_HOME: env.XDG_DATA_HOME,
          PORT: String(config.port), PRINT_SHOP_PUBLIC_ORIGIN: config.publicOrigin,
        };
        startChild('/usr/bin/caddy', ['run', '--config', CADDY_CONFIG, '--adapter', 'caddyfile'], caddyEnv);
      }
    }
  } catch {
    console.error('Hosted services could not start.');
    stop(1);
  }
  return completion;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void (async () => { process.exitCode = await runHosted(readHostedConfig(process.env)); })().catch((error: unknown) => {
    console.error(error instanceof HostedStartupError ? error.message : 'Hosted Print Shop could not start. Check the deployment settings.');
    process.exitCode = 1;
  });
}
