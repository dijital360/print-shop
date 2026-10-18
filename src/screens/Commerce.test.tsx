/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShopGateway } from "../data/shopContract.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { BANNER_PRODUCT_DRAFT, quoteCatalogue, type CatalogueOrderSubmission, type CatalogueProduct, type CatalogueReceipt } from "../lib/commerce.ts";
import { CatalogueManager, CatalogueOrderHistory, CatalogueStorefront } from "./Commerce.tsx";

let host: HTMLDivElement;
let root: Root;
let gateway: ShopGateway;
const banner: CatalogueProduct = { ...BANNER_PRODUCT_DRAFT, id: "branda", revision: 7, taxIncluded: false };
const unitProduct: CatalogueProduct = { ...banner, id: "unit-product", revision: 2, name: "Özel baskı", materialName: "Özel malzeme", calculationMode: "unit", unitPriceCents: 10_000, minimumOrderCents: 0 };
const tryMoney = (value: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value / 100);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  gateway = {
    bootstrap: vi.fn(), createOrder: vi.fn(), changeJob: vi.fn(), uploadJobFile: vi.fn(), login: vi.fn(), logout: vi.fn(),
    listCatalogue: vi.fn().mockResolvedValue([banner, unitProduct]), createCatalogueProduct: vi.fn(), updateCatalogueProduct: vi.fn(), createCatalogueOrder: vi.fn(),
  };
  configureShopGateway(gateway);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  configureShopGateway(null);
  vi.restoreAllMocks();
});

function button(text: string, container: ParentNode = host): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function input(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const found = [...host.querySelectorAll("label")].find((element) => element.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`Missing field: ${label}`);
  return found.querySelector("input,textarea,select")!;
}

function fill(label: string, value: string) {
  const element = input(label);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function toggle(label: string) { act(() => (input(label) as HTMLInputElement).click()); }

function amount(label: string, container: ParentNode = host.querySelector(".commerce-estimate")!): string | null {
  const entry = [...container.querySelectorAll("dt")].find((element) => element.textContent?.startsWith(label));
  return entry?.nextElementSibling?.textContent ?? null;
}

function receipt(submission: CatalogueOrderSubmission): CatalogueReceipt {
  const quote = quoteCatalogue([banner, unitProduct], submission.lines);
  return { jobs: [], order: { kind: "catalogue", ref: "SIP-2031", customer: submission.customer, currency: "TRY", placedOn: "2026-10-17", readyBy: "2026-10-21",
    lines: quote.lines.map((line, index) => ({ ...line, jobRef: `IS-2031-${index + 1}`, readyBy: "2026-10-21" })),
    subtotalCents: quote.subtotalCents, taxCents: quote.taxCents, totalCents: quote.totalCents, minimumTopUpCents: quote.minimumTopUpCents } };
}

async function storefront(onOrder = vi.fn(), onFollow = vi.fn()) {
  await act(async () => root.render(<CatalogueStorefront onOrder={onOrder} onFollow={onFollow} />));
  return { onOrder, onFollow };
}

function addToCart() { act(() => button("Sepete ekle").click()); }
function customerDetails() { fill("Adınız veya şirketiniz", "Örnek Matbaa Müşterisi"); fill("E-posta", "customer@example.test"); }

describe("Turkish catalogue storefront", () => {
  it("converts decimal-comma centimetres and charges each eyelet plus both full-perimeter services", async () => {
    await storefront();
    expect(amount("En az sipariş farkı")).toBe(tryMoney(35_000));
    expect(amount("KDV hariç toplam")).toBe(tryMoney(50_000));
    expect(amount("KDV (%20)")).toBe(tryMoney(10_000));
    expect(amount("Ödenecek toplam")).toBe(tryMoney(60_000));
    fill("En (cm)", "125,5"); fill("Boy (cm)", "200"); fill("Adet", "2"); fill("Adet başına kuşgözü", "8");
    toggle("Kenar kaynağı"); toggle("Kenar kıvırma");
    expect(host.querySelector(".commerce-measures")?.textContent).toContain("5,02 m²");
    expect(host.querySelector(".commerce-measures")?.textContent).toContain("13,02 m");
    expect(amount("Baskı bedeli")).toBe(tryMoney(75_300));
    expect(amount("Kuşgözü")).toBe(tryMoney(8_000));
    expect(amount("Kenar kaynağı")).toBe(tryMoney(26_040));
    expect(amount("Kenar kıvırma")).toBe(tryMoney(26_040));
    expect(amount("Ödenecek toplam")).toBe(tryMoney(162_456));
    addToCart();
    expect(host.querySelector(".commerce-cart-lines")?.textContent).toContain("125,5 × 200 cm · 2 adet");
    expect(host.textContent).not.toContain("$");
  });

  it("supports real unit-priced products and rejects fractional counts before adding a line", async () => {
    await storefront();
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".commerce-product")].find((element) => element.textContent?.includes("Özel baskı"))!.click());
    fill("En (cm)", "200"); fill("Boy (cm)", "300"); fill("Adet", "3");
    expect(amount("Baskı bedeli")).toBe(tryMoney(30_000));
    expect(amount("Ödenecek toplam")).toBe(tryMoney(36_000));
    fill("Adet başına kuşgözü", "1.5");
    expect(host.querySelector(".commerce-estimate [role=alert]")?.textContent).toContain("tam sayı");
    expect([...host.querySelectorAll("button")].some((element) => element.textContent === "Sepete ekle")).toBe(false);
  });

  it("keeps a multi-line cart and retry key after uncertainty, then confirms only the server receipt", async () => {
    let acknowledge: ((value: CatalogueReceipt) => void) | undefined;
    vi.mocked(gateway.createCatalogueOrder!).mockRejectedValueOnce(new Error("Network outcome unknown"))
      .mockImplementationOnce(() => new Promise<CatalogueReceipt>((resolve) => { acknowledge = resolve; }));
    const callbacks = await storefront();
    addToCart(); addToCart(); customerDetails();
    await act(async () => button("Siparişi oluştur").click());
    expect(host.querySelectorAll(".commerce-cart-lines li")).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sepetiniz korunuyor");
    expect(host.textContent).not.toContain("Siparişiniz kaydedildi");
    expect(callbacks.onOrder).not.toHaveBeenCalled();
    const first = vi.mocked(gateway.createCatalogueOrder!).mock.calls[0]![0];
    await act(async () => button("Siparişi oluştur").click());
    const second = vi.mocked(gateway.createCatalogueOrder!).mock.calls[1]![0];
    expect(second.requestKey).toBe(first.requestKey);
    expect(second.lines).toHaveLength(2);
    expect(second.lines[0]).toMatchObject({ widthMm: 1000, heightMm: 1000, quantity: 1, eyeletsPerItem: 0 });
    expect(button("Sipariş kaydediliyor…").disabled).toBe(true);
    act(() => button("Sipariş kaydediliyor…").click());
    expect(gateway.createCatalogueOrder).toHaveBeenCalledTimes(2);
    const saved = receipt(second);
    await act(async () => acknowledge!(saved));
    expect(callbacks.onOrder).toHaveBeenCalledWith(saved);
    expect(host.querySelector(".commerce-cart")).toBeNull();
    expect(host.textContent).toContain("SIP-2031");
    expect(host.textContent).toContain(tryMoney(saved.order.totalCents));
    expect(host.textContent).toContain("En az sipariş farkı (KDV hariç)");
    expect(host.textContent).toContain("Kaydedilen hesap ayrıntıları");
    act(() => [...host.querySelectorAll("button")].find((element) => element.textContent?.includes("IS-2031-2"))!.click());
    expect(callbacks.onFollow).toHaveBeenCalledWith("IS-2031-2", "customer@example.test");
  });

  it("keeps an acknowledged receipt when the following refresh fails", async () => {
    vi.mocked(gateway.createCatalogueOrder!).mockImplementation(async (submission) => receipt(submission));
    const onOrder = vi.fn().mockRejectedValue(new Error("Snapshot could not refresh"));
    await storefront(onOrder);
    addToCart(); customerDetails();
    await act(async () => button("Siparişi oluştur").click());
    expect(host.textContent).toContain("Siparişiniz kaydedildi");
    expect(host.textContent).toContain("Takip bilgileri yenilenemedi");
    expect(host.textContent).not.toContain("Sipariş kaydedilemedi veya yanıt alınamadı");
    expect(host.querySelector(".commerce-cart")).toBeNull();
  });

  it("reports loading failures without inventing an empty catalogue", async () => {
    vi.mocked(gateway.listCatalogue!).mockRejectedValue(new Error("Private service details"));
    await storefront();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Ürünler yüklenemedi");
    expect(host.textContent).not.toContain("satışta ürün bulunmuyor");
    expect(host.textContent).not.toContain("Private service details");
  });
});

describe("catalogue management and saved history", () => {
  it("creates a unit-priced product only after acknowledgement and can archive it without deletion", async () => {
    let acknowledge: ((value: CatalogueProduct) => void) | undefined;
    vi.mocked(gateway.createCatalogueProduct!).mockImplementation(() => new Promise<CatalogueProduct>((resolve) => { acknowledge = resolve; }));
    await act(async () => root.render(<CatalogueManager />));
    fill("Ürün adı", "Folyo etiket"); fill("Malzeme adı", "Folyo"); fill("Hesaplama biçimi", "unit"); fill("Birim tutar (TL)", "275,50");
    await act(async () => button("Ürünü kaydet").click());
    expect(gateway.createCatalogueProduct).toHaveBeenCalledWith(expect.objectContaining({ name: "Folyo etiket", materialName: "Folyo", calculationMode: "unit", unitPriceCents: 27_550, taxRateBps: 2000, taxIncluded: false, active: true }));
    expect(host.textContent).not.toContain("Ürün kaydedildi.");
    expect(host.querySelector<HTMLFieldSetElement>("form fieldset")?.disabled).toBe(true);
    expect(button("Yeni ürün").disabled).toBe(true);
    const payload = vi.mocked(gateway.createCatalogueProduct!).mock.calls[0]![0];
    const saved = { ...payload, id: "new-product", revision: 1 };
    await act(async () => acknowledge!(saved));
    expect(host.textContent).toContain("Ürün kaydedildi.");
    expect(host.querySelector(".commerce-admin-products")?.textContent).toContain("Folyo etiket");
    vi.mocked(gateway.updateCatalogueProduct!).mockResolvedValue({ ...saved, revision: 2, active: false });
    toggle("Ürün satışta");
    await act(async () => button("Ürünü kaydet").click());
    expect(gateway.updateCatalogueProduct).toHaveBeenCalledWith("new-product", 1, expect.objectContaining({ active: false }));
    expect(host.querySelector(".commerce-admin-products")?.textContent).toContain("Arşivde");
  });

  it("retains the original edit revision on conflict and asks staff to reload instead of overwriting", async () => {
    vi.mocked(gateway.updateCatalogueProduct!).mockRejectedValue(Object.assign(new Error("Concurrent update"), { code: "CONFLICT" }));
    await act(async () => root.render(<CatalogueManager />));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Branda ürününü düzenle"]')!.click());
    fill("Birim tutar (TL)", "300");
    await act(async () => button("Ürünü kaydet").click());
    expect(gateway.updateCatalogueProduct).toHaveBeenCalledWith(banner.id, 7, expect.objectContaining({ unitPriceCents: 30_000 }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("yeniden yükleyip ürünü tekrar açın");
    expect(host.textContent).not.toContain("Ürün kaydedildi.");
    vi.mocked(gateway.listCatalogue!).mockResolvedValue([{ ...banner, revision: 8, unitPriceCents: 20_000 }]);
    await act(async () => button("Listeyi yenile").click());
    await act(async () => button("Ürünü kaydet").click());
    expect(vi.mocked(gateway.updateCatalogueProduct!).mock.calls[1]?.[1]).toBe(7);
    expect(input("Birim tutar (TL)").value).toBe("300");
  });

  it("loads previous customer-scoped catalogue orders on a fresh history mount and follows their jobs", async () => {
    const saved = receipt({ requestKey: "past", customer: { name: "Müşteri", email: "past@example.test" }, lines: [{ productId: banner.id, productRevision: banner.revision, widthMm: 1000, heightMm: 1000, quantity: 1, eyeletsPerItem: 4, weldEdges: true, hemEdges: false }] });
    vi.mocked(gateway.bootstrap).mockResolvedValue({ catalogueOrders: [saved.order] } as Awaited<ReturnType<ShopGateway["bootstrap"]>>);
    const onFollow = vi.fn();
    await act(async () => root.render(<CatalogueOrderHistory onFollow={onFollow} />));
    expect(gateway.bootstrap).toHaveBeenCalledWith("customer");
    expect(host.textContent).toContain(saved.order.ref);
    expect(host.textContent).toContain(tryMoney(saved.order.totalCents));
    act(() => [...host.querySelectorAll("button")].find((element) => element.textContent?.includes("IS-2031-1"))!.click());
    expect(onFollow).toHaveBeenCalledWith("IS-2031-1", "past@example.test");
    await act(async () => root.render(<div />));
    await act(async () => root.render(<CatalogueOrderHistory onFollow={onFollow} />));
    expect(gateway.bootstrap).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("SIP-2031");
  });
});
