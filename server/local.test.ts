// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_JOB_FILE_BYTES } from "../src/data/shopContract.ts";
import { createLocalShopServer } from "./local.ts";
import type { ShopRepository } from "./repository.ts";

const HTML = "<!doctype html><html><head><title>Dijital360</title></head><body>Yerel baskı uygulaması</body></html>";
const JAVASCRIPT = "export const shop = 'Dijital360';\n";
const CSS = "body { color: #123456; }\n";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>';
const OUTSIDE = "outside-dist-private-fixture";
const INSTANCE = "local-instance-fixture";
const servers: Server[] = [];
const directories: string[] = [];

interface LocalResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }
interface RequestOptions { method?: string; headers?: Record<string, string>; body?: string | Buffer }

function mockRepository() {
  const customers = new Map<string, number>();
  return {
    ensureCustomerSession: vi.fn(async (hash: string, expiresAt: number) => { customers.set(hash, expiresAt); }),
    validCustomerSession: vi.fn(async (hash: string) => (customers.get(hash) ?? 0) > Date.now()),
    validStaffSession: vi.fn(async () => false),
    snapshot: vi.fn(async () => ({ now: {}, works: {}, orders: [], jobs: [], pastJobs: [], stock: [], artwork: [], catalogueProducts: [], catalogueOrders: [] })),
    createOrder: vi.fn(async (owner: string, submission: unknown) => ({ owner, submission })),
    uploadJobFile: vi.fn(async (scope: unknown, ref: string, revision: number, input: unknown) => ({ scope, ref, revision, input })),
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "print-shop-local-"));
  directories.push(directory);
  const distDir = join(directory, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await Promise.all([
    writeFile(join(distDir, "index.html"), HTML),
    writeFile(join(distDir, "assets", "app.js"), JAVASCRIPT),
    writeFile(join(distDir, "assets", "app.css"), CSS),
    writeFile(join(distDir, "assets", "logo.svg"), SVG),
    writeFile(join(directory, "private.txt"), OUTSIDE),
  ]);
  const repository = mockRepository();
  const server = createLocalShopServer(repository as unknown as ShopRepository, { distDir, instanceId: INSTANCE });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const request = (path: string, options: RequestOptions = {}): Promise<LocalResponse> => new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host, connection: "close", ...options.headers };
    const body = typeof options.body === "string" ? Buffer.from(options.body) : options.body;
    if (body && headers["content-length"] === undefined && headers["transfer-encoding"] === undefined) headers["content-length"] = String(body.byteLength);
    const outgoing = httpRequest({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("Local test request timed out.")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  const customer = async () => {
    const response = await request("/api/shop/bootstrap?side=customer");
    const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    return { response, cookie };
  };
  return { directory, distDir, repository, request, customer, port, host, origin };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("portable local shop server", () => {
  it("serves the SPA for navigation with safe headers and correct HEAD lengths", async () => {
    const { request } = await fixture();
    for (const path of ["/", "/index.html", "/staff", "/catalogue", "/orders/customer-history"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe(HTML);
      expect(response.headers["content-type"]).toMatch(/^text\/html\b/);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    }
    const head = await request("/staff", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(HTML)));
    expect(head.headers["content-type"]).toMatch(/^text\/html\b/);
    expect(head.headers["cache-control"]).toBe("no-store");
  });

  it("serves real JS, CSS and SVG assets with their MIME types instead of HTML", async () => {
    const { request } = await fixture();
    for (const [path, body, mime] of [
      ["/assets/app.js", JAVASCRIPT, /^(?:text|application)\/javascript\b/],
      ["/assets/app.css", CSS, /^text\/css\b/],
      ["/assets/logo.svg", SVG, /^image\/svg\+xml\b/],
    ] as const) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe(body);
      expect(response.headers["content-type"]).toMatch(mime);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-cache");
      const head = await request(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      expect(head.body.byteLength).toBe(0);
    }
  });

  it("returns 404 for missing assets and rejects writes to static routes", async () => {
    const { request } = await fixture();
    for (const path of ["/assets/missing.js", "/missing.css", "/favicon.ico"]) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.body.toString()).not.toBe(HTML);
    }
    for (const path of ["/", "/staff", "/assets/app.js"]) {
      const response = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(405);
      expect(String(response.headers.allow).split(/\s*,\s*/)).toEqual(["GET", "HEAD"]);
      expect(response.body.toString()).not.toBe(HTML);
    }
  });

  it("keeps API authentication and JSON 404s behind the same local origin", async () => {
    const { request, repository } = await fixture();
    const health = await request("/api/shop/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString())).toEqual({ ok: true });
    expect(health.headers["cache-control"]).toBe("no-store");
    const unauthorized = await request("/api/shop/bootstrap?side=staff");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(JSON.parse(unauthorized.body.toString())).toEqual({ error: { code: "AUTH_REQUIRED" } });
    expect(repository.snapshot).not.toHaveBeenCalled();
    for (const path of ["/api", "/api/unknown", "/api/shop/missing.js"]) {
      const missing = await request(path);
      expect(missing.status).toBe(404);
      expect(missing.headers["content-type"]).toMatch(/^application\/json\b/);
      expect(JSON.parse(missing.body.toString())).toEqual({ error: { code: "NOT_FOUND" } });
    }
  });

  it("returns instance identity without issuing cookies or granting staff access", async () => {
    const { request, repository } = await fixture();
    const response = await request("/__print-shop-instance");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual({ application: "dijital360-print-shop", instanceId: INSTANCE });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(repository.ensureCustomerSession).not.toHaveBeenCalled();
    expect(repository.snapshot).not.toHaveBeenCalled();
    expect((await request("/api/shop/bootstrap?side=staff")).status).toBe(401);
    const mutation = await request("/__print-shop-instance", { method: "POST" });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.allow).toBe("GET");
    expect(mutation.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects Host rebinding on static, API and instance routes before granting sessions", async () => {
    const { request, port, host, repository } = await fixture();
    const paths = ["/", "/assets/app.js", "/api/shop/health", "/api/shop/bootstrap?side=customer", "/__print-shop-instance"];
    for (const forgedHost of ["attacker.example", `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port === 65535 ? 1 : port + 1}`]) {
      for (const path of paths) {
        const response = await request(path, { headers: { host: forgedHost, "x-forwarded-host": host } });
        expect(response.status).toBe(403);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    }
    expect(repository.ensureCustomerSession).not.toHaveBeenCalled();
    expect((await request("/", { headers: { "x-forwarded-host": "attacker.example" } })).status).toBe(200);
  });

  it("issues customer cookies and requires the exact dynamically bound origin for mutations", async () => {
    const { request, customer, repository, origin } = await fixture();
    const guest = await customer();
    expect(guest.response.status).toBe(200);
    expect(guest.cookie).toMatch(/^print_shop_customer=/);
    const fullCookie = guest.response.headers["set-cookie"]![0]!;
    expect(fullCookie).toContain("Path=/api/shop; HttpOnly; SameSite=Lax");
    expect(fullCookie).not.toContain("; Secure");
    const token = guest.cookie.split("=")[1]!;
    const owner = createHash("sha256").update(token).digest("hex");
    expect(repository.snapshot).toHaveBeenLastCalledWith({ side: "customer", customerHash: owner });
    const headers = { cookie: guest.cookie, "content-type": "application/json" };
    for (const blockedHeaders of [headers, { ...headers, origin: "http://attacker.example" }, { ...headers, origin, "sec-fetch-site": "cross-site" }]) {
      expect((await request("/api/shop/orders", { method: "POST", headers: blockedHeaders, body: "{}" })).status).toBe(403);
    }
    expect(repository.createOrder).not.toHaveBeenCalled();
    const submission = { requestKey: "local-order-request" };
    const allowed = await request("/api/shop/orders", { method: "POST", headers: { ...headers, origin }, body: JSON.stringify(submission) });
    expect(allowed.status).toBe(201);
    expect(repository.createOrder).toHaveBeenCalledWith(owner, submission);
    expect(allowed.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preserves authenticated API JSON and binary upload size limits", async () => {
    const { request, customer, repository, origin } = await fixture();
    const guest = await customer();
    const json = await request("/api/shop/orders", {
      method: "POST", headers: { cookie: guest.cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(64 * 1024) }),
    });
    expect(json.status).toBe(413);
    expect(JSON.parse(json.body.toString())).toEqual({ error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(repository.createOrder).not.toHaveBeenCalled();
    const binary = await request("/api/shop/jobs/LOCAL-1/files?kind=artwork", {
      method: "POST", headers: {
        cookie: guest.cookie, origin, "content-type": "application/pdf", "content-length": String(MAX_JOB_FILE_BYTES + 1),
        "x-print-shop-revision": "0", "x-print-shop-filename": "artwork.pdf",
      },
    });
    expect(binary.status).toBe(413);
    expect(JSON.parse(binary.body.toString())).toEqual({ error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(repository.uploadJobFile).not.toHaveBeenCalled();
    const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
    const uploaded = await request("/api/shop/jobs/LOCAL-1/files?kind=artwork", {
      method: "POST", headers: {
        cookie: guest.cookie, origin, "content-type": "application/pdf",
        "x-print-shop-revision": "0", "x-print-shop-filename": "artwork.pdf",
      }, body: bytes,
    });
    expect(uploaded.status).toBe(200);
    expect(repository.uploadJobFile).toHaveBeenCalledWith(
      expect.objectContaining({ side: "customer" }), "LOCAL-1", 0,
      { kind: "artwork", filename: "artwork.pdf", mediaType: "application/pdf", bytes },
    );
  });

  it("rejects raw traversal, encoded separators and malformed escapes before URL normalization", async () => {
    const { request } = await fixture();
    for (const path of [
      "/../private.txt", "/assets/../../private.txt", "/%2e%2e/private.txt", "/assets/.%2e/.%2e/private.txt",
      "/assets%2fapp.js", "/assets%5capp.js", "/assets\\app.js", "/%ZZ", "/%C3%28",
      "/%252e%252e/private.txt", "/assets%252fapp.js", "/assets/app.js:secret",
      "/CON", "/aux.txt", "/assets/app.js.", "/assets/app.js%20",
    ]) {
      const response = await request(path);
      expect(response.status).toBe(400);
      expect(response.body.toString()).not.toContain(OUTSIDE);
    }
  });

  it("does not serve files through a directory link escaping the distribution root", async () => {
    const { directory, distDir, request } = await fixture();
    await symlink(directory, join(distDir, "escape"), "junction");
    const response = await request("/escape/private.txt");
    expect([403, 404]).toContain(response.status);
    expect(response.body.toString()).not.toContain(OUTSIDE);
  });
});
