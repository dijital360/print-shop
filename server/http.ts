import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { JobCommand, OrderSubmission } from "../src/data/shopContract.ts";
import { RepoError, type ShopRepository } from "./repository.ts";

const CUSTOMER_COOKIE = "print_shop_customer";
const STAFF_COOKIE = "print_shop_staff";
const COOKIE_PATH = "/api/shop";
const CUSTOMER_TTL_SECONDS = 30 * 24 * 60 * 60;
const STAFF_TTL_SECONDS = 8 * 60 * 60;
const BODY_LIMIT = 64 * 1024;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

type Repository = Pick<ShopRepository,
  | "ensureCustomerSession" | "validCustomerSession" | "createOrder" | "snapshot"
  | "changeJob" | "findStaff" | "createStaffSession" | "validStaffSession"
  | "deleteStaffSession"
>;

export interface ShopServerOptions {
  /** The browser's exact public origin when served behind a reverse proxy. */
  publicOrigin?: string;
  now?: () => number;
}

class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** Password hashes are salted, deliberately expensive, and self identifying. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Password must contain between 12 and 1024 characters.");
  }
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 1024) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts.slice(0, 4).join("$") !== "scrypt$32768$8$1"
    || !/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[5])) {
    return false;
  }
  const actual = await derivePassword(password, Buffer.from(parts[4], "base64url"));
  const expected = Buffer.from(parts[5], "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const matches = (request.headers.cookie ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function cookie(name: string, value: string, ttl: number, secure: boolean): string {
  return `${name}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=${name === STAFF_COOKIE ? "Strict" : "Lax"}; Max-Age=${ttl}${secure ? "; Secure" : ""}`;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) {
    request.resume();
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  if (Number(request.headers["content-length"]) > BODY_LIMIT) {
    request.resume();
    throw new HttpError("PAYLOAD_TOO_LARGE", 413);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError("PAYLOAD_TOO_LARGE", 413));
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new HttpError("INVALID_REQUEST", 400);
        }
        resolve(value);
      } catch {
        reject(new HttpError("INVALID_REQUEST", 400));
      }
    });
    request.on("error", () => reject(new HttpError("INVALID_REQUEST", 400)));
    request.on("aborted", () => reject(new HttpError("INVALID_REQUEST", 400)));
  });
}

function checkWriteOrigin(request: IncomingMessage, publicOrigin?: string): void {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError("FORBIDDEN", 403);
  }
  const origin = request.headers.origin;
  if (origin) {
    if (publicOrigin) {
      if (origin !== publicOrigin) throw new HttpError("FORBIDDEN", 403);
      return;
    }
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.origin !== origin || parsed.host !== request.headers.host) {
        throw new Error("Origin mismatch");
      }
      return;
    } catch {
      throw new HttpError("FORBIDDEN", 403);
    }
  }
  // Origin-less JSON requests are useful for local administration and tests.
  // Public deployments must use the configured, exact browser origin.
  let localHost = false;
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    localHost = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch { /* Reject malformed or missing hosts. */ }
  if (publicOrigin || !localHost) throw new HttpError("FORBIDDEN", 403);
}

export function createShopServer(repository: Repository, options: ShopServerOptions = {}) {
  const now = options.now ?? Date.now;
  let publicOrigin: string | undefined;
  if (options.publicOrigin) {
    const parsed = new URL(options.publicOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== options.publicOrigin) {
      throw new Error("PRINT_SHOP_PUBLIC_ORIGIN must be an exact HTTP(S) origin.");
    }
    publicOrigin = parsed.origin;
  }
  const secure = publicOrigin?.startsWith("https://") ?? false;
  const attempts = new Map<string, { count: number; expires: number }>();
  let dummyPasswordHash: Promise<string> | undefined;

  function checkLoginLimit(request: IncomingMessage): void {
    const timestamp = now();
    if (attempts.size >= 10_000) {
      for (const [ip, value] of attempts) if (value.expires <= timestamp) attempts.delete(ip);
    }
    const ip = request.socket.remoteAddress ?? "unknown";
    const previous = attempts.get(ip);
    if (previous && previous.expires > timestamp) {
      if (previous.count >= 5) throw new HttpError("RATE_LIMITED", 429);
      previous.count += 1;
    } else {
      if (attempts.size >= 10_000) throw new HttpError("RATE_LIMITED", 429);
      attempts.set(ip, { count: 1, expires: timestamp + 60_000 });
    }
  }

  async function customerHash(request: IncomingMessage): Promise<string> {
    const token = readCookie(request, CUSTOMER_COOKIE);
    const hash = token && sessionHash(token);
    if (!hash || !await repository.validCustomerSession(hash)) {
      throw new HttpError("AUTH_REQUIRED", 401);
    }
    return hash;
  }

  async function staffHash(request: IncomingMessage): Promise<string | undefined> {
    const token = readCookie(request, STAFF_COOKIE);
    const hash = token && sessionHash(token);
    return hash && await repository.validStaffSession(hash) ? hash : undefined;
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = request.method;
      if (method === "GET" && path === "/api/shop/health") {
        send(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && path === "/api/shop/bootstrap") {
        const side = url.searchParams.get("side");
        if (side !== "staff" && side !== "customer") throw new HttpError("INVALID_REQUEST", 400);
        if (side === "staff") {
          if (!await staffHash(request)) throw new HttpError("AUTH_REQUIRED", 401);
          send(response, 200, await repository.snapshot({ side: "staff" }));
        } else {
          const existing = readCookie(request, CUSTOMER_COOKIE);
          let hash = existing && sessionHash(existing);
          if (!hash || !await repository.validCustomerSession(hash)) {
            const token = randomBytes(32).toString("base64url");
            hash = sessionHash(token);
            await repository.ensureCustomerSession(hash, now() + CUSTOMER_TTL_SECONDS * 1000);
            response.setHeader("Set-Cookie", cookie(CUSTOMER_COOKIE, token, CUSTOMER_TTL_SECONDS, secure));
          }
          send(response, 200, await repository.snapshot({ side: "customer", customerHash: hash }));
        }
        return;
      }
      if (method === "POST" || method === "DELETE") checkWriteOrigin(request, publicOrigin);
      if (method === "POST" && path === "/api/shop/staff/session") {
        checkLoginLimit(request);
        const body = await readJson(request) as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || body.email.length > 320
          || typeof body.password !== "string" || body.password.length > 1024) {
          throw new HttpError("AUTH_REQUIRED", 401);
        }
        const account = await repository.findStaff(body.email.trim().toLowerCase());
        dummyPasswordHash ??= hashPassword(randomBytes(32).toString("base64url"));
        const fallbackHash = await dummyPasswordHash;
        const valid = await verifyPassword(body.password, account?.passwordHash ?? fallbackHash);
        if (!account || !valid) throw new HttpError("AUTH_REQUIRED", 401);
        const token = randomBytes(32).toString("base64url");
        await repository.createStaffSession(sessionHash(token), account.id, now() + STAFF_TTL_SECONDS * 1000);
        response.setHeader("Set-Cookie", cookie(STAFF_COOKIE, token, STAFF_TTL_SECONDS, secure));
        send(response, 200, { ok: true });
        return;
      }
      if (method === "DELETE" && path === "/api/shop/staff/session") {
        await readJson(request);
        const token = readCookie(request, STAFF_COOKIE);
        if (token) await repository.deleteStaffSession(sessionHash(token));
        response.setHeader("Set-Cookie", cookie(STAFF_COOKIE, "", 0, secure));
        send(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/api/shop/orders") {
        const hash = await customerHash(request);
        const submission = await readJson(request) as OrderSubmission;
        send(response, 201, await repository.createOrder(hash, submission));
        return;
      }
      const jobMatch = /^\/api\/shop\/jobs\/([^/]+)$/.exec(path);
      if (method === "POST" && jobMatch) {
        const body = await readJson(request) as { revision?: unknown; command?: unknown };
        if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0
          || !body.command || typeof body.command !== "object" || Array.isArray(body.command)) {
          throw new HttpError("INVALID_REQUEST", 400);
        }
        const command = body.command as JobCommand;
        const customerCommand = command.kind === "approve-proof" || command.kind === "ask-change";
        const scope = !customerCommand && await staffHash(request) ? { side: "staff" as const }
          : { side: "customer" as const, customerHash: await customerHash(request) };
        let ref: string;
        try { ref = decodeURIComponent(jobMatch[1]); }
        catch { throw new HttpError("INVALID_REQUEST", 400); }
        send(response, 200, await repository.changeJob(scope, ref, body.revision as number, command));
        return;
      }
      throw new HttpError("NOT_FOUND", 404);
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpError || error instanceof RepoError) {
        send(response, error.status, { error: { code: error.code } });
      } else {
        send(response, 500, { error: { code: "UNAVAILABLE" } });
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}
