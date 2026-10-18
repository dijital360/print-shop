/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShopShell } from "../components/Shell.tsx";
import { configureShopGateway } from "../data/shopGateway.ts";
import { I18nProvider } from "../i18n/index.tsx";
import type { CatalogueOrderLine } from "../lib/commerce.ts";
import { mm } from "../lib/format.ts";
import type { Job } from "../lib/jobs.ts";
import { useStore } from "../state/store.ts";
import { OrderLookup } from "./CustomerOrder.tsx";
import { JobsList, Ticket, Today } from "./Shop.tsx";

vi.mock("../surface.ts", () => ({ LIVE: true, HOSTED: false, APP_KEY: "printing", CONNECTED: false, SURFACE_SIDE: null, DEMO: false }));

const LINE: CatalogueOrderLine = {
  productId: "banner-custom", productRevision: 2,
  productName: "Özel Branda", materialName: "Özel branda malzemesi", calculationMode: "area",
  widthMm: 1000, heightMm: 2000, quantity: 2,
  eyeletsPerItem: 4, weldEdges: true, hemEdges: false,
  unitPriceCents: 15000, minimumOrderCents: 50000, eyeletPriceCents: 500,
  weldPricePerMetreCents: 2000, hemPricePerMetreCents: 2000,
  taxRateBps: 2000, taxIncluded: false, leadDays: 3,
  areaSqm: 4, perimeterMetres: 12,
  baseCents: 60000, eyeletsCents: 4000, weldCents: 24000, hemCents: 0,
  priceCents: 88000, subtotalCents: 88000, taxCents: 17600, totalCents: 105600,
  jobRef: "JOB-MANAGED-1", readyBy: "2026-08-10",
};

let host: HTMLDivElement;
let root: Root;
let job: Job;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  localStorage.setItem("print-shop-locale", "en-US");
  configureShopGateway(null);
  useStore.setState(useStore.getInitialState(), true);
  job = {
    ref: LINE.jobRef, productKey: "catalogue-banner-custom", materialKey: "catalogue-media",
    customer: "Managed customer", quantity: LINE.quantity,
    trimWidthMm: LINE.widthMm, trimHeightMm: LINE.heightMm,
    sides: 1, finishKey: "none", packagingKey: "bundled",
    stage: "ordered", promisedFor: LINE.readyBy, express: false,
    proofs: [], files: [], spoiledSheets: 0, catalogueLine: structuredClone(LINE),
  };
  useStore.setState({ jobs: [job], pastJobs: [], artwork: [], loading: false,
    ticketRef: job.ref, lookupResult: { kind: "job", ref: job.ref } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  configureShopGateway(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(element: ReactNode): void {
  act(() => root.render(<I18nProvider>{element}</I18nProvider>));
}

function capturedDetails(): HTMLElement {
  return host.querySelector<HTMLElement>('section[aria-label="Sipariş kalemi"]')!;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "TRY" }).format(cents / 100);
}

describe("managed catalogue jobs", () => {
  it("keeps the board and jobs list usable for products absent from the legacy catalogue", () => {
    render(<Today />);
    expect(host.querySelector(".mp-jobcard-title")?.textContent).toBe(LINE.productName);
    expect(host.querySelector(".mp-jobcard-spec")?.textContent).toContain(`${mm(1000, 2000)} mm`);
    expect(host.textContent).not.toContain("data.product.catalogue-");

    render(<JobsList />);
    expect(host.querySelector("tbody")?.textContent).toContain(LINE.productName);
    expect(host.querySelector("tbody")?.textContent).toContain(job.ref);
    expect(host.querySelector("tbody")?.textContent).toContain(`${mm(1000, 2000)} mm`);
  });

  it("shows the captured area, finishing and TRY price without sheet imposition or sheet spoilage", () => {
    render(<Ticket />);
    const details = capturedDetails();
    expect(details).not.toBeNull();
    expect(details.textContent).toContain(LINE.productName);
    expect(details.textContent).toContain(LINE.materialName);
    expect(details.textContent).toContain(`${mm(LINE.widthMm, LINE.heightMm)} mm`);
    expect(details.textContent).toContain("4 m²");
    expect(details.textContent).toContain("4 / adet · 8 toplam");
    expect(details.textContent).toContain("Var · 12 m");
    expect(details.textContent).toContain("Kenar kıvırmaYok");
    expect(details.textContent).toContain(money(LINE.baseCents));
    expect(details.textContent).toContain(money(LINE.eyeletsCents));
    expect(details.textContent).toContain(money(LINE.weldCents));
    expect(details.textContent).toContain(money(LINE.taxCents));
    expect(details.textContent).toContain(`Kalem toplamı${money(LINE.totalCents)}`);
    expect(host.querySelector(".mp-impos")).toBeNull();
    expect(host.querySelector(".mp-matline")).toBeNull();
    expect(host.textContent).not.toContain("Record spoilage");
    expect(host.textContent).not.toContain("data.material.catalogue-");
    expect(host.textContent).toContain("Proof history");
  });

  it("uses generic unit pricing for managed products instead of applying a sheet template", () => {
    const line: CatalogueOrderLine = {
      ...LINE, productId: "unit-custom", productName: "Özel Etiket", calculationMode: "unit",
      widthMm: 85, heightMm: 55, quantity: 1, eyeletsPerItem: 0, weldEdges: false,
      areaSqm: 0.004675, perimeterMetres: 0.28,
      unitPriceCents: 12000, baseCents: 12000, eyeletsCents: 0, weldCents: 0,
      priceCents: 12000, subtotalCents: 12000, taxCents: 2400, totalCents: 14400,
    };
    useStore.setState({ jobs: [{ ...job, productKey: "catalogue-unit-custom", quantity: 1,
      trimWidthMm: 85, trimHeightMm: 55, catalogueLine: line }] });

    render(<Ticket />);

    expect(capturedDetails().textContent).toContain(line.productName);
    expect(capturedDetails().textContent).toContain(`${money(line.unitPriceCents)} / adet`);
    expect(capturedDetails().textContent).not.toContain("Toplam alan");
    expect(host.querySelector(".mp-impos")).toBeNull();
    expect(host.textContent).not.toContain("Record spoilage");
  });

  it("shows the same captured specification and line total on customer tracking", () => {
    render(<OrderLookup />);
    expect(host.textContent).toContain(LINE.productName);
    expect(capturedDetails().textContent).toContain(LINE.materialName);
    expect(capturedDetails().textContent).toContain(`Kalem toplamı${money(LINE.totalCents)}`);
    expect(host.textContent).not.toContain("data.product.catalogue-");
  });

  it("finds a managed job by its captured product name in staff search", () => {
    useStore.setState({ searchQuery: "özel branda" });
    render(<ShopShell><div /></ShopShell>);
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes(job.ref) && button.textContent.includes(LINE.productName));
    expect(result).toBeDefined();
    act(() => result!.click());
    expect(useStore.getState().ticketRef).toBe(job.ref);
    expect(useStore.getState().view).toBe("ticket");
  });

  it("preserves sheet imposition and spoilage controls for legacy jobs", () => {
    const legacy = structuredClone(useStore.getInitialState().jobs[0]!);
    useStore.setState({ jobs: [legacy], ticketRef: legacy.ref });
    render(<Ticket />);
    expect(host.querySelector(".mp-impos")).not.toBeNull();
    expect(host.querySelector(".mp-matline")).not.toBeNull();
    expect(host.textContent).toContain("Record spoilage");
    expect(capturedDetails()).toBeNull();
  });
});
