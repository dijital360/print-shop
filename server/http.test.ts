// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/lib/jobs.ts";
import { BANNER_PRODUCT_DRAFT, type CatalogueProduct, type CatalogueQuote, type CatalogueReceipt, type CatalogueSelection } from "../src/lib/commerce.ts";
import { MAX_JOB_FILE_BYTES, type JobFile, type OrderReceipt, type OrderSubmission, type ShopSnapshot } from "../src/data/shopContract.ts";
import { openDatabase, type Database } from "./database.ts";
import { createShopServer, hashPassword, verifyPassword, type ShopServerOptions } from "./http.ts";
import { RepoError, ShopRepository } from "./repository.ts";

const servers: Server[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenFrom = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1).split(";")[0];
const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const FILE: JobFile = {
  id: "file-1", kind: "proof", filename: "Prova (1).pdf", mediaType: "application/pdf",
  size: PDF_BYTES.length, uploadedAt: "2026-10-17T00:00:00.000Z",
};

function mockRepository() {
  const customers = new Map<string, number>();
  const staff = new Map<string, number>();
  const repository = {
    ensureCustomerSession: vi.fn(async (key: string, expires: number) => { customers.set(key, expires); }),
    validCustomerSession: vi.fn(async (key: string) => (customers.get(key) ?? 0) > Date.now()),
    snapshot: vi.fn(async (scope: { side: string; customerHash?: string }) => ({
      now: {}, works: {}, orders: [], jobs: [], pastJobs: [], stock: [], artwork: [], scope,
    })),
    createOrder: vi.fn(async (owner: string, submission: unknown) => ({ owner, submission })),
    changeJob: vi.fn(async (scope: unknown, ref: string, revision: number, command: unknown) => ({ scope, ref, revision, command })),
    uploadJobFile: vi.fn(async (scope: unknown, ref: string, revision: number, input: unknown) => ({ scope, ref, revision, input })),
    readJobFile: vi.fn(async (_scope: unknown, _ref: string, _fileId: string) => ({ file: FILE, bytes: PDF_BYTES })),
    listProducts: vi.fn(async (_scope: unknown) => [] as CatalogueProduct[]),
    createProduct: vi.fn(async (product: unknown) => ({ id: "banner-1", revision: 0, ...(product as object) })),
    updateProduct: vi.fn(async (id: string, revision: number, product: unknown) => ({ id, revision: revision + 1, ...(product as object) })),
    quoteCatalogue: vi.fn(async (owner: string, lines: unknown) => ({ owner, lines, currency: "TRY", totalCents: 60_000 })),
    createCatalogueOrder: vi.fn(async (owner: string, submission: unknown) => ({ owner, submission })),
    findStaff: vi.fn(async (_email: string): Promise<{ id: string; passwordHash: string } | null> => null),
    createStaffSession: vi.fn(async (key: string, _staffId: string, expires: number) => { staff.set(key, expires); }),
    validStaffSession: vi.fn(async (key: string) => (staff.get(key) ?? 0) > Date.now()),
    deleteStaffSession: vi.fn(async (key: string) => { staff.delete(key); }),
  };
  return { repository, customers, staff };
}

async function start(options: ShopServerOptions = {}) {
  const mock = mockRepository();
  const server = createShopServer(mock.repository as unknown as Parameters<typeof createShopServer>[0], options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shop`;
  const customer = async () => {
    const response = await fetch(`${base}/bootstrap?side=customer`);
    return { response, cookie: cookieFrom(response) };
  };
  return { ...mock, server, base, customer };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("shop HTTP authentication and scope", () => {
  it("issues isolated customer capabilities and never returns staff data without a staff session", async () => {
    const { base, customer, customers, repository } = await start();
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ ok: true });
    const unauthorized = await fetch(`${base}/bootstrap?side=staff`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: { code: "AUTH_REQUIRED" } });
    expect(repository.snapshot).not.toHaveBeenCalled();

    const first = await customer();
    const second = await customer();
    expect(first.cookie).not.toBe(second.cookie);
    expect(first.response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Max-Age=2592000");
    expect(first.response.headers.get("set-cookie")).toContain("Path=/api/shop");
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    const firstHash = hash(tokenFrom(first.cookie));
    const secondHash = hash(tokenFrom(second.cookie));
    expect(customers.has(firstHash)).toBe(true);
    expect(customers.has(tokenFrom(first.cookie))).toBe(false);
    expect(await first.response.json()).toMatchObject({ scope: { side: "customer", customerHash: firstHash } });
    expect(await second.response.json()).toMatchObject({ scope: { side: "customer", customerHash: secondHash } });
    const returning = await fetch(`${base}/bootstrap?side=customer`, { headers: { cookie: first.cookie } });
    expect(returning.headers.get("set-cookie")).toBeNull();
    expect(await returning.json()).toMatchObject({ scope: { customerHash: firstHash } });
  });

  it("requires a valid capability for orders and derives job scope from cookies", async () => {
    const { base, customer, repository } = await start();
    const submission = { requestKey: "request-1", role: "staff", customerHash: "forged" };
    const unauthorized = await fetch(`${base}/orders`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission),
    });
    expect(unauthorized.status).toBe(401);
    const guest = await customer();
    const owner = hash(tokenFrom(guest.cookie));
    const created = await fetch(`${base}/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: guest.cookie }, body: JSON.stringify(submission),
    });
    expect(created.status).toBe(201);
    expect(repository.createOrder).toHaveBeenCalledWith(owner, submission);

    const mutation = await fetch(`${base}/jobs/MP-1`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: guest.cookie },
      body: JSON.stringify({ revision: 2, command: { kind: "approve-proof" }, side: "staff", customerHash: "forged" }),
    });
    expect(mutation.status).toBe(200);
    expect(repository.changeJob).toHaveBeenCalledWith({ side: "customer", customerHash: owner }, "MP-1", 2, { kind: "approve-proof" });
    const forged = await fetch(`${base}/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: `print_shop_customer=${"x".repeat(43)}` }, body: "{}",
    });
    expect(forged.status).toBe(401);
    const invalid = await fetch(`${base}/jobs/MP-1`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: guest.cookie },
      body: JSON.stringify({ revision: -1, command: { kind: "collect" } }),
    });
    expect(invalid.status).toBe(400);
  });

  it("logs staff in, uses staff scope for production commands, and revokes logout sessions", async () => {
    const { base, customer, staff, repository } = await start();
    repository.findStaff.mockResolvedValue({ id: "staff-1", passwordHash: await hashPassword("a strong staff password") });
    const login = await fetch(`${base}/staff/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: " STAFF@EXAMPLE.COM ", password: "a strong staff password" }),
    });
    expect(login.status).toBe(200);
    const staffCookie = cookieFrom(login);
    const staffKey = hash(tokenFrom(staffCookie));
    expect(staff.has(staffKey)).toBe(true);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Max-Age=28800");
    expect(repository.findStaff).toHaveBeenCalledWith("staff@example.com");
    const snapshot = await fetch(`${base}/bootstrap?side=staff`, { headers: { cookie: staffCookie } });
    expect(snapshot.status).toBe(200);
    expect(repository.snapshot).toHaveBeenLastCalledWith({ side: "staff" });
    const guest = await customer();
    await fetch(`${base}/jobs/MP-2`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: `${staffCookie}; ${guest.cookie}` },
      body: JSON.stringify({ revision: 1, command: { kind: "collect" } }),
    });
    expect(repository.changeJob).toHaveBeenLastCalledWith({ side: "staff" }, "MP-2", 1, { kind: "collect" });
    const logout = await fetch(`${base}/staff/session`, {
      method: "DELETE", headers: { "Content-Type": "application/json", cookie: staffCookie }, body: "{}",
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(staff.has(staffKey)).toBe(false);
    expect((await fetch(`${base}/bootstrap?side=staff`, { headers: { cookie: staffCookie } })).status).toBe(401);
  });

  it("uses customer scope for proof actions even when the browser has a valid staff session", async () => {
    const { base, customer, staff, repository } = await start();
    const guest = await customer();
    const staffToken = "s".repeat(43);
    staff.set(hash(staffToken), Date.now() + 60_000);
    const headers = {
      "Content-Type": "application/json", cookie: `${guest.cookie}; print_shop_staff=${staffToken}`,
    };
    for (const command of [{ kind: "approve-proof" }, { kind: "ask-change", note: "Please adjust the proof." }]) {
      const response = await fetch(`${base}/jobs/MP-2`, {
        method: "POST", headers, body: JSON.stringify({ revision: 2, command }),
      });
      expect(response.status).toBe(200);
      expect(repository.changeJob).toHaveBeenLastCalledWith(
        { side: "customer", customerHash: hash(tokenFrom(guest.cookie)) }, "MP-2", 2, command,
      );
    }
  });

  it("returns generic credentials errors and limits attempts before additional password work", async () => {
    let clock = Date.now();
    const { base, repository } = await start({ now: () => clock });
    const attempt = () => fetch(`${base}/staff/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com", password: "wrong password" }),
    });
    for (let index = 0; index < 5; index += 1) {
      const result = await attempt();
      expect(result.status).toBe(401);
      expect(await result.json()).toEqual({ error: { code: "AUTH_REQUIRED" } });
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(repository.findStaff).toHaveBeenCalledTimes(5);
    clock += 60_001;
    expect((await attempt()).status).toBe(401);
    expect(repository.findStaff).toHaveBeenCalledTimes(6);
  });
});

describe("shop HTTP request boundaries", () => {
  it("requires the configured origin, blocks cross-site writes, and secures HTTPS cookies", async () => {
    const { base, customer, repository } = await start({ publicOrigin: "https://shop.example.com" });
    const guest = await customer();
    expect(guest.response.headers.get("set-cookie")).toContain("; Secure");
    const headers = { "Content-Type": "application/json", cookie: guest.cookie };
    expect((await fetch(`${base}/orders`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/orders`, {
      method: "POST", headers: { ...headers, Origin: "https://evil.example.com" }, body: "{}",
    })).status).toBe(403);
    expect((await fetch(`${base}/orders`, {
      method: "POST", headers: { ...headers, Origin: "https://shop.example.com", "Sec-Fetch-Site": "cross-site" }, body: "{}",
    })).status).toBe(403);
    const allowed = await fetch(`${base}/orders`, {
      method: "POST", headers: { ...headers, Origin: "https://shop.example.com" }, body: "{}",
    });
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get("access-control-allow-origin")).toBeNull();
    expect(repository.createOrder).toHaveBeenCalledTimes(1);
  });

  it("requires JSON and enforces bounded, valid object bodies", async () => {
    const { base, customer, repository } = await start();
    const guest = await customer();
    const post = (body: string, contentType = "application/json") => fetch(`${base}/orders`, {
      method: "POST", headers: { cookie: guest.cookie, "Content-Type": contentType }, body,
    });
    expect((await post("{}", "text/plain")).status).toBe(415);
    expect((await post("[")).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    expect((await post("null")).status).toBe(400);
    expect((await post(JSON.stringify({ text: "x".repeat(65536) }))).status).toBe(413);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/orders`, {
        method: "POST", headers: { cookie: guest.cookie, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.write('{"text":"');
      request.write("x".repeat(65536));
      request.end('"}');
    });
    expect(chunkedStatus).toBe(413);
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it("compares an unconfigured browser origin to the request host", async () => {
    const { base, customer } = await start();
    const guest = await customer();
    const headers = { cookie: guest.cookie, "Content-Type": "application/json" };
    expect((await fetch(`${base}/orders`, {
      method: "POST", headers: { ...headers, Origin: "http://evil.example" }, body: "{}",
    })).status).toBe(403);
    expect((await fetch(`${base}/orders`, {
      method: "POST", headers: { ...headers, Origin: new URL(base).origin }, body: "{}",
    })).status).toBe(201);
  });

  it("exposes typed repository errors and hides database failures", async () => {
    const { base, customer, repository } = await start();
    const guest = await customer();
    const create = () => fetch(`${base}/orders`, {
      method: "POST", headers: { cookie: guest.cookie, "Content-Type": "application/json" }, body: "{}",
    });
    repository.createOrder.mockRejectedValueOnce(new RepoError("CONFLICT", 409));
    const conflict = await create();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "CONFLICT" } });
    repository.createOrder.mockRejectedValueOnce(new Error("database password=do-not-expose"));
    const unavailable = await create();
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).toEqual({ error: { code: "UNAVAILABLE" } });
  });
});

describe("staff password hashing", () => {
  it("salts hashes and verifies only the correct password", async () => {
    const first = await hashPassword("a strong staff password");
    const second = await hashPassword("a strong staff password");
    expect(first).not.toBe(second);
    expect(await verifyPassword("a strong staff password", first)).toBe(true);
    expect(await verifyPassword("wrong password", first)).toBe(false);
    expect(await verifyPassword("password", "malformed")).toBe(false);
    expect(await verifyPassword("x".repeat(1025), first)).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow("between 12 and 1024");
  });
});

describe("private job file HTTP transport", () => {
  const uploadHeaders = (cookie: string, overrides: Record<string, string> = {}) => ({
    cookie, "Content-Type": "application/pdf", "X-Print-Shop-Filename": encodeURIComponent("artwork.pdf"),
    "X-Print-Shop-Revision": "0", ...overrides,
  });

  it("chooses upload scope by kind even when both customer and staff cookies exist", async () => {
    const { base, customer, staff, repository } = await start();
    const guest = await customer();
    const staffToken = "t".repeat(43);
    staff.set(hash(staffToken), Date.now() + 60_000);
    const cookies = `${guest.cookie}; print_shop_staff=${staffToken}`;
    const artwork = await fetch(`${base}/jobs/MP-1/files?kind=artwork`, {
      method: "POST", headers: uploadHeaders(cookies), body: PDF_BYTES,
    });
    expect(artwork.status).toBe(200);
    expect(repository.uploadJobFile).toHaveBeenLastCalledWith(
      { side: "customer", customerHash: hash(tokenFrom(guest.cookie)) }, "MP-1", 0,
      { kind: "artwork", filename: "artwork.pdf", mediaType: "application/pdf", bytes: PDF_BYTES },
    );
    const proof = await fetch(`${base}/jobs/MP-1/files?kind=proof`, {
      method: "POST", headers: uploadHeaders(cookies, {
        "X-Print-Shop-Filename": encodeURIComponent("proof.pdf"), "X-Print-Shop-Revision": "2",
        "X-Print-Shop-Note": encodeURIComponent("Please review this proof."),
      }), body: PDF_BYTES,
    });
    expect(proof.status).toBe(200);
    expect(repository.uploadJobFile).toHaveBeenLastCalledWith({ side: "staff" }, "MP-1", 2, {
      kind: "proof", filename: "proof.pdf", mediaType: "application/pdf", bytes: PDF_BYTES,
      note: "Please review this proof.",
    });
    const customerCannotUploadProof = await fetch(`${base}/jobs/MP-1/files?kind=proof`, {
      method: "POST", headers: uploadHeaders(guest.cookie), body: PDF_BYTES,
    });
    expect(customerCannotUploadProof.status).toBe(401);
    const staffCannotUploadArtworkAlone = await fetch(`${base}/jobs/MP-1/files?kind=artwork`, {
      method: "POST", headers: uploadHeaders(`print_shop_staff=${staffToken}`), body: PDF_BYTES,
    });
    expect(staffCannotUploadArtworkAlone.status).toBe(401);
    expect(repository.uploadJobFile).toHaveBeenCalledTimes(2);
  });

  it("checks authentication and the configured origin before accepting upload bytes", async () => {
    const { base, customer, repository } = await start({ publicOrigin: "https://shop.example.com" });
    const guest = await customer();
    const post = (headers: Record<string, string>) => fetch(`${base}/jobs/MP-1/files?kind=artwork`, {
      method: "POST", headers, body: PDF_BYTES,
    });
    expect((await post(uploadHeaders(guest.cookie))).status).toBe(403);
    expect((await post(uploadHeaders(guest.cookie, { Origin: "https://evil.example.com" }))).status).toBe(403);
    expect((await post(uploadHeaders(guest.cookie, {
      Origin: "https://shop.example.com", "Sec-Fetch-Site": "cross-site",
    }))).status).toBe(403);
    // A missing session is rejected before media-type or byte validation.
    expect((await post(uploadHeaders("", {
      Origin: "https://shop.example.com", "Content-Type": "text/plain",
    }))).status).toBe(401);
    const unauthorizedBeforeBody = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/jobs/MP-1/files?kind=artwork`, {
        method: "POST", headers: uploadHeaders("", {
          Origin: "https://shop.example.com", "Content-Length": String(MAX_JOB_FILE_BYTES + 1), Connection: "close",
        }),
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      // Send headers only: authentication must fail without waiting for bytes.
      request.end();
    });
    expect(unauthorizedBeforeBody).toBe(401);
    expect(repository.uploadJobFile).not.toHaveBeenCalled();
    expect((await post(uploadHeaders(guest.cookie, { Origin: "https://shop.example.com" }))).status).toBe(200);
  });

  it("rejects unsupported media, empty bodies, and malformed upload headers", async () => {
    const { base, customer, repository } = await start();
    const guest = await customer();
    const post = (overrides: Record<string, string> = {}, body: Buffer<ArrayBuffer> = PDF_BYTES, query = "kind=artwork") =>
      fetch(`${base}/jobs/MP-1/files?${query}`, { method: "POST", headers: uploadHeaders(guest.cookie, overrides), body });
    for (const type of ["text/html", "image/svg+xml", "application/pdf; charset=utf-8"]) {
      expect((await post({ "Content-Type": type })).status).toBe(415);
    }
    expect((await post({ "Content-Encoding": "gzip" })).status).toBe(415);
    expect((await post({}, Buffer.alloc(0))).status).toBe(400);
    for (const name of ["%", "%0d%0aX-Evil%3Ayes.pdf", "%00file.pdf", "..%2Ffile.pdf", "%20"]) {
      expect((await post({ "X-Print-Shop-Filename": name })).status).toBe(400);
    }
    for (const revision of ["-1", "01", "1.5", "NaN", "9007199254740992", "0,1"]) {
      expect((await post({ "X-Print-Shop-Revision": revision })).status).toBe(400);
    }
    expect((await post({ "X-Print-Shop-Note": "%" })).status).toBe(400);
    expect((await post({ "X-Print-Shop-Note": encodeURIComponent("x".repeat(1001)) })).status).toBe(400);
    expect((await post({}, PDF_BYTES, "kind=artwork&kind=proof")).status).toBe(400);
    expect((await post({}, PDF_BYTES, "kind=unknown")).status).toBe(400);
    const missingFilename = uploadHeaders(guest.cookie) as Record<string, string>;
    delete missingFilename["X-Print-Shop-Filename"];
    expect((await fetch(`${base}/jobs/MP-1/files?kind=artwork`, {
      method: "POST", headers: missingFilename, body: PDF_BYTES,
    })).status).toBe(400);
    expect(repository.uploadJobFile).not.toHaveBeenCalled();
  });

  it("accepts at most 10 MiB and applies the same limit to chunked uploads", async () => {
    const { base, customer, repository } = await start();
    const guest = await customer();
    const headers = uploadHeaders(guest.cookie);
    const endpoint = `${base}/jobs/MP-1/files?kind=artwork`;
    expect((await fetch(endpoint, { method: "POST", headers, body: Buffer.alloc(MAX_JOB_FILE_BYTES) })).status).toBe(200);
    expect((await fetch(endpoint, { method: "POST", headers, body: Buffer.alloc(MAX_JOB_FILE_BYTES + 1) })).status).toBe(413);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(endpoint, {
        method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.write(Buffer.alloc(MAX_JOB_FILE_BYTES));
      request.end(Buffer.from([0]));
    });
    expect(chunkedStatus).toBe(413);
    expect(repository.uploadJobFile).toHaveBeenCalledTimes(1);
  });

  it("requires explicit read scope and serves private files with safe response headers", async () => {
    const { base, customer, staff, repository } = await start();
    const guest = await customer();
    const staffToken = "u".repeat(43);
    staff.set(hash(staffToken), Date.now() + 60_000);
    const headers = { cookie: `${guest.cookie}; print_shop_staff=${staffToken}` };
    const endpoint = `${base}/jobs/MP-1/files/file-1`;
    expect((await fetch(endpoint, { headers })).status).toBe(400);
    expect((await fetch(`${endpoint}?side=customer&side=staff`, { headers })).status).toBe(400);
    expect((await fetch(`${endpoint}?side=staff`, { headers: { cookie: guest.cookie } })).status).toBe(401);
    expect((await fetch(`${endpoint}?side=customer`)).status).toBe(401);
    expect((await fetch(`${endpoint}?side=customer`, { headers: { cookie: `print_shop_staff=${staffToken}` } })).status).toBe(401);
    expect(repository.readJobFile).not.toHaveBeenCalled();
    repository.readJobFile.mockResolvedValueOnce({ file: { ...FILE, filename: "İş (1)'\".pdf" }, bytes: PDF_BYTES });
    const proof = await fetch(`${endpoint}?side=customer`, { headers });
    expect(proof.status).toBe(200);
    expect(repository.readJobFile).toHaveBeenLastCalledWith(
      { side: "customer", customerHash: hash(tokenFrom(guest.cookie)) }, "MP-1", "file-1",
    );
    expect(Buffer.from(await proof.arrayBuffer())).toEqual(PDF_BYTES);
    expect(proof.headers.get("Content-Type")).toBe("application/pdf");
    expect(proof.headers.get("Content-Length")).toBe(String(PDF_BYTES.length));
    expect(proof.headers.get("Content-Disposition")).toBe(
      'inline; filename="__ _1___.pdf"; filename*=UTF-8\'\'%C4%B0%C5%9F%20%281%29%27%22.pdf',
    );
    expect(proof.headers.get("Cache-Control")).toBe("no-store");
    expect(proof.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(proof.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(proof.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(proof.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const download = await fetch(`${endpoint}?side=staff&download=1`, { headers });
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(repository.readJobFile).toHaveBeenLastCalledWith({ side: "staff" }, "MP-1", "file-1");
    repository.readJobFile.mockResolvedValueOnce({ file: { ...FILE, kind: "artwork" }, bytes: PDF_BYTES });
    const original = await fetch(`${endpoint}?side=customer`, { headers });
    expect(original.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });
});

describe("managed catalogue HTTP authorization", () => {
  const lines: CatalogueSelection[] = [{ productId: "banner-1", productRevision: 0,
    widthMm: 1000, heightMm: 1000, quantity: 1, eyeletsPerItem: 0, weldEdges: false, hemEdges: false }];

  it("requires an explicit catalogue side and keeps customer scope when both cookies exist", async () => {
    const { base, customer, staff, repository } = await start();
    expect((await fetch(`${base}/catalogue`)).status).toBe(400);
    expect((await fetch(`${base}/catalogue?side=customer&side=staff`)).status).toBe(400);
    expect((await fetch(`${base}/catalogue?side=customer`)).status).toBe(401);
    expect((await fetch(`${base}/catalogue?side=staff`)).status).toBe(401);
    expect(repository.listProducts).not.toHaveBeenCalled();
    const guest = await customer();
    const staffToken = "v".repeat(43);
    staff.set(hash(staffToken), Date.now() + 60_000);
    const headers = { cookie: `${guest.cookie}; print_shop_staff=${staffToken}` };
    const customerList = await fetch(`${base}/catalogue?side=customer&includeInactive=true`, { headers });
    expect(await customerList.json()).toEqual({ products: [] });
    expect(repository.listProducts).toHaveBeenLastCalledWith({ side: "customer", customerHash: hash(tokenFrom(guest.cookie)) });
    expect((await fetch(`${base}/catalogue?side=staff`, { headers })).status).toBe(200);
    expect(repository.listProducts).toHaveBeenLastCalledWith({ side: "staff" });
  });

  it("requires staff sessions for product writes and protects PUT updates with the origin guard", async () => {
    const origin = "https://shop.example.com";
    const { base, customer, staff, repository } = await start({ publicOrigin: origin });
    const guest = await customer();
    const guestHeaders = { cookie: guest.cookie, Origin: origin, "Content-Type": "application/json" };
    expect((await fetch(`${base}/catalogue`, {
      method: "POST", headers: guestHeaders, body: JSON.stringify(BANNER_PRODUCT_DRAFT),
    })).status).toBe(401);
    expect((await fetch(`${base}/catalogue/banner-1`, {
      method: "PUT", headers: guestHeaders, body: JSON.stringify({ revision: 0, product: BANNER_PRODUCT_DRAFT }),
    })).status).toBe(401);
    expect(repository.createProduct).not.toHaveBeenCalled();
    expect(repository.updateProduct).not.toHaveBeenCalled();
    const staffToken = "w".repeat(43);
    staff.set(hash(staffToken), Date.now() + 60_000);
    const headers = { ...guestHeaders, cookie: `${guest.cookie}; print_shop_staff=${staffToken}` };
    const created = await fetch(`${base}/catalogue`, {
      method: "POST", headers, body: JSON.stringify(BANNER_PRODUCT_DRAFT),
    });
    expect(created.status).toBe(201);
    expect(repository.createProduct).toHaveBeenCalledWith(BANNER_PRODUCT_DRAFT);
    const update = { revision: 0, product: { ...BANNER_PRODUCT_DRAFT, active: false } };
    const updated = await fetch(`${base}/catalogue/banner%2F1`, { method: "PUT", headers, body: JSON.stringify(update) });
    expect(updated.status).toBe(200);
    expect(repository.updateProduct).toHaveBeenCalledWith("banner/1", 0, update.product);
    expect((await fetch(`${base}/catalogue/banner-1`, {
      method: "PUT", headers: { ...headers, Origin: "https://evil.example.com" }, body: JSON.stringify(update),
    })).status).toBe(403);
    expect((await fetch(`${base}/catalogue/banner-1`, {
      method: "PUT", headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify(update),
    })).status).toBe(403);
    for (const body of [null, [], 7, true, "invalid", { product: update.product }, { ...update, revision: -1 }, { ...update, revision: 1.5 },
      { ...update, side: "staff" }, { revision: 0, product: null }]) {
      expect((await fetch(`${base}/catalogue/banner-1`, { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(repository.updateProduct).toHaveBeenCalledTimes(1);
  });

  it("uses customer capabilities for quotes and orders and rejects client quote totals", async () => {
    const { base, customer, staff, repository } = await start();
    const staffToken = "x".repeat(43);
    staff.set(hash(staffToken), Date.now() + 60_000);
    const staffHeaders = { cookie: `print_shop_staff=${staffToken}`, "Content-Type": "application/json" };
    for (const path of ["/catalogue/quote", "/catalogue/orders"]) {
      expect((await fetch(`${base}${path}`, { method: "POST", headers: staffHeaders, body: "{}" })).status).toBe(401);
    }
    expect(repository.quoteCatalogue).not.toHaveBeenCalled();
    expect(repository.createCatalogueOrder).not.toHaveBeenCalled();
    const guest = await customer();
    const owner = hash(tokenFrom(guest.cookie));
    const headers = { ...staffHeaders, cookie: `${guest.cookie}; print_shop_staff=${staffToken}` };
    const quote = await fetch(`${base}/catalogue/quote`, { method: "POST", headers, body: JSON.stringify({ lines }) });
    expect(quote.status).toBe(200);
    expect(repository.quoteCatalogue).toHaveBeenCalledWith(owner, lines);
    for (const body of [null, [], 7, true, "invalid", { lines, totalCents: 1 }, { lines: [] }, { lines: null }, { lines, side: "staff" }]) {
      expect((await fetch(`${base}/catalogue/quote`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(repository.quoteCatalogue).toHaveBeenCalledTimes(1);
    const submission = { requestKey: "catalogue-http-1", customer: { name: "Customer", email: "customer@example.test" }, lines };
    expect((await fetch(`${base}/catalogue/orders`, { method: "POST", headers, body: JSON.stringify(submission) })).status).toBe(201);
    expect(repository.createCatalogueOrder).toHaveBeenCalledWith(owner, submission);
  });
});

describe("persistent shop HTTP workflow", () => {
  it("preserves real orders and authorized sessions across a server and database restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "print-shop-http-"));
    let database: Database | undefined;
    let server: Server | undefined;
    const close = async () => {
      if (server) {
        const running = server;
        server = undefined;
        running.closeAllConnections();
        await new Promise<void>((resolve) => running.close(() => resolve()));
      }
      if (database) {
        const opened = database;
        database = undefined;
        await opened.close();
      }
    };
    const startPersistent = async () => {
      database = await openDatabase({ dataDir: join(directory, "database"), connectionString: "" });
      const repository = new ShopRepository(database);
      await repository.initialize();
      server = createShopServer(repository);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      return { repository, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shop` };
    };
    try {
      const running = await startPersistent();
      // These credentials belong only to this disposable test database.
      const password = "integration test staff password";
      await running.repository.createStaff("staff@example.test", await hashPassword(password));
      const guest = await fetch(`${running.base}/bootstrap?side=customer`);
      const customerCookie = cookieFrom(guest);
      expect((await guest.json() as ShopSnapshot).orders).toEqual([]);
      expect(customerCookie).not.toBe("");
      const submission: OrderSubmission = {
        requestKey: "http-persistent-order-1",
        customer: { name: "Print Customer", email: "customer@example.test" },
        lines: [{
          id: "cards-100",
          config: {
            product: "business-cards", material: "silk-350", size: "business-card", sides: 2,
            finish: "none", quantity: 100, packaging: "bundled", printedProof: false,
            express: false, delivery: "collection",
          },
          artwork: { filename: "cards.pdf" },
        }, {
          id: "cards-500",
          config: {
            product: "business-cards", material: "silk-350", size: "business-card", sides: 2,
            finish: "none", quantity: 500, packaging: "bundled", printedProof: false,
            express: false, delivery: "collection",
          },
          artwork: { filename: "second-cards.pdf" },
        }],
        deliveryChoice: null,
      };
      const created = await fetch(`${running.base}/orders`, {
        method: "POST", headers: { cookie: customerCookie, "Content-Type": "application/json" },
        body: JSON.stringify(submission),
      });
      expect(created.status).toBe(201);
      const receipt = await created.json() as OrderReceipt;
      expect(receipt.order.lines).toHaveLength(2);
      expect(receipt.jobs).toHaveLength(2);
      const ownResponse = await fetch(`${running.base}/bootstrap?side=customer`, { headers: { cookie: customerCookie } });
      const own = await ownResponse.json() as ShopSnapshot;
      expect(own.orders).toEqual([receipt.order]);
      expect(own.jobs).toEqual(expect.arrayContaining(receipt.jobs));
      expect((await fetch(`${running.base}/bootstrap?side=staff`)).status).toBe(401);

      const login = await fetch(`${running.base}/staff/session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "staff@example.test", password }),
      });
      expect(login.status).toBe(200);
      const staffCookie = cookieFrom(login);
      const staffResponse = await fetch(`${running.base}/bootstrap?side=staff`, { headers: { cookie: staffCookie } });
      expect(staffResponse.status).toBe(200);
      expect((await staffResponse.json() as ShopSnapshot).orders).toEqual([receipt.order]);

      const jobRef = receipt.jobs[0]!.ref;
      const bothCookies = `${customerCookie}; ${staffCookie}`;
      const upload = (kind: "artwork" | "proof", revision: number, filename: string, bytes: Buffer<ArrayBuffer> = PDF_BYTES,
        mediaType = "application/pdf") => fetch(`${running.base}/jobs/${jobRef}/files?kind=${kind}`, {
        method: "POST", headers: {
          cookie: bothCookies, "Content-Type": mediaType,
          "X-Print-Shop-Filename": encodeURIComponent(filename), "X-Print-Shop-Revision": String(revision),
          ...(kind === "proof" ? { "X-Print-Shop-Note": encodeURIComponent("Please approve this version.") } : {}),
        }, body: bytes,
      });
      const invalidSignature = await upload("artwork", 0, "wrong.png", PDF_BYTES, "image/png");
      expect(invalidSignature.status).toBe(400);
      const artworkUpload = await upload("artwork", 0, "customer-artwork.pdf");
      expect(artworkUpload.status).toBe(200);
      const artworkJob = await artworkUpload.json() as Job;
      expect(artworkJob.revision).toBe(1);
      const artworkFile = artworkJob.files!.find((file) => file.kind === "artwork")!;
      const proofUpload = await upload("proof", 1, "customer-proof.pdf");
      expect(proofUpload.status).toBe(200);
      const proofJob = await proofUpload.json() as Job;
      expect(proofJob.revision).toBe(2);
      const proofFile = proofJob.files!.find((file) => file.kind === "proof")!;
      expect(proofJob.proofs.at(-1)?.fileId).toBe(proofFile.id);
      const proofDownload = await fetch(`${running.base}/jobs/${jobRef}/files/${proofFile.id}?side=customer`, {
        headers: { cookie: bothCookies },
      });
      expect(proofDownload.status).toBe(200);
      expect(proofDownload.headers.get("Content-Disposition")).toMatch(/^inline;/);
      expect(Buffer.from(await proofDownload.arrayBuffer())).toEqual(PDF_BYTES);
      const originalDownload = await fetch(`${running.base}/jobs/${jobRef}/files/${artworkFile.id}?side=staff`, {
        headers: { cookie: bothCookies },
      });
      expect(originalDownload.status).toBe(200);
      expect(originalDownload.headers.get("Content-Disposition")).toMatch(/^attachment;/);
      expect(Buffer.from(await originalDownload.arrayBuffer())).toEqual(PDF_BYTES);
      const approvedResponse = await fetch(`${running.base}/jobs/${jobRef}`, {
        method: "POST", headers: { cookie: bothCookies, "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 2, command: { kind: "approve-proof" } }),
      });
      expect(approvedResponse.status).toBe(200);
      const approvedJob = await approvedResponse.json() as Job;
      expect(approvedJob.stage).toBe("approved");
      expect(approvedJob.proofs.at(-1)?.fileId).toBe(proofFile.id);

      const otherGuest = await fetch(`${running.base}/bootstrap?side=customer`);
      const otherCookie = cookieFrom(otherGuest);
      const otherSnapshot = await otherGuest.json() as ShopSnapshot;
      expect(otherSnapshot.orders).toEqual([]);
      expect(otherSnapshot.jobs).toEqual([]);
      const forbidden = await fetch(`${running.base}/jobs/${receipt.jobs[0]!.ref}`, {
        method: "POST", headers: { cookie: otherCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0, command: { kind: "approve-proof" } }),
      });
      expect(forbidden.status).toBe(403);
      const staffCannotApproveForAnotherCustomer = await fetch(`${running.base}/jobs/${receipt.jobs[0]!.ref}`, {
        method: "POST", headers: { cookie: `${otherCookie}; ${staffCookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0, command: { kind: "approve-proof" } }),
      });
      expect(staffCannotApproveForAnotherCustomer.status).toBe(403);
      const otherFileRead = await fetch(`${running.base}/jobs/${jobRef}/files/${proofFile.id}?side=customer`, {
        headers: { cookie: `${otherCookie}; ${staffCookie}` },
      });
      expect(otherFileRead.status).toBe(403);
      const mismatchedJobRead = await fetch(`${running.base}/jobs/${receipt.jobs[1]!.ref}/files/${proofFile.id}?side=customer`, {
        headers: { cookie: customerCookie },
      });
      expect(mismatchedJobRead.status).toBe(404);

      const invalid = structuredClone(submission);
      invalid.requestKey = "http-invalid-second-line";
      invalid.lines[1]!.config.quantity = 0;
      expect((await fetch(`${running.base}/orders`, {
        method: "POST", headers: { cookie: customerCookie, "Content-Type": "application/json" },
        body: JSON.stringify(invalid),
      })).status).toBe(400);

      await close();
      const restarted = await startPersistent();
      const restoredCustomer = await fetch(`${restarted.base}/bootstrap?side=customer`, { headers: { cookie: customerCookie } });
      expect(restoredCustomer.status).toBe(200);
      expect(restoredCustomer.headers.get("set-cookie")).toBeNull();
      const restoredSnapshot = await restoredCustomer.json() as ShopSnapshot;
      expect(restoredSnapshot.orders).toEqual([receipt.order]);
      expect(restoredSnapshot.jobs).toHaveLength(2);
      expect(restoredSnapshot.jobs).toEqual(expect.arrayContaining([approvedJob, receipt.jobs[1]!]));
      const persistedProof = await fetch(`${restarted.base}/jobs/${jobRef}/files/${proofFile.id}?side=customer`, {
        headers: { cookie: customerCookie },
      });
      expect(persistedProof.status).toBe(200);
      expect(Buffer.from(await persistedProof.arrayBuffer())).toEqual(PDF_BYTES);
      const persistedArtwork = await fetch(`${restarted.base}/jobs/${jobRef}/files/${artworkFile.id}?side=staff`, {
        headers: { cookie: staffCookie },
      });
      expect(persistedArtwork.status).toBe(200);
      expect(Buffer.from(await persistedArtwork.arrayBuffer())).toEqual(PDF_BYTES);
      const restoredStaff = await fetch(`${restarted.base}/bootstrap?side=staff`, { headers: { cookie: staffCookie } });
      expect(restoredStaff.status).toBe(200);
      expect((await restoredStaff.json() as ShopSnapshot).orders).toEqual([receipt.order]);
      const restoredOther = await fetch(`${restarted.base}/bootstrap?side=customer`, { headers: { cookie: otherCookie } });
      expect((await restoredOther.json() as ShopSnapshot).orders).toEqual([]);

      const staffJson = { cookie: staffCookie, "Content-Type": "application/json" };
      const customerJson = { cookie: customerCookie, "Content-Type": "application/json" };
      const managedDraft = { ...BANNER_PRODUCT_DRAFT, name: "HTTP Branda" };
      const managedResponse = await fetch(`${restarted.base}/catalogue`, {
        method: "POST", headers: staffJson, body: JSON.stringify(managedDraft),
      });
      expect(managedResponse.status).toBe(201);
      const managed = await managedResponse.json() as CatalogueProduct;
      const selection: CatalogueSelection = { productId: managed.id, productRevision: managed.revision,
        widthMm: 2000, heightMm: 1000, quantity: 1, eyeletsPerItem: 4, weldEdges: true, hemEdges: true };
      const quoteResponse = await fetch(`${restarted.base}/catalogue/quote`, {
        method: "POST", headers: customerJson, body: JSON.stringify({ lines: [selection] }),
      });
      expect(quoteResponse.status).toBe(200);
      const outdoorQuote = await quoteResponse.json() as CatalogueQuote;
      expect(outdoorQuote).toMatchObject({ currency: "TRY", subtotalCents: 56_000, taxCents: 11_200, totalCents: 67_200 });
      expect((await fetch(`${restarted.base}/catalogue/quote`, {
        method: "POST", headers: customerJson, body: JSON.stringify({ lines: [{ ...selection, unitPriceCents: 1 }] }),
      })).status).toBe(400);
      const outdoorSubmission = { requestKey: "http-managed-order-1", customer: submission.customer, lines: [selection] };
      expect((await fetch(`${restarted.base}/catalogue/orders`, {
        method: "POST", headers: customerJson, body: JSON.stringify({ ...outdoorSubmission, totalCents: 1 }),
      })).status).toBe(400);
      const outdoorResponse = await fetch(`${restarted.base}/catalogue/orders`, {
        method: "POST", headers: customerJson, body: JSON.stringify(outdoorSubmission),
      });
      expect(outdoorResponse.status).toBe(201);
      const outdoor = await outdoorResponse.json() as CatalogueReceipt;
      expect(outdoor.order).toMatchObject({ kind: "catalogue", subtotalCents: 56_000, taxCents: 11_200, totalCents: 67_200 });
      expect(outdoor.jobs).toHaveLength(1);
      const archivedResponse = await fetch(`${restarted.base}/catalogue/${managed.id}`, {
        method: "PUT", headers: staffJson,
        body: JSON.stringify({ revision: managed.revision, product: { ...managedDraft, active: false, unitPriceCents: 19_900 } }),
      });
      expect(archivedResponse.status).toBe(200);
      expect((await fetch(`${restarted.base}/catalogue/${managed.id}`, {
        method: "PUT", headers: staffJson, body: JSON.stringify({ revision: managed.revision, product: managedDraft }),
      })).status).toBe(409);
      const customerCatalogue = await fetch(`${restarted.base}/catalogue?side=customer`, { headers: { cookie: customerCookie } });
      expect((await customerCatalogue.json() as { products: CatalogueProduct[] }).products.some((product) => product.id === managed.id)).toBe(false);
      const staffCatalogue = await fetch(`${restarted.base}/catalogue?side=staff`, { headers: { cookie: staffCookie } });
      expect((await staffCatalogue.json() as { products: CatalogueProduct[] }).products).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: managed.id, active: false, revision: 1 })]),
      );
      expect((await fetch(`${restarted.base}/catalogue/quote`, {
        method: "POST", headers: customerJson, body: JSON.stringify({ lines: [selection] }),
      })).status).toBe(409);
      const retried = await fetch(`${restarted.base}/catalogue/orders`, {
        method: "POST", headers: customerJson, body: JSON.stringify(outdoorSubmission),
      });
      expect(retried.status).toBe(201);
      expect((await retried.json() as CatalogueReceipt).order).toEqual(outdoor.order);

      await close();
      const finalRestart = await startPersistent();
      const finalCustomer = await fetch(`${finalRestart.base}/bootstrap?side=customer`, { headers: { cookie: customerCookie } });
      const finalSnapshot = await finalCustomer.json() as ShopSnapshot;
      expect(finalSnapshot.orders).toEqual([receipt.order]);
      expect(finalSnapshot.catalogueOrders).toEqual([outdoor.order]);
      expect(finalSnapshot.jobs).toHaveLength(3);
      expect(finalSnapshot.catalogueOrders![0]!.lines[0]!.unitPriceCents).toBe(15_000);
      const isolatedCatalogue = await fetch(`${finalRestart.base}/bootstrap?side=customer`, { headers: { cookie: otherCookie } });
      expect((await isolatedCatalogue.json() as ShopSnapshot).catalogueOrders).toEqual([]);
    } finally {
      try { await close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
