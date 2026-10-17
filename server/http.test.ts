// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderReceipt, OrderSubmission, ShopSnapshot } from "../src/data/shopContract.ts";
import { openDatabase, type Database } from "./database.ts";
import { createShopServer, hashPassword, verifyPassword, type ShopServerOptions } from "./http.ts";
import { RepoError, ShopRepository } from "./repository.ts";

const servers: Server[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenFrom = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1).split(";")[0];
const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

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
      expect(restoredSnapshot.jobs).toEqual(expect.arrayContaining(receipt.jobs));
      const restoredStaff = await fetch(`${restarted.base}/bootstrap?side=staff`, { headers: { cookie: staffCookie } });
      expect(restoredStaff.status).toBe(200);
      expect((await restoredStaff.json() as ShopSnapshot).orders).toEqual([receipt.order]);
      const restoredOther = await fetch(`${restarted.base}/bootstrap?side=customer`, { headers: { cookie: otherCookie } });
      expect((await restoredOther.json() as ShopSnapshot).orders).toEqual([]);
    } finally {
      try { await close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
