import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderReceipt, ShopGateway } from "../data/shopContract.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { useStore } from "./store.ts";
const store = () => useStore.getState();
let receipt: OrderReceipt;
function basket() {
  store().startConfigure("business-cards"); store().addToBasket();
  store().setDetails({ name: "Customer", email: "customer@example.test" });
}
function gateway(): ShopGateway {
  return { bootstrap: vi.fn(), createOrder: vi.fn().mockResolvedValue(structuredClone(receipt)), changeJob: vi.fn(), uploadJobFile: vi.fn(), login: vi.fn(), logout: vi.fn() };
}
beforeEach(() => {
  configureShopGateway(null); useStore.setState(useStore.getInitialState(), true); basket();
  const previous = store().jobs.length; store().placeOrder();
  receipt = { order: structuredClone(store().orders[0]!), jobs: structuredClone(store().jobs.slice(previous)) };
  useStore.setState(useStore.getInitialState(), true);
});
afterEach(() => { configureShopGateway(null); vi.restoreAllMocks(); });
describe("acknowledged live orders", () => {
  it("waits for acknowledgement and rejects double submission", async () => {
    const api = gateway(); let acknowledge!: (value: OrderReceipt) => void;
    vi.mocked(api.createOrder).mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    configureShopGateway(api); basket(); const previous = store().jobs.length;
    const request = store().submitOrder();
    expect(store().submittingOrder).toBe(true); expect(store().orders).toEqual([]);
    expect(store().jobs).toHaveLength(previous); expect(store().basket).toHaveLength(1);
    expect(await store().submitOrder()).toBeNull(); expect(api.createOrder).toHaveBeenCalledTimes(1);
    acknowledge(receipt); expect(await request).toBe(receipt.order.ref);
    expect(store().basket).toEqual([]); expect(store().jobs).toHaveLength(previous + receipt.jobs.length);
    expect(store().orders[0]).toEqual(receipt.order); expect(store().submittingOrder).toBe(false);
  });
  it("retains the basket and retry identity after network failure", async () => {
    const api = gateway(); vi.mocked(api.createOrder).mockRejectedValueOnce(new Error("Unavailable"));
    configureShopGateway(api); basket(); const submitted = store().basket;
    expect(await store().submitOrder()).toBeNull(); expect(store().basket).toBe(submitted); expect(store().orders).toEqual([]);
    await store().submitOrder();
    expect(vi.mocked(api.createOrder).mock.calls[0]![0].requestKey).toBe(vi.mocked(api.createOrder).mock.calls[1]![0].requestKey);
  });
  it("preserves edits made while a request is in flight", async () => {
    const api = gateway(); let acknowledge!: (value: OrderReceipt) => void;
    vi.mocked(api.createOrder).mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    configureShopGateway(api); basket(); const request = store().submitOrder();
    store().startConfigure("flyers"); store().addToBasket(); const nextBasket = store().basket;
    acknowledge(receipt); await request; expect(store().basket).toBe(nextBasket);
  });
  it("retains the old job when a server refuses a proof approval", async () => {
    const api = gateway(); vi.mocked(api.changeJob).mockRejectedValue(new Error("Forbidden"));
    configureShopGateway(api); const job = { ...receipt.jobs[0]!, revision: 4 };
    useStore.setState({ jobs: [job], toasts: [] }); const result = store().approveProof(job.ref);
    expect(store().jobs[0]).toBe(job); expect(await result).toBe(false); expect(store().jobs[0]).toBe(job);
    expect(api.changeJob).toHaveBeenCalledWith(job.ref, 4, { kind: "approve-proof" }); expect(store().toasts.at(-1)?.tone).toBe("warn");
  });
  it("never mints a live retry key for a demo order", () => {
    const nonce = vi.spyOn(crypto, "randomUUID"); basket(); expect(store().placeOrder()).not.toBeNull(); expect(nonce).not.toHaveBeenCalled();
  });
  it("waits for a file acknowledgement and locks competing changes to the same job", async () => {
    const api = gateway(); configureShopGateway(api);
    const job = { ...receipt.jobs[0]!, revision: 3 };
    useStore.setState({ jobs: [job], pendingJobs: [], toasts: [] });
    let acknowledge!: (value: typeof job) => void;
    vi.mocked(api.uploadJobFile).mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const file = new File(["%PDF-1.4\n%%EOF"], "original.pdf", { type: "application/pdf" });
    const request = store().uploadJobFile(job.ref, "artwork", file);
    expect(store().jobs[0]).toBe(job);
    expect(store().pendingJobs).toEqual([job.ref]);
    expect(await store().uploadJobFile(job.ref, "artwork", file)).toBe(false);
    expect(await store().approveProof(job.ref)).toBe(false);
    expect(api.changeJob).not.toHaveBeenCalled();
    expect(api.uploadJobFile).toHaveBeenCalledWith(job.ref, 3, "artwork", file, undefined);
    const saved = { ...job, revision: 4, files: [{ id: "file-1", kind: "artwork" as const, filename: "original.pdf", mediaType: "application/pdf" as const, size: file.size, uploadedAt: "2026-10-17T09:00:00.000Z" }] };
    acknowledge(saved);
    expect(await request).toBe(true); expect(store().jobs[0]).toEqual(saved); expect(store().pendingJobs).toEqual([]);
  });
  it("keeps the previous file version and proof state when upload fails", async () => {
    const api = gateway(); configureShopGateway(api);
    const job = { ...receipt.jobs[0]!, revision: 9 };
    useStore.setState({ jobs: [job], pendingJobs: [], toasts: [] });
    vi.mocked(api.uploadJobFile).mockRejectedValue(new Error("Unavailable"));
    const result = await store().uploadJobFile(job.ref, "proof", new File(["%PDF-1.4\n%%EOF"], "proof.pdf", { type: "application/pdf" }), "Review");
    expect(result).toBe(false); expect(store().jobs[0]).toBe(job); expect(store().pendingJobs).toEqual([]);
    expect(store().toasts.at(-1)?.tone).toBe("warn");
  });
});
