/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopGateway, ShopSnapshot } from "../data/shopContract.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { I18nProvider } from "../i18n/index.tsx";
import { BANNER_PRODUCT_DRAFT, quoteCatalogue, type CatalogueReceipt } from "../lib/commerce.ts";
import { useStore } from "../state/store.ts";
import LiveApp from "./LiveApp.tsx";

let receipt: CatalogueReceipt;
vi.mock("./App.tsx", () => ({ default: () => <div data-testid="production">Production or tracking</div> }));
vi.mock("../screens/Commerce.tsx", () => ({
  CatalogueManager: () => <div data-testid="manager">Product management</div>,
  CatalogueStorefront: ({ onOrder }: { onOrder: (value: CatalogueReceipt) => Promise<void> }) => <section data-testid="storefront">
    <input aria-label="Draft basket" defaultValue="preserved" />
    <button onClick={() => void onOrder(receipt).catch(() => {})}>Acknowledge managed order</button>
  </section>,
  CatalogueOrderHistory: ({ onFollow }: { onFollow: (ref: string, email: string) => void }) =>
    <button onClick={() => onFollow(receipt.order.ref, receipt.order.customer.email)}>Follow managed order</button>,
}));

let root: Root;
let host: HTMLDivElement;
let gateway: ShopGateway;
function snapshot(): ShopSnapshot {
  return { now: { iso: "2026-10-17", hour: 12, minute: 0 }, works: { name: "Shop", lines: [], city: "", postcode: "", country: "", countryCode: "", established: 0, people: 0 },
    jobs: receipt.jobs, pastJobs: [], orders: [], catalogueOrders: [receipt.order], stock: [], artwork: [] };
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function render(side: "customer" | "staff", authenticated = true) {
  act(() => root.render(<I18nProvider><LiveApp side={side} authenticated={authenticated} /></I18nProvider>));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.history.replaceState({}, "", "/");
  localStorage.setItem("print-shop-locale", "en-US");
  useStore.setState(useStore.getInitialState(), true);
  const product = { ...BANNER_PRODUCT_DRAFT, id: "branda", revision: 0 };
  const quote = quoteCatalogue([product], [{ productId: "branda", productRevision: 0, widthMm: 1000, heightMm: 1000, quantity: 1, eyeletsPerItem: 0, weldEdges: false, hemEdges: false }]);
  const line = { ...quote.lines[0]!, jobRef: "PS-MANAGED", readyBy: "2026-10-21" };
  receipt = { order: { kind: "catalogue", currency: "TRY", ref: line.jobRef, customer: { name: "Owner", email: "owner@example.test" }, placedOn: "2026-10-17", readyBy: line.readyBy,
    lines: [line], subtotalCents: quote.subtotalCents, taxCents: quote.taxCents, totalCents: quote.totalCents, minimumTopUpCents: quote.minimumTopUpCents },
    jobs: [{ ref: line.jobRef, productKey: "catalogue-branda", materialKey: "catalogue-media", customer: "Owner", quantity: 1, trimWidthMm: 1000, trimHeightMm: 1000,
      sides: 1, finishKey: "plain-edges", packagingKey: "bundled", stage: "ordered", promisedFor: line.readyBy, express: false, proofs: [], files: [], spoiledSheets: 0, revision: 0, catalogueLine: line }] };
  gateway = { bootstrap: vi.fn().mockResolvedValue(snapshot()), createOrder: vi.fn(), changeJob: vi.fn(), uploadJobFile: vi.fn(), login: vi.fn(), logout: vi.fn(), listCatalogue: vi.fn() };
  configureShopGateway(gateway);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); configureShopGateway(null); vi.restoreAllMocks(); });

describe("managed catalogue integration", () => {
  it("protects the direct catalogue management route with staff authentication", () => {
    window.history.replaceState({}, "", "/staff/catalogue");
    render("staff", false);
    expect(host.querySelector('[data-testid="manager"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    render("staff", true);
    expect(host.querySelector('[data-testid="manager"]')).not.toBeNull();
    act(() => button("Üretim").click());
    expect(host.querySelector('[data-testid="production"]')).not.toBeNull();
  });
  it("keeps the basket mounted when viewing order history and returning", () => {
    render("customer");
    const draft = host.querySelector('input[aria-label="Draft basket"]');
    act(() => button("My orders").click());
    expect(host.querySelector('[data-testid="storefront"]')?.parentElement?.hidden).toBe(true);
    act(() => button("Products").click());
    expect(host.querySelector('input[aria-label="Draft basket"]')).toBe(draft);
    expect(host.querySelector('[data-testid="storefront"]')?.parentElement?.hidden).toBe(false);
  });
  it("merges an acknowledged receipt before a subsequent snapshot finishes", async () => {
    let complete!: (value: ShopSnapshot) => void;
    vi.mocked(gateway.bootstrap).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    render("customer");
    await act(async () => button("Acknowledge managed order").click());
    expect(useStore.getState().catalogueOrders).toEqual([receipt.order]);
    expect(useStore.getState().jobs.some((job) => job.ref === receipt.order.ref)).toBe(true);
    await act(async () => complete(snapshot()));
  });
  it("refreshes a historical order before resolving its production job", async () => {
    useStore.setState({ jobs: [], pastJobs: [], orders: [], catalogueOrders: [] });
    render("customer");
    act(() => button("My orders").click());
    await act(async () => button("Follow managed order").click());
    expect(gateway.bootstrap).toHaveBeenCalledWith("customer");
    expect(useStore.getState().lookupResult).toEqual({ kind: "job", ref: receipt.order.ref });
    expect(useStore.getState().view).toBe("order");
    expect(host.querySelector('[data-testid="production"]')).not.toBeNull();
  });
  it("keeps history visible and explains a failed follow request", async () => {
    useStore.setState({ jobs: [], pastJobs: [], orders: [], catalogueOrders: [] });
    vi.mocked(gateway.bootstrap).mockRejectedValue(new Error("Unavailable"));
    render("customer"); act(() => button("My orders").click());
    await act(async () => button("Follow managed order").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sipariş bilgileri yüklenemedi");
    expect(host.textContent).toContain("Follow managed order");
    expect(useStore.getState().view).not.toBe("order");
  });
});
