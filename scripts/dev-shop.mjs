import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const api = spawn(process.execPath, ['server/main.ts'], { cwd, stdio: 'inherit', env: process.env });
let apiExited = false;
let vite;
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  api.kill('SIGTERM'); vite?.kill('SIGTERM');
  const deadline = setTimeout(() => { api.kill('SIGKILL'); vite?.kill('SIGKILL'); }, 6000);
  deadline.unref();
}
api.on('error', () => stop(1));
api.on('exit', (code) => { apiExited = true; if (!stopping) stop(code || 1); });
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
try {
  if ((process.env.PRINT_SHOP_API_PORT ?? '4100') !== '4100') throw new Error('dev:shop requires PRINT_SHOP_API_PORT=4100.');
  let ready = false;
  for (let attempt = 0; attempt < 150 && !stopping; attempt += 1) {
    if (apiExited) break;
    try {
      const response = await fetch('http://127.0.0.1:4100/api/shop/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok && !apiExited) { ready = true; break; }
    } catch { /* Wait for the local database to start. */ }
    await delay(200);
  }
  if (!ready || stopping) throw new Error('The order service did not become ready.');
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', '5173', '--strictPort'], {
    cwd, stdio: 'inherit', env: { ...process.env, VITE_PRINT_SHOP_MODE: 'live' },
  });
  vite.on('error', () => stop(1));
  vite.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
} catch (error) {
  if (!stopping) console.error(error instanceof Error ? error.message : 'Development startup failed.');
  stop(1);
}
