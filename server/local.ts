import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { realpathSync, statSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createShopServer } from './http.ts';
import type { ShopRepository } from './repository.ts';

export interface LocalShopOptions { distDir: string; instanceId: string }

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf',
};

function safeHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function errorResponse(request: IncomingMessage, response: ServerResponse, status: number, code: string, allow?: string): void {
  if (response.headersSent || response.destroyed) return;
  safeHeaders(response);
  if (allow) response.setHeader('Allow', allow);
  const body = JSON.stringify({ error: { code } });
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** Validate the raw target before WHATWG URL normalization can erase traversal. */
function requestPath(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.includes('#')) throw new Error('INVALID_PATH');
  decodeURI(target); // Reject malformed escapes in either the path or query.
  const rawPath = target.split('?', 1)[0]!;
  if (/%(?:2f|5c)/i.test(rawPath)) throw new Error('INVALID_PATH');
  const decoded = decodeURIComponent(rawPath);
  if (/[\u0000-\u001f\u007f\\<>:"|?*]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded)) throw new Error('INVALID_PATH');
  for (const segment of decoded.split('/').filter(Boolean)) {
    if (segment.startsWith('.') || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw new Error('INVALID_PATH');
  }
  return decoded;
}

function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface StaticFile { handle: FileHandle; size: number; filename: string }
async function openStatic(root: string, filename: string): Promise<StaticFile | null> {
  let handle: FileHandle | undefined;
  try {
    const resolved = await realpath(filename);
    if (!inside(root, resolved)) throw new Error('OUTSIDE_DIST');
    // Windows refuses opening directories as files; check before open() so the
    // dist root and route directories can reach the SPA fallback normally.
    if (!(await stat(resolved)).isFile()) return null;
    handle = await open(resolved, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile()) { await handle.close(); return null; }
    return { handle, size: metadata.size, filename: resolved };
  } catch (error) {
    if (handle) await handle.close();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** One loopback listener serves the built app and the existing private API. */
export function createLocalShopServer(repository: ShopRepository, options: LocalShopOptions): Server {
  let distDir: string;
  try {
    distDir = realpathSync(options.distDir);
    if (!statSync(distDir).isDirectory()) throw new Error();
  } catch { throw new Error('The local application files are missing. Extract the complete application package.'); }
  if (typeof options.instanceId !== 'string' || !options.instanceId || options.instanceId.length > 256) throw new Error('The local application instance identifier is invalid.');
  let allowedHost: string | undefined;
  let api: ReturnType<typeof createShopServer> | undefined;

  const server = createServer((request, response) => {
    void (async () => {
      const hostCount = request.rawHeaders.reduce((count, name, index) => count + (index % 2 === 0 && name.toLowerCase() === 'host' ? 1 : 0), 0);
      if (!allowedHost || request.headers.host !== allowedHost || hostCount !== 1
        || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
        errorResponse(request, response, 403, 'FORBIDDEN'); return;
      }
      let pathname: string;
      try { pathname = requestPath(request.url); }
      catch { errorResponse(request, response, 400, 'INVALID_REQUEST'); return; }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!api) errorResponse(request, response, 503, 'UNAVAILABLE');
        else api.emit('request', request, response);
        return;
      }
      if (pathname === '/__print-shop-instance') {
        if (request.method !== 'GET') { errorResponse(request, response, 405, 'METHOD_NOT_ALLOWED', 'GET'); return; }
        safeHeaders(response);
        const body = JSON.stringify({ application: 'dijital360-print-shop', instanceId: options.instanceId });
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
        response.end(body); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume();
        errorResponse(request, response, 405, 'METHOD_NOT_ALLOWED', 'GET, HEAD'); return;
      }
      let file: StaticFile | null = null;
      try {
        const filename = path.resolve(distDir, ...pathname.split('/').filter(Boolean));
        if (!inside(distDir, filename)) { errorResponse(request, response, 403, 'FORBIDDEN'); return; }
        file = await openStatic(distDir, filename);
        const route = pathname.replace(/\/+$/, '');
        const assetPath = route === '/assets' || route.startsWith('/assets/');
        if (!file && !assetPath && path.extname(route) === '') file = await openStatic(distDir, path.join(distDir, 'index.html'));
        if (!file) { errorResponse(request, response, 404, 'NOT_FOUND'); return; }
        const extension = path.extname(file.filename).toLowerCase();
        safeHeaders(response);
        response.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
        response.setHeader('Content-Length', file.size);
        response.setHeader('Cache-Control', extension === '.html' ? 'no-store' : 'no-cache');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        if (request.method === 'HEAD') { await file.handle.close(); file = null; response.end(); return; }
        const stream = file.handle.createReadStream();
        file = null; // The stream owns and closes the descriptor, including aborts.
        await pipeline(stream, response);
      } catch (error) {
        if (file) await file.handle.close();
        const code = (error as NodeJS.ErrnoException).code;
        const forbidden = code === 'EACCES' || code === 'EPERM' || (error instanceof Error && error.message === 'OUTSIDE_DIST');
        errorResponse(request, response, forbidden ? 403 : 500, forbidden ? 'FORBIDDEN' : 'UNAVAILABLE');
      }
    })().catch(() => errorResponse(request, response, 500, 'UNAVAILABLE'));
  });
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      allowedHost = `127.0.0.1:${address.port}`;
      api = createShopServer(repository, { publicOrigin: `http://${allowedHost}` });
    }
  });
  server.on('close', () => { allowedHost = undefined; api = undefined; });
  server.requestTimeout = 90_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
