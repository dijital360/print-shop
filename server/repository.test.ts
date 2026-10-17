import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_JOB_FILE_BYTES, MAX_JOB_FILES, type OrderSubmission } from "../src/data/shopContract.ts";
import type { Job } from "../src/lib/jobs.ts";
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
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==", "base64");

function pdfFixture(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const PDF = pdfFixture();
const artworkInput = () => ({ kind: "artwork" as const, filename: "artwork.png", mediaType: "image/png", bytes: new Uint8Array(PNG) });
const proofInput = (note = "Proof for review") => ({ kind: "proof" as const, filename: "proof.pdf", mediaType: "application/pdf", bytes: new Uint8Array(PDF), note });
const uploadArtwork = (repository: ShopRepository, job: Job) => repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, artworkInput());
const uploadProof = (repository: ShopRepository, job: Job, note?: string) => repository.uploadJobFile(STAFF, job.ref, job.revision!, proofInput(note));

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
    let job = receipt.jobs[0]!;
    await expect(repository.changeJob(CUSTOMER, job.ref, 0, { kind: "move", column: "printing" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(repository.changeJob(CUSTOMER, job.ref, 0, { kind: "send-proof", note: "Proof" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(repository.changeJob(STAFF, job.ref, 0, { kind: "send-proof", note: "First proof" }))
      .rejects.toMatchObject({ status: 409, code: "PROOF_FILE_REQUIRED" });
    job = await uploadArtwork(repository, job);
    const proofed = await uploadProof(repository, job, "First proof");
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
    const updated = await uploadArtwork(repository, job);
    expect(updated.revision).toBe(1);
    await expect(repository.uploadJobFile(CUSTOMER, job.ref, 0, artworkInput()))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([updated]);
  });

  it("requires approval of the latest proof after a replacement is sent", async () => {
    const setup = await fixture();
    let repository = setup.repository;
    const receipt = await repository.createOrder(OWNER, submission());
    let job = receipt.jobs[0]!;
    const originalPromise = job.promisedFor;
    job = await uploadArtwork(repository, job);
    job = await uploadProof(repository, job, "Version one");
    const firstProof = job.files!.at(-1)!.id;
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    expect(job.proofs.at(-1)?.fileId).toBe(firstProof);
    job = await uploadProof(repository, job, "Version two");
    const replacementProof = job.files!.at(-1)!.id;
    expect(replacementProof).not.toBe(firstProof);
    expect(job.proofs.at(-1)?.fileId).toBe(replacementProof);
    expect(job.stage).toBe("proofed");
    await expect(repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" }))
      .rejects.toMatchObject({ status: 409, code: "PROOF_REQUIRED" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "ask-change", note: "Please revise the colour" });
    expect(job.proofs.at(-1)?.fileId).toBe(replacementProof);
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
    job = await uploadProof(repository, job, "Version three");
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
    job = await uploadArtwork(setup.repository, job);
    job = await uploadProof(setup.repository, job, "Ready for review");
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

  it("persists private file bytes and exposes only metadata in job snapshots", async () => {
    const setup = await fixture();
    const receipt = await setup.repository.createOrder(OWNER, submission());
    const initial = receipt.jobs[0]!;
    const commonName = "Ada's [final] & proof!.png";
    let job = await setup.repository.uploadJobFile(CUSTOMER, initial.ref, initial.revision!, { ...artworkInput(), filename: commonName });
    job = await setup.repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, {
      kind: "artwork", filename: "photograph.jpeg", mediaType: "image/jpeg", bytes: JPEG,
    });
    job = await uploadProof(setup.repository, job, "Please review the uploaded PDF");
    const files = job.files!;
    expect(files[0]!.filename).toBe(commonName);
    expect(files.map((file) => file.mediaType)).toEqual(["image/png", "image/jpeg", "application/pdf"]);
    expect(new Set(files.map((file) => file.id)).size).toBe(3);
    for (const file of files) {
      expect(Object.keys(file).sort()).toEqual(["filename", "id", "kind", "mediaType", "size", "uploadedAt"]);
      expect(file.uploadedAt).toBe(INSTANT.toISOString());
    }
    expect(job.proofs.at(-1)).toMatchObject({ kind: "sent", note: "Please review the uploaded PDF", fileId: files[2]!.id });
    const reopened = await setup.reopen();
    const snapshot = await reopened.snapshot(CUSTOMER);
    expect(snapshot.jobs).toEqual([job]);
    expect(snapshot.orders).toEqual([receipt.order]);
    for (const [index, bytes] of [PNG, JPEG, PDF].entries()) {
      const downloaded = await reopened.readJobFile(CUSTOMER, job.ref, files[index]!.id);
      expect(downloaded.file).toEqual(files[index]);
      expect(downloaded.file.size).toBe(bytes.length);
      expect(Array.from(downloaded.bytes)).toEqual(Array.from(bytes));
      expect(Array.from((await reopened.readJobFile(STAFF, job.ref, files[index]!.id)).bytes)).toEqual(Array.from(bytes));
    }
  });

  it("scopes file uploads and downloads to the owner and staff and restricts upload roles", async () => {
    const { repository } = await fixture();
    let job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    await expect(repository.uploadJobFile(STAFF, job.ref, job.revision!, artworkInput()))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, proofInput()))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(repository.uploadJobFile(OTHER_CUSTOMER, job.ref, job.revision!, artworkInput()))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    job = await uploadArtwork(repository, job);
    const artworkId = job.files![0]!.id;
    await expect(repository.readJobFile(OTHER_CUSTOMER, job.ref, artworkId))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const other = (await repository.createOrder(OTHER_OWNER, submission())).jobs[0]!;
    await expect(repository.readJobFile(OTHER_CUSTOMER, other.ref, artworkId))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(repository.readJobFile(CUSTOMER, job.ref, "00000000-0000-0000-0000-000000000000"))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    job = await uploadProof(repository, job);
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" });
    await expect(repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, artworkInput())).rejects.toMatchObject({ status: 409 });
    await expect(repository.uploadJobFile(STAFF, job.ref, job.revision!, proofInput())).rejects.toMatchObject({ status: 409 });
    expect(Array.from((await repository.readJobFile(CUSTOMER, job.ref, artworkId)).bytes)).toEqual(Array.from(PNG));
  });

  it("rejects unsafe names, MIME mismatches and malformed or truncated files without saving them", async () => {
    const { repository } = await fixture();
    const job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    const zeroWidth = new Uint8Array(PNG);
    zeroWidth.fill(0, 16, 20);
    const invalid = [
      { filename: "../artwork.png" }, { filename: "/artwork.png" }, { filename: "folder\\artwork.png" },
      { filename: "bad\r\nname.png" }, { filename: "bad\u0000name.png" }, { filename: `${"a".repeat(256)}.png` },
      { filename: "artwork.exe" }, { filename: "artwork.pdf" }, { mediaType: "text/html" },
      { mediaType: "application/pdf", filename: "artwork.pdf" },
      { bytes: new Uint8Array() }, { bytes: Buffer.from("<html>not an image</html>") },
      { bytes: PNG.subarray(0, PNG.length - 12) }, { bytes: zeroWidth },
      { filename: "artwork.pdf", mediaType: "application/pdf", bytes: Buffer.from("%PDF-1.4\nMissing the end marker") },
      { filename: "artwork.jpg", mediaType: "image/jpeg", bytes: JPEG.subarray(0, JPEG.length - 2) },
    ];
    for (const patch of invalid) {
      await expect(repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...artworkInput(), ...patch }))
        .rejects.toMatchObject({ status: 400, code: "INVALID_FILE" });
    }
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    expect((await repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...artworkInput(), filename: "Artwork.PNG" })).files)
      .toHaveLength(1);
  });

  it("requires real artwork and file-backed proofs rather than filename metadata or a text-only send", async () => {
    const { repository } = await fixture();
    let job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    expect(job.files ?? []).toEqual([]);
    await expect(uploadProof(repository, job)).rejects.toMatchObject({ status: 409, code: "ARTWORK_REQUIRED" });
    await expect(repository.changeJob(STAFF, job.ref, job.revision!, { kind: "send-proof", note: "No uploaded proof" }))
      .rejects.toMatchObject({ status: 409, code: "PROOF_FILE_REQUIRED" });
    await expect(repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" }))
      .rejects.toMatchObject({ status: 409 });
    job = await uploadArtwork(repository, job);
    await expect(repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" }))
      .rejects.toMatchObject({ status: 409 });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
  });

  it("invalidates approval when replacement artwork arrives and requires a fresh linked proof", async () => {
    const { repository } = await fixture();
    let job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    job = await uploadArtwork(repository, job);
    job = await uploadProof(repository, job, "First artwork proof");
    const oldProofId = job.files!.at(-1)!.id;
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...artworkInput(), filename: "corrected.png" });
    expect(job.stage).toBe("prepress");
    expect(job.proofs.at(-1)?.kind).toBe("change-asked");
    expect(job.proofs.at(-1)?.note).toBeUndefined();
    await expect(repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" })).rejects.toMatchObject({ status: 409 });
    await expect(repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" })).rejects.toMatchObject({ status: 409 });
    expect(Array.from((await repository.readJobFile(CUSTOMER, job.ref, oldProofId)).bytes)).toEqual(Array.from(PDF));
    job = await uploadProof(repository, job, "Corrected artwork proof");
    const newProofId = job.files!.at(-1)!.id;
    expect(newProofId).not.toBe(oldProofId);
    expect(job.proofs.at(-1)?.fileId).toBe(newProofId);
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    expect(job.proofs.at(-1)?.fileId).toBe(newProofId);
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" });
    expect(job.stage).toBe("printing");
  });

  it("accepts only one of two simultaneous uploads based on the same revision", async () => {
    const { repository } = await fixture();
    const job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    const results = await Promise.allSettled([
      repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...artworkInput(), filename: "tab-one.png" }),
      repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...artworkInput(), filename: "tab-two.png" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "CONFLICT", status: 409 });
    const saved = (await repository.snapshot(CUSTOMER)).jobs[0]!;
    expect(saved.revision).toBe(job.revision! + 1);
    expect(saved.files).toHaveLength(1);
    await expect(repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, artworkInput()))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([saved]);
  });

  it("rolls back a proof file when recording its sent event fails", async () => {
    const { repository, database } = await fixture();
    const initial = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    const job = await uploadArtwork(repository, initial);
    await database.exec(`CREATE FUNCTION public.reject_test_proof() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind='sent' THEN RAISE EXCEPTION 'Injected proof-event failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_test_proof BEFORE INSERT ON public.proofs FOR EACH ROW EXECUTE FUNCTION public.reject_test_proof();`);
    await expect(uploadProof(repository, job)).rejects.toThrow("Injected proof-event failure");
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    expect((await database.query("SELECT id FROM print_shop.job_files")).rows).toHaveLength(1);
    expect((await database.query("SELECT id FROM public.proofs")).rows).toEqual([]);
    await database.exec("DROP TRIGGER reject_test_proof ON public.proofs; DROP FUNCTION public.reject_test_proof();");
    const proofed = await uploadProof(repository, job);
    expect(proofed.files).toHaveLength(2);
    expect(proofed.proofs.at(-1)?.fileId).toBe(proofed.files!.at(-1)!.id);
  });

  it("reserves the twentieth file for a final proof and enforces the limit per job", async () => {
    const { repository } = await fixture();
    let job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    for (let index = 0; index < MAX_JOB_FILES - 1; index++) {
      job = await repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...artworkInput(), filename: `version-${index}.png` });
    }
    expect(job.files).toHaveLength(MAX_JOB_FILES - 1);
    await expect(uploadArtwork(repository, job)).rejects.toMatchObject({ status: 409, code: "FILE_LIMIT" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    job = await uploadProof(repository, job, "Final proof for the latest artwork");
    expect(job.files).toHaveLength(MAX_JOB_FILES);
    await expect(uploadArtwork(repository, job)).rejects.toMatchObject({ status: 409, code: "FILE_LIMIT" });
    await expect(uploadProof(repository, job)).rejects.toMatchObject({ status: 409, code: "FILE_LIMIT" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" });
    expect(job.stage).toBe("printing");
    const other = (await repository.createOrder(OWNER, submission("second-job-request"))).jobs[0]!;
    expect((await uploadArtwork(repository, other)).files).toHaveLength(1);
  });

  it("accepts an exact ten-MiB file and rejects an extra byte before saving it", async () => {
    const { repository } = await fixture();
    let job = (await repository.createOrder(OWNER, submission())).jobs[0]!;
    const bytes = new Uint8Array(MAX_JOB_FILE_BYTES);
    bytes.fill(32);
    bytes.set(PDF.subarray(0, PDF.length - 6));
    bytes.set(Buffer.from("%%EOF\n"), bytes.length - 6);
    const input = { kind: "artwork" as const, filename: "large.pdf", mediaType: "application/pdf", bytes };
    const oversized = new Uint8Array(MAX_JOB_FILE_BYTES + 1);
    oversized.set(bytes);
    await expect(repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, { ...input, bytes: oversized }))
      .rejects.toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual([job]);
    job = await repository.uploadJobFile(CUSTOMER, job.ref, job.revision!, input);
    expect(job.files![0]!.size).toBe(MAX_JOB_FILE_BYTES);
    const downloaded = await repository.readJobFile(CUSTOMER, job.ref, job.files![0]!.id);
    expect(downloaded.bytes.length).toBe(MAX_JOB_FILE_BYTES);
    expect(Buffer.from(downloaded.bytes).equals(Buffer.from(bytes))).toBe(true);
  });
});
