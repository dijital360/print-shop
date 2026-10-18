import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BANNER_PRODUCT_DRAFT,
  type CatalogueOrderSubmission,
  type CatalogueProduct,
  type CatalogueProductDraft,
  type CatalogueSelection,
} from "../src/lib/commerce.ts";
import { openDatabase } from "./database.ts";
import { ShopRepository } from "./repository.ts";

const INSTANT = new Date("2026-10-15T22:30:00.000Z");
const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const STAFF = { side: "staff" } as const;
const CUSTOMER = { side: "customer", customerHash: OWNER } as const;
const OTHER_CUSTOMER = { side: "customer", customerHash: OTHER_OWNER } as const;
const fixtures: { directory: string; close: () => Promise<void> }[] = [];

function productDraft(overrides: Partial<CatalogueProductDraft> = {}): CatalogueProductDraft {
  return { ...structuredClone(BANNER_PRODUCT_DRAFT), name: "Özel baskı", ...overrides };
}

function selection(product: CatalogueProduct, overrides: Partial<CatalogueSelection> = {}): CatalogueSelection {
  return {
    productId: product.id, productRevision: product.revision,
    widthMm: 1_000, heightMm: 1_000, quantity: 1, eyeletsPerItem: 0,
    weldEdges: false, hemEdges: false, ...overrides,
  };
}

function submission(product: CatalogueProduct, overrides: Partial<CatalogueSelection> = {}, requestKey = "managed-request-0001"): CatalogueOrderSubmission {
  return { requestKey, customer: { name: "Ada Print Customer", email: "ada@example.test" }, lines: [selection(product, overrides)] };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "print-shop-commerce-"));
  let database = await openDatabase({ dataDir: join(directory, "database"), connectionString: "" });
  const options = { now: () => new Date(INSTANT), timezone: "Europe/Istanbul" };
  let repository = new ShopRepository(database, options);
  fixtures.push({ directory, close: () => database.close() });
  await repository.initialize();
  await repository.ensureCustomerSession(OWNER, INSTANT.getTime() + 86_400_000);
  await repository.ensureCustomerSession(OTHER_OWNER, INSTANT.getTime() + 86_400_000);
  return {
    get repository() { return repository; },
    get database() { return database; },
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
    try { await close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

describe("durable managed catalogue", () => {
  it("seeds Branda once with the agreed net prices", async () => {
    const setup = await fixture();
    const products = await setup.repository.listProducts(STAFF, true);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: "Branda", active: true, calculationMode: "area", revision: 0,
      unitPriceCents: 15_000, minimumOrderCents: 50_000, eyeletPriceCents: 500,
      weldPricePerMetreCents: 2_000, hemPricePerMetreCents: 2_000, taxIncluded: false, taxRateBps: 2_000,
    });
    await setup.repository.initialize();
    const reopened = await setup.reopen();
    expect(await reopened.listProducts(STAFF, true)).toEqual(products);
    expect(await reopened.listProducts(CUSTOMER)).toEqual(products);
    expect((await reopened.snapshot(STAFF)).stock.some((row) => row.key === "catalogue-media")).toBe(false);
  });

  it("persists product edits and soft archives without reseeding or resetting prices", async () => {
    const setup = await fixture();
    const created = await setup.repository.createProduct(productDraft({ calculationMode: "unit", unitPriceCents: 30_000 }));
    expect(created).toMatchObject({ name: "Özel baskı", revision: 0, calculationMode: "unit", unitPriceCents: 30_000 });
    const editedDraft = productDraft({ name: "Düzenlenmiş ürün", calculationMode: "unit", unitPriceCents: 40_000, materialName: "Özel malzeme" });
    const edited = await setup.repository.updateProduct(created.id, created.revision, editedDraft);
    expect(edited).toMatchObject({ ...editedDraft, id: created.id, revision: created.revision + 1 });
    await expect(setup.repository.updateProduct(created.id, created.revision, productDraft()))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    const archived = await setup.repository.updateProduct(edited.id, edited.revision, { ...editedDraft, active: false });
    const banner = (await setup.repository.listProducts(STAFF, true)).find((product) => product.name === "Branda")!;
    const archivedBanner = await setup.repository.updateProduct(banner.id, banner.revision, { ...BANNER_PRODUCT_DRAFT, active: false, unitPriceCents: 19_000 });
    const reopened = await setup.reopen();
    expect(await reopened.listProducts(CUSTOMER)).toEqual([]);
    expect(await reopened.listProducts(CUSTOMER, true)).toEqual([]);
    const all = await reopened.listProducts(STAFF, true);
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([archived, archivedBanner]));
    await reopened.initialize();
    expect(await reopened.listProducts(STAFF, true)).toEqual(all);
  });

  it("rejects invalid product prices and options without changing stored products", async () => {
    const { repository } = await fixture();
    const before = await repository.listProducts(STAFF, true);
    for (const patch of [
      { name: " " }, { calculationMode: "unsupported" }, { unitPriceCents: -1 },
      { minimumOrderCents: -1 }, { eyeletPriceCents: 1.5 }, { weldPricePerMetreCents: Number.NaN },
      { hemPricePerMetreCents: Number.POSITIVE_INFINITY }, { taxRateBps: 10_001 }, { leadDays: -1 },
    ]) {
      const invalid = { ...productDraft(), ...patch } as CatalogueProductDraft;
      await expect(repository.createProduct(invalid)).rejects.toMatchObject({ status: 400 });
      await expect(repository.updateProduct(before[0]!.id, before[0]!.revision, invalid)).rejects.toMatchObject({ status: 400 });
    }
    expect(await repository.listProducts(STAFF, true)).toEqual(before);
  });

  it("prices actual dimensions and finishing on the server and preserves the managed line after edits and reopen", async () => {
    const setup = await fixture();
    const product = (await setup.repository.listProducts(CUSTOMER))[0]!;
    const input = submission(product, { widthMm: 2_000, heightMm: 1_000, quantity: 2, eyeletsPerItem: 4, weldEdges: true, hemEdges: true });
    const quote = await setup.repository.quoteCatalogue(OWNER, input.lines);
    expect(quote).toMatchObject({ currency: "TRY", subtotalCents: 112_000, taxCents: 22_400, totalCents: 134_400, minimumTopUpCents: 0 });
    expect(quote.lines[0]).toMatchObject({ areaSqm: 4, perimeterMetres: 12, baseCents: 60_000, eyeletsCents: 4_000, weldCents: 24_000, hemCents: 24_000 });
    const receipt = await setup.repository.createCatalogueOrder(OWNER, input);
    expect(receipt.order).toMatchObject({ kind: "catalogue", currency: "TRY", customer: input.customer, placedOn: "2026-10-16", subtotalCents: 112_000, taxCents: 22_400, totalCents: 134_400 });
    expect(receipt.jobs).toHaveLength(1);
    const line = receipt.order.lines[0]!;
    const job = receipt.jobs[0]!;
    expect(line).toMatchObject({ ...input.lines[0], productName: "Branda", materialName: "Branda", unitPriceCents: 15_000 });
    expect(line).not.toHaveProperty("config");
    expect(job).toMatchObject({
      ref: line.jobRef, quantity: 2, trimWidthMm: 2_000, trimHeightMm: 1_000,
      materialKey: "catalogue-media", stage: "ordered", promisedFor: line.readyBy,
      revision: 0, catalogueLine: line,
    });
    expect(job.productKey).not.toBe(product.id);
    const normalized = (await setup.database.query<{ product_key: string; material_key: string }>(`SELECT p.key AS product_key,m.key AS material_key FROM public.jobs j
      JOIN public.products p ON p.id=j.product_id JOIN public.materials m ON m.id=j.material_id WHERE j.ref=$1`, [job.ref])).rows[0];
    expect(normalized).toEqual({ product_key: job.productKey, material_key: "catalogue-media" });
    await setup.repository.updateProduct(product.id, product.revision, { ...BANNER_PRODUCT_DRAFT, unitPriceCents: 25_000, materialName: "Changed material", leadDays: 5 });
    const reopened = await setup.reopen();
    const snapshot = await reopened.snapshot(CUSTOMER);
    expect(snapshot.orders).toEqual([]);
    expect(snapshot.catalogueOrders).toEqual([receipt.order]);
    expect(snapshot.jobs).toEqual([job]);
    expect(snapshot.catalogueOrders![0]!.lines[0]).toEqual(line);
    expect((await reopened.snapshot(STAFF)).stock.some((row) => row.key === "catalogue-media")).toBe(false);
  });

  it("supports unit products and explicit tax-inclusive tariffs without applying area pricing", async () => {
    const { repository } = await fixture();
    const product = await repository.createProduct(productDraft({ calculationMode: "unit", unitPriceCents: 10_000, minimumOrderCents: 0, taxIncluded: true }));
    const receipt = await repository.createCatalogueOrder(OWNER, submission(product, { widthMm: 85, heightMm: 55, quantity: 3 }));
    expect(receipt.order).toMatchObject({ currency: "TRY", subtotalCents: 25_000, taxCents: 5_000, totalCents: 30_000 });
    expect(receipt.order.lines[0]).toMatchObject({ calculationMode: "unit", taxIncluded: true, baseCents: 30_000, quantity: 3 });
    expect(receipt.jobs[0]).toMatchObject({ quantity: 3, trimWidthMm: 85, trimHeightMm: 55, catalogueLine: receipt.order.lines[0] });
  });

  it("rejects tampered totals and invalid or stale selections without saving a partial order", async () => {
    const { repository } = await fixture();
    const product = (await repository.listProducts(CUSTOMER))[0]!;
    const quote = await repository.quoteCatalogue(OWNER, [selection(product)]);
    expect(quote).toMatchObject({ subtotalCents: 50_000, taxCents: 10_000, totalCents: 60_000, minimumTopUpCents: 35_000 });
    const forged = { ...submission(product), totalCents: 1 } as CatalogueOrderSubmission;
    await expect(repository.createCatalogueOrder(OWNER, forged)).rejects.toMatchObject({ status: 400 });
    const forgedLine = { ...selection(product), totalCents: 1 } as CatalogueSelection;
    await expect(repository.quoteCatalogue(OWNER, [forgedLine])).rejects.toMatchObject({ status: 400 });
    const invalid = submission(product);
    invalid.lines.push(selection(product, { quantity: 0 }));
    await expect(repository.createCatalogueOrder(OWNER, invalid)).rejects.toMatchObject({ status: 400 });
    await repository.updateProduct(product.id, product.revision, { ...BANNER_PRODUCT_DRAFT, unitPriceCents: 16_000 });
    await expect(repository.createCatalogueOrder(OWNER, submission(product))).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    const snapshot = await repository.snapshot(STAFF);
    expect(snapshot.catalogueOrders).toEqual([]);
    expect(snapshot.jobs).toEqual([]);
  });

  it("replays an accepted request after its product is archived without duplicating or repricing it", async () => {
    const setup = await fixture();
    const product = (await setup.repository.listProducts(CUSTOMER))[0]!;
    const input = submission(product);
    const receipts = await Promise.all(Array.from({ length: 3 }, () => setup.repository.createCatalogueOrder(OWNER, structuredClone(input))));
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
    const archived = await setup.repository.updateProduct(product.id, product.revision, { ...BANNER_PRODUCT_DRAFT, active: false, unitPriceCents: 90_000 });
    const reopened = await setup.reopen();
    expect(await reopened.listProducts(CUSTOMER)).toEqual([]);
    expect(await reopened.createCatalogueOrder(OWNER, input)).toEqual(receipts[0]);
    await expect(reopened.createCatalogueOrder(OWNER, submission(product, { quantity: 2 }))).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(reopened.createCatalogueOrder(OWNER, submission(archived, {}, "new-request-archived")))
      .rejects.toMatchObject({ status: 409, code: "PRODUCT_UNAVAILABLE" });
    const snapshot = await reopened.snapshot(STAFF);
    expect(snapshot.catalogueOrders).toEqual([receipts[0]!.order]);
    expect(snapshot.jobs).toEqual(receipts[0]!.jobs);
  });

  it("scopes managed receipts and production jobs to the customer capability", async () => {
    const setup = await fixture();
    const repository = setup.repository;
    const product = (await repository.listProducts(CUSTOMER))[0]!;
    const own = await repository.createCatalogueOrder(OWNER, submission(product));
    const other = await repository.createCatalogueOrder(OTHER_OWNER, submission(product));
    expect(other.order.ref).not.toBe(own.order.ref);
    expect((await repository.snapshot(CUSTOMER)).catalogueOrders).toEqual([own.order]);
    expect((await repository.snapshot(CUSTOMER)).jobs).toEqual(own.jobs);
    expect((await repository.snapshot(OTHER_CUSTOMER)).catalogueOrders).toEqual([other.order]);
    expect((await repository.snapshot(OTHER_CUSTOMER)).jobs).toEqual(other.jobs);
    expect((await repository.snapshot(STAFF)).catalogueOrders).toHaveLength(2);
    await expect(repository.changeJob(OTHER_CUSTOMER, own.jobs[0]!.ref, 0, { kind: "approve-proof" })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const unknownOwner = "c".repeat(64);
    await expect(repository.quoteCatalogue(unknownOwner, [selection(product)])).rejects.toMatchObject({ status: 401 });
    await expect(repository.createCatalogueOrder(unknownOwner, submission(product))).rejects.toMatchObject({ status: 401 });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64");
    let job = await repository.uploadJobFile(CUSTOMER, own.jobs[0]!.ref, 0, { kind: "artwork", filename: "catalogue-artwork.png", mediaType: "image/png", bytes: png });
    job = await repository.uploadJobFile(STAFF, job.ref, job.revision!, { kind: "proof", filename: "catalogue-proof.png", mediaType: "image/png", bytes: png, note: "Review managed print" });
    expect(job.proofs.at(-1)?.fileId).toBe(job.files!.at(-1)!.id);
    job = await repository.changeJob(CUSTOMER, job.ref, job.revision!, { kind: "approve-proof" });
    job = await repository.changeJob(STAFF, job.ref, job.revision!, { kind: "move", column: "printing" });
    expect(job).toMatchObject({ stage: "printing", catalogueLine: own.order.lines[0] });
    const reopened = await setup.reopen();
    expect((await reopened.snapshot(CUSTOMER)).jobs).toEqual([job]);
    expect((await reopened.snapshot(OTHER_CUSTOMER)).jobs).toEqual(other.jobs);
  });

  it("preserves legacy orders alongside separate catalogue snapshots after restarting", async () => {
    const setup = await fixture();
    const legacy = await setup.repository.createOrder(OWNER, {
      requestKey: "legacy-order-request",
      customer: { name: "Legacy Customer", email: "legacy@example.test" },
      lines: [{ id: "legacy-line", config: {
        product: "business-cards", material: "silk-350", size: "business-card", sides: 2,
        finish: "none", quantity: 100, packaging: "bundled", printedProof: false,
        express: false, delivery: "collection",
      } }],
      deliveryChoice: null,
    });
    const product = (await setup.repository.listProducts(CUSTOMER))[0]!;
    const managed = await setup.repository.createCatalogueOrder(OWNER, submission(product));
    await expect(setup.repository.createCatalogueOrder(OWNER, submission(product, {}, "legacy-order-request")))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(managed.jobs[0]!.ref).not.toBe(legacy.jobs[0]!.ref);
    const reopened = await setup.reopen();
    const snapshot = await reopened.snapshot(CUSTOMER);
    expect(snapshot.orders).toEqual([legacy.order]);
    expect(snapshot.catalogueOrders).toEqual([managed.order]);
    expect(snapshot.jobs).toHaveLength(2);
    expect(snapshot.jobs).toEqual(expect.arrayContaining([...legacy.jobs, ...managed.jobs]));
    expect(snapshot.catalogueOrders![0]!.lines[0]).not.toHaveProperty("config");
  });

  it("rolls back a managed receipt and all jobs if the second production insert fails", async () => {
    const { repository, database } = await fixture();
    const product = (await repository.listProducts(CUSTOMER))[0]!;
    const input = submission(product);
    input.lines.push(selection(product, { quantity: 2 }));
    await database.exec(`CREATE FUNCTION public.reject_test_catalogue_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.quantity=2 THEN RAISE EXCEPTION 'Injected managed-job failure'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_test_catalogue_job BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.reject_test_catalogue_job();`);
    await expect(repository.createCatalogueOrder(OWNER, input)).rejects.toThrow("Injected managed-job failure");
    for (const table of ["print_shop.orders", "public.jobs", "public.customers"]) {
      expect((await database.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
    }
    await database.exec("DROP TRIGGER reject_test_catalogue_job ON public.jobs; DROP FUNCTION public.reject_test_catalogue_job();");
    const receipt = await repository.createCatalogueOrder(OWNER, input);
    expect(receipt.jobs).toHaveLength(2);
    expect((await repository.snapshot(CUSTOMER)).catalogueOrders).toEqual([receipt.order]);
  });
});
