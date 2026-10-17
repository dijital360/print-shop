import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { OrderSubmission } from "../src/data/shopContract.ts";
import { addWorkingDays, priceQuote } from "../src/lib/quote.ts";
import { TAX_RATE } from "../src/lib/rates.ts";
import { openDatabase } from "./database.ts";
import { ShopRepository } from "./repository.ts";

const INSTANT = new Date("2026-10-15T22:30:00.000Z");
const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const STAFF = { side: "staff" } as const;
const CUSTOMER = { side: "customer", customerHash: OWNER } as const;
const OTHER_CUSTOMER = { side: "customer", customerHash: OTHER_OWNER } as const;
const fixtures: { directory: string; close: () => Promise<void> }[] = [];

function submission(requestKey = "order-request-0001"): OrderSubmission {
  return {
    requestKey,
    customer: { name: "Ada Print Customer", email: "ada@example.test" },
    lines: [{
      id: "line-1",
      config: {
        product: "business-cards",
        material: "silk-350",
        size: "business-card",
        sides: 2,
        finish: "none",
        quantity: 100,
        packaging: "bundled",
        printedProof: false,
        express: false,
        delivery: "collection",
      },
      artwork: { filename: "business-cards.pdf" },
    }],
    deliveryChoice: null,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "print-shop-repository-"));
  let database = await openDatabase({ dataDir: join(directory, "database"), connectionString: "" });
  let clock = new Date(INSTANT);
  const options = { now: () => new Date(clock), timezone: "Europe/Istanbul" };
  let repository = new ShopRepository(database, options);
  fixtures.push({ directory, close: () => database.close() });
  await repository.initialize();
  await repository.ensureCustomerSession(OWNER, INSTANT.getTime() + 86_400_000);
  await repository.ensureCustomerSession(OTHER_OWNER, INSTANT.getTime() + 86_400_000);
  return {
    directory,
    get repository() { return repository; },
    get database() { return database; },
    setNow(instant: Date) { clock = new Date(instant); },
    async reopen() {
      await database.close();
      database = await openDatabase({ dataDir: join(directory, "database"), connectionString: "" });
      repository = new ShopRepository(database, options);
      await repository.initialize();
      return repository;
    },
  };
}

afterEach(async () => {
  for (const { directory, close } of fixtures.splice(0)) {
    try {
      await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("durable shop orders", () => {
  it("starts with no fictional trade and no assumed physical stock", async () => {
    const { repository, database } = await fixture();
    await repository.initialize();
    const snapshot = await repository.snapshot(STAFF);
    expect(snapshot.orders).toEqual([]);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.pastJobs).toEqual([]);
    expect(snapshot.artwork).toEqual([]);
    expect(snapshot.stock.length).toBeGreaterThan(0);
    expect(snapshot.stock.every((row) => row.onHand === 0)).toBe(true);
    expect((await database.query("SELECT id FROM public.customers")).rows).toEqual([]);
    expect(snapshot.now).toEqual({ iso: "2026-10-16", hour: 1, minute: 30 });
    const customerSnapshot = await repository.snapshot(CUSTOMER);
    expect(customerSnapshot.orders).toEqual([]);
    expect(customerSnapshot.jobs).toEqual([]);
  });

  it("persists receipts, exact prices, jobs and ownership after closing the database", async () => {
    const setup = await fixture();
    const input = submission();
    input.lines.push({ ...structuredClone(input.lines[0]!), id: "line-2" });
    input.lines[1]!.config.quantity = 500;
    const receipt = await setup.repository.createOrder(OWNER, input);
    const subtotal = input.lines.reduce((total, line) => total + priceQuote(line.config).subtotalCents, 0);
    expect(receipt.order).toMatchObject({
      customer: input.customer,
      placedOn: "2026-10-16",
      subtotalCents: subtotal,
      taxCents: Math.round(subtotal * TAX_RATE),
      totalCents: subtotal + Math.round(subtotal * TAX_RATE),
    });
    expect(receipt.jobs).toHaveLength(2);
    expect(receipt.order.lines.map((line) => line.jobRef)).toEqual(receipt.jobs.map((job) => job.ref));
    for (const [index, job] of receipt.jobs.entries()) {
      expect(job).toMatchObject({
        customer: input.customer.name,
        quantity: input.lines[index]!.config.quantity,
        promisedFor: receipt.order.lines[index]!.readyBy,
        stage: "ordered",
        proofs: [],
        revision: 0,
      });
    }
    const reopened = await setup.reopen();
    const snapshot = await reopened.snapshot(CUSTOMER);
    expect(snapshot.orders).toEqual([receipt.order]);
    expect(snapshot.jobs).toHaveLength(receipt.jobs.length);
    expect(snapshot.jobs).toEqual(expect.arrayContaining(receipt.jobs));
    expect(await reopened.validCustomerSession(OWNER)).toBe(true);
    expect((await reopened.snapshot(OTHER_CUSTOMER)).orders).toEqual([]);
  });

  it("rejects a bad line atomically and allows correction with the same request key", async () => {
    const { repository } = await fixture();
    const input = submission();
    input.lines.push({ ...structuredClone(input.lines[0]!), id: "line-2" });
    input.lines[1]!.config.quantity = 0;
    await expect(repository.createOrder(OWNER, input)).rejects.toMatchObject({ code: "INVALID_ORDER", status: 400 });
    const after = await repository.snapshot(STAFF);
    expect(after.orders).toEqual([]);
    expect(after.jobs).toEqual([]);
    input.lines[1]!.config.quantity = 250;
    const receipt = await repository.createOrder(OWNER, input);
    expect(receipt.jobs).toHaveLength(2);
    expect((await repository.snapshot(STAFF)).orders).toHaveLength(1);
  });

  it("returns one original receipt for simultaneous retries without creating duplicate jobs", async () => {
    const { repository } = await fixture();
    const input = submission();
    const receipts = await Promise.all(Array.from({ length: 4 }, () => repository.createOrder(OWNER, structuredClone(input))));
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
    const snapshot = await repository.snapshot(STAFF);
    expect(snapshot.orders).toHaveLength(1);
    expect(snapshot.jobs).toHaveLength(1);
  });

  it("refuses to reuse a successful request key for a different basket", async () => {
    const { repository } = await fixture();
    const original = await repository.createOrder(OWNER, submission());
    const changed = submission();
    changed.lines[0]!.config.quantity = 500;
    await expect(repository.createOrder(OWNER, changed)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    const snapshot = await repository.snapshot(CUSTOMER);
    expect(snapshot.orders).toEqual([original.order]);
    expect(snapshot.jobs).toEqual(original.jobs);
  });

  it("allocates distinct references for concurrent multi-line orders", async () => {
    const { repository } = await fixture();
    const inputs = Array.from({ length: 6 }, (_, index) => {
      const input = submission(`concurrent-order-${index}`);
      input.customer.email = `customer-${index}@example.test`;
      input.lines.push({ ...structuredClone(input.lines[0]!), id: "line-2" });
      return input;
    });
    const receipts = await Promise.all(inputs.map((input, index) => repository.createOrder(index % 2 ? OTHER_OWNER : OWNER, input)));
    const refs = receipts.flatMap((receipt) => receipt.jobs.map((job) => job.ref));
    expect(new Set(refs).size).toBe(12);
    expect(new Set(receipts.map((receipt) => receipt.order.ref)).size).toBe(6);
    const snapshot = await repository.snapshot(STAFF);
    expect(snapshot.orders).toHaveLength(6);
    expect(snapshot.jobs).toHaveLength(12);
  });

  it("isolates customer records even if customers submit the same name and email", async () => {
    const { repository } = await fixture();
    const own = await repository.createOrder(OWNER, submission());
    const other = await repository.createOrder(OTHER_OWNER, submission());
    const snapshot = await repository.snapshot(CUSTOMER);
    expect(snapshot.orders).toEqual([own.order]);
    expect(snapshot.jobs).toEqual(own.jobs);
    expect((await repository.snapshot(OTHER_CUSTOMER)).orders).toEqual([other.order]);
    expect((await repository.snapshot(STAFF)).orders).toHaveLength(2);
    await expect(repository.changeJob(CUSTOMER, other.jobs[0]!.ref, 0, { kind: "approve-proof" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("permits production changes only for staff and proof decisions only for the owner", async () => {
    const { repository } = await fixture();
    const receipt = await repository.createOrder(OWNER, submission());
    const job = receipt.jobs[0]!;
    await expect(repository.changeJob(CUSTOMER, job.ref, 0, { kind: "move", column: "printing" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(repository.changeJob(CUSTOMER, job.ref, 0, { kind: "send-proof", note: "Proof" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const proofed = await repository.changeJob(STAFF, job.ref, 0, { kind: "send-proof", note: "First proof" });
    await expect(repository.changeJob(STAFF, job.ref, proofed.revision!, { kind: "approve-proof" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const approved = await repository.changeJob(CUSTOMER, job.ref, proofed.revision!, { kind: "approve-proof" });
    expect(approved.stage).toBe("approved");
    const printing = await repository.changeJob(STAFF, job.ref, approved.revision!, { kind: "move", column: "printing" });
    expect(printing.stage).toBe("printing");
  });

  it("rejects stale revisions without overwriting a more recent production change", async () => {
    const { repository } = await fixture();
    const receipt = await repository.createOrder(OWNER, submission());
    const job = receipt.jobs[0]!;
    const updated = await repository.changeJob(STAFF, job.ref, 0, { kind: "send-proof", note: "Current proof" });
    expect(updated.revision).toBe(1);
    await expect(repository.changeJob(STAFF, job.ref, 0, { kind: "send-proof", note: "Stale tab" }))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([updated]);
  });

  it("requires approval of the latest proof after a replacement is sent", async () => {
    const setup = await fixture();
    let repository = setup.repository;
    const receipt = await repository.createOrder(OWNER, submission());
    let job = receipt.jobs[0]!;
    const originalPromise = job.promisedFor;
    job = await repository.changeJob(STAFF, job.ref, 0, { kind: "send-proof", note: "Version one" });
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "send-proof", note: "Version two" });
    expect(job.stage).toBe("proofed");
    await expect(repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" }))
      .rejects.toMatchObject({ status: 409, code: "PROOF_REQUIRED" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "ask-change", note: "Please revise the colour" });
    expect(job.promisedFor).toBe(addWorkingDays(originalPromise, 1));
    repository = await setup.reopen();
    const persisted = await repository.snapshot(CUSTOMER);
    expect(persisted.jobs).toEqual([job]);
    expect(persisted.jobs[0]!.promisedFor).toBe(addWorkingDays(originalPromise, 1));
    expect(persisted.orders).toEqual([receipt.order]);
    expect(persisted.orders[0]!.readyBy).toBe(receipt.order.readyBy);
    expect(persisted.orders[0]!.lines[0]!.readyBy).toBe(originalPromise);
    await expect(repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" }))
      .rejects.toMatchObject({ status: 409, code: "PROOF_REQUIRED" });
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "send-proof", note: "Version three" });
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" });
    expect(job.stage).toBe("printing");
    expect(job.proofs.filter((proof) => proof.kind === "sent")).toHaveLength(3);
  });

  it("refuses expired sessions instead of accepting an arbitrary owner hash", async () => {
    const { repository, setNow } = await fixture();
    const expired = "c".repeat(64);
    await repository.ensureCustomerSession(expired, INSTANT.getTime() + 1000);
    expect(await repository.validCustomerSession(expired)).toBe(true);
    setNow(new Date(INSTANT.getTime() + 2000));
    expect(await repository.validCustomerSession(expired)).toBe(false);
    await expect(repository.createOrder(expired, submission())).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    await expect(repository.createOrder("d".repeat(64), submission())).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect((await repository.snapshot(STAFF)).orders).toEqual([]);
  });

  it("retains staff credentials and sessions across restarts and revokes logged-out sessions", async () => {
    const setup = await fixture();
    const passwordHash = "scrypt$fixture-password-hash";
    const sessionHash = "e".repeat(64);
    expect(await setup.repository.findStaff("staff@example.test")).toBeNull();
    await setup.repository.createStaff(" Staff@Example.Test ", passwordHash);
    const account = await setup.repository.findStaff("staff@example.test");
    expect(account).toMatchObject({ passwordHash });
    await expect(setup.repository.createStaff("STAFF@example.test", "different-hash"))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await setup.repository.createStaffSession(sessionHash, account!.id, INSTANT.getTime() + 1000);
    expect(await setup.repository.validStaffSession(sessionHash)).toBe(true);
    expect(await setup.repository.validCustomerSession(sessionHash)).toBe(false);
    const reopened = await setup.reopen();
    expect(await reopened.findStaff("STAFF@example.test")).toEqual(account);
    expect(await reopened.validStaffSession(sessionHash)).toBe(true);
    await reopened.deleteStaffSession(sessionHash);
    expect(await reopened.validStaffSession(sessionHash)).toBe(false);
    const secondSession = "f".repeat(64);
    await reopened.createStaffSession(secondSession, account!.id, INSTANT.getTime() + 1000);
    setup.setNow(new Date(INSTANT.getTime() + 2000));
    expect(await reopened.validStaffSession(secondSession)).toBe(false);
  });

  it("preserves existing trade when migrations and initialization run again", async () => {
    const { repository, database } = await fixture();
    await database.query("INSERT INTO public.customers(name,email,town) VALUES('Existing Customer','existing@example.test','Istanbul')");
    await database.query(`INSERT INTO public.jobs(ref,customer_id,product_id,material_id,quantity,trim_width_mm,trim_height_mm,sides,finish_key,packaging_key,stage,promised_for,total)
      VALUES('LEGACY-0001',(SELECT id FROM public.customers WHERE email='existing@example.test'),
        (SELECT id FROM public.products WHERE key='business-cards'),(SELECT id FROM public.materials WHERE key='silk-350'),
        250,85,55,2,'none','bundled','printing','2026-10-20',150.00)`);
    await database.query("UPDATE public.materials SET on_hand=417 WHERE key='silk-350'");
    await repository.initialize();
    const snapshot = await repository.snapshot(STAFF);
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({ ref: "LEGACY-0001", customer: "Existing Customer", quantity: 250, stage: "printing" });
    expect(snapshot.stock.find((row) => row.key === "silk-350")?.onHand).toBe(417);
    expect((await database.query("SELECT name FROM public.customers")).rows).toEqual([{ name: "Existing Customer" }]);
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([]);
  });

  it("prevents concurrent opens of the same embedded database directory", async () => {
    const setup = await fixture();
    await expect(openDatabase({ dataDir: join(setup.directory, "database"), connectionString: "" }))
      .rejects.toThrow(/already open|locked/i);
    const reopened = await setup.reopen();
    expect((await reopened.snapshot(STAFF)).jobs).toEqual([]);
  });

  it("rejects forged prices, unsupported options and invalid numeric ranges without saving trade", async () => {
    const { repository } = await fixture();
    const invalid: unknown[] = [];
    const altered = (change: (input: Record<string, unknown>) => void) => {
      const input = structuredClone(submission()) as unknown as Record<string, unknown>;
      change(input);
      invalid.push(input);
    };
    altered((input) => { input.totalCents = 1; });
    altered((input) => { input.customer = { name: "Customer", email: "not-an-email" }; });
    altered((input) => { input.deliveryChoice = { amount: 0, label: "Forged delivery" }; });
    for (const patch of [
      { price: 1 }, { product: "__proto__" }, { material: "vinyl" }, { sides: 3 },
      { finish: "stretched" }, { packaging: "unsupported" }, { delivery: "unsupported" },
      { quantity: 1.5 }, { quantity: 1_000_001 }, { quantity: Number.NaN },
      { quantity: Number.POSITIVE_INFINITY }, { customWidthMm: Number.NaN },
    ]) {
      const input = submission();
      Object.assign(input.lines[0]!.config, patch);
      invalid.push(input);
    }
    const custom = submission();
    Object.assign(custom.lines[0]!.config, {
      product: "pvc-banners", material: "pvc-510", size: "custom", sides: 1,
      finish: "plain-edges", quantity: 1, customWidthMm: 800, customHeightMm: 2000,
    });
    for (const patch of [
      { quantity: 21 }, { customWidthMm: 0 }, { customWidthMm: 10_000 },
      { customWidthMm: 800.01 }, { customHeightMm: undefined },
    ]) {
      const input = structuredClone(custom);
      Object.assign(input.lines[0]!.config, patch);
      invalid.push(input);
    }
    for (const input of invalid) {
      await expect(repository.createOrder(OWNER, input as OrderSubmission)).rejects.toMatchObject({ status: 400, code: "INVALID_ORDER" });
    }
    const snapshot = await repository.snapshot(STAFF);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.orders).toEqual([]);
  });

  it("rolls back every write if the second production job fails inside the transaction", async () => {
    const { repository, database } = await fixture();
    await database.exec(`CREATE FUNCTION public.reject_test_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.quantity=500 THEN RAISE EXCEPTION 'Injected second-job failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_test_job BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.reject_test_job();`);
    const input = submission();
    input.lines.push({ ...structuredClone(input.lines[0]!), id: "line-2" });
    input.lines[1]!.config.quantity = 500;
    await expect(repository.createOrder(OWNER, input)).rejects.toThrow("Injected second-job failure");
    for (const table of ["print_shop.orders", "public.jobs", "public.customers"]) {
      expect((await database.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
    await database.exec("DROP TRIGGER reject_test_job ON public.jobs; DROP FUNCTION public.reject_test_job();");
    const receipt = await repository.createOrder(OWNER, input);
    expect(receipt.jobs).toHaveLength(2);
    expect((await repository.snapshot(STAFF)).orders).toHaveLength(1);
  });

  it("persists spoilage and collection and keeps completed jobs out of the active board", async () => {
    const setup = await fixture();
    const receipt = await setup.repository.createOrder(OWNER, submission());
    let job = receipt.jobs[0]!;
    await expect(setup.repository.changeJob(STAFF, job.ref, 0, { kind: "collect" })).rejects.toMatchObject({ status: 409 });
    job = await setup.repository.changeJob(STAFF, job.ref, 0, { kind: "spoilage", sheets: 3 });
    expect(job.spoiledSheets).toBe(3);
    job = await setup.repository.changeJob(STAFF, job.ref, job.revision!, { kind: "send-proof", note: "Ready for review" });
    job = await setup.repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await setup.repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "ready" });
    job = await setup.repository.changeJob(STAFF, job.ref, job.revision!, { kind: "collect" });
    expect(job).toMatchObject({ stage: "collected", spoiledSheets: 3, dispatch: { kind: "collected", at: INSTANT.toISOString() } });
    const reopened = await setup.reopen();
    const snapshot = await reopened.snapshot(CUSTOMER);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.pastJobs).toEqual([job]);
    expect(snapshot.orders).toEqual([receipt.order]);
    expect((await setup.database.query("SELECT kind,sheets FROM public.stock_movements")).rows).toEqual([{ kind: "spoilage", sheets: 3 }]);
    await expect(reopened.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" })).rejects.toMatchObject({ status: 409 });
    await expect(reopened.changeJob(STAFF, job.ref, job.revision!, { kind: "spoilage", sheets: 1 })).rejects.toMatchObject({ status: 409 });
  });
});
