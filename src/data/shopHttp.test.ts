import { describe, expect, it, vi } from "vitest";
import { createShopHttp, jobFileUrl, ShopRequestError } from "./shopHttp.ts";
import { MAX_JOB_FILE_BYTES } from "./shopContract.ts";
import { BANNER_PRODUCT_DRAFT, type CatalogueSelection } from "../lib/commerce.ts";
describe("same-origin shop transport", () => {
  it("uses relative routes, cookies, a timeout and refused redirects", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ jobs: [] })));
    const api = createShopHttp(send);
    await api.bootstrap("customer");
    expect(send).toHaveBeenCalledWith("/api/shop/bootstrap?side=customer", expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
    await api.changeJob("https://unrelated.test/path", 2, { kind: "approve-proof" });
    expect(send.mock.calls[1]![0]).toBe("/api/shop/jobs/https%3A%2F%2Funrelated.test%2Fpath");
  });
  it("preserves safe error codes and HTTP status", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 }));
    await expect(createShopHttp(send).bootstrap("staff")).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
  });
  it("turns network and malformed responses into failures", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("private detail"));
    await expect(createShopHttp(send).bootstrap("customer")).rejects.toEqual(new ShopRequestError("UNAVAILABLE", 0));
    send.mockResolvedValueOnce(new Response("not JSON"));
    await expect(createShopHttp(send).bootstrap("customer")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("sends JSON on logout without exposing session tokens", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await createShopHttp(send).logout();
    expect(send).toHaveBeenCalledWith("/api/shop/staff/session", expect.objectContaining({ method: "DELETE", body: "{}", headers: { "Content-Type": "application/json" } }));
  });
  it("uploads original bytes with encoded metadata and same-origin cookies", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ref: "PS-1", files: [] })));
    const file = new File(["%PDF-1.4\n%%EOF"], "baskı dosyası.pdf", { type: "application/pdf" });
    await createShopHttp(send).uploadJobFile("PS/1", 7, "proof", file, "Check colours\nSecond line");
    expect(send).toHaveBeenCalledWith("/api/shop/jobs/PS%2F1/files?kind=proof", expect.objectContaining({
      method: "POST", body: file, credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/pdf", "X-Print-Shop-Filename": encodeURIComponent(file.name),
        "X-Print-Shop-Revision": "7", "X-Print-Shop-Note": encodeURIComponent("Check colours\nSecond line") },
    }));
  });
  it("refuses empty or oversized files before sending and handles absent browser MIME", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ref: "PS-1" })));
    const api = createShopHttp(send);
    await expect(api.uploadJobFile("PS-1", 0, "artwork", new File([], "empty.pdf"))).rejects.toMatchObject({ code: "INVALID_FILE" });
    await expect(api.uploadJobFile("PS-1", 0, "artwork", new File([new Uint8Array(MAX_JOB_FILE_BYTES + 1)], "large.pdf"))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(send).not.toHaveBeenCalled();
    await api.uploadJobFile("PS-1", 0, "artwork", new File(["%PDF-1.4\n%%EOF"], "art.PDF"));
    expect(send.mock.calls[0]![1]?.headers).toMatchObject({ "Content-Type": "application/pdf" });
  });
  it("builds private file URLs with explicit access scope and encoded identifiers", () => {
    expect(jobFileUrl("PS/1", "../file?x=1", "customer")).toBe("/api/shop/jobs/PS%2F1/files/..%2Ffile%3Fx%3D1?side=customer");
    expect(jobFileUrl("PS-1", "version-2", "staff", true)).toBe("/api/shop/jobs/PS-1/files/version-2?side=staff&download=1");
  });
  it("unwraps catalogue lists and sends versioned staff product changes to relative routes", async () => {
    const product = { ...BANNER_PRODUCT_DRAFT, id: "banner/1", revision: 2 };
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [product] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(product)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...product, revision: 3 })));
    const api = createShopHttp(send);
    expect(await api.listCatalogue("staff")).toEqual([product]);
    expect(await api.createCatalogueProduct(BANNER_PRODUCT_DRAFT)).toEqual(product);
    expect((await api.updateCatalogueProduct("banner/1", 2, BANNER_PRODUCT_DRAFT)).revision).toBe(3);
    expect(send.mock.calls[0]![0]).toBe("/api/shop/catalogue?side=staff");
    expect(send.mock.calls[1]).toEqual(["/api/shop/catalogue", expect.objectContaining({
      method: "POST", body: JSON.stringify(BANNER_PRODUCT_DRAFT), credentials: "same-origin", redirect: "error",
    })]);
    expect(send.mock.calls[2]).toEqual(["/api/shop/catalogue/banner%2F1", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ revision: 2, product: BANNER_PRODUCT_DRAFT }),
      credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json" },
    })]);
  });
  it("submits selections for authoritative catalogue quotes and orders", async () => {
    const lines: CatalogueSelection[] = [{ productId: "banner-1", productRevision: 0,
      widthMm: 2000, heightMm: 1000, quantity: 2, eyeletsPerItem: 4, weldEdges: true, hemEdges: false }];
    const quote = { currency: "TRY", totalCents: 92000 };
    const receipt = { order: { ref: "PS-1" }, jobs: [] };
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(quote)))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    const api = createShopHttp(send);
    expect(await api.quoteCatalogue(lines)).toEqual(quote);
    const submission = { requestKey: "catalogue-request-1", customer: { name: "Customer", email: "customer@example.test" }, lines };
    expect(await api.createCatalogueOrder(submission)).toEqual(receipt);
    expect(send.mock.calls[0]).toEqual(["/api/shop/catalogue/quote", expect.objectContaining({
      method: "POST", body: JSON.stringify({ lines }), credentials: "same-origin", redirect: "error",
    })]);
    expect(send.mock.calls[1]).toEqual(["/api/shop/catalogue/orders", expect.objectContaining({
      method: "POST", body: JSON.stringify(submission), credentials: "same-origin", redirect: "error",
    })]);
  });
  it("fails malformed catalogue envelopes and preserves product edit conflicts", async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "CONFLICT" } }), { status: 409 }));
    const api = createShopHttp(send);
    await expect(api.listCatalogue("customer")).rejects.toMatchObject({ code: "UNAVAILABLE", status: 200 });
    await expect(api.updateCatalogueProduct("banner-1", 1, BANNER_PRODUCT_DRAFT)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });
});
