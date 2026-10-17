/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../app/App.tsx";
import type { OrderReceipt, ShopGateway } from "../data/shopContract.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { I18nProvider } from "../i18n/index.tsx";
import { cents } from "../lib/format.ts";
import { useStore } from "../state/store.ts";

vi.mock("../surface.ts", () => ({
  LIVE: true, HOSTED: false, APP_KEY: "printing", CONNECTED: false, SURFACE_SIDE: null, DEMO: false,
}));

let host: HTMLDivElement;
let root: Root;
let gateway: ShopGateway;
let receipt: OrderReceipt;
let localRef: string;

function makeReceipt(): OrderReceipt {
  // Reuse the real quote/order model, then give the response references that
  // only a server acknowledgement can supply to the live checkout.
  const store = () => useStore.getState();
  store().setDetails({ name: "Live customer", email: "customer@example.test" });
  store().startConfigure("business-cards");
  store().addToBasket();
  store().startConfigure("posters");
  store().patchConfig({ quantity: 10 });
  store().addToBasket();
  localRef = store().placeOrder()!;
  const order = structuredClone(store().orders[0]!);
  const jobs = order.lines.map((line, index) => ({
    ...structuredClone(store().jobs.find((job) => job.ref === line.jobRef)!),
    ref: `JOB-SERVER-731-${index + 1}`, revision: 1,
  }));
  order.ref = "ORDER-SERVER-731";
  order.lines = order.lines.map((line, index) => ({ ...line, jobRef: jobs[index]!.ref }));
  return { order, jobs };
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  localStorage.setItem("print-shop-locale", "en-US");
  configureShopGateway(null);
  useStore.setState(useStore.getInitialState(), true);
  receipt = makeReceipt();
  vi.clearAllTimers();
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    view: "basket", loading: false, jobs: [], pastJobs: [], savedQuotes: [], customers: [], artwork: [], orders: [],
    details: { ...receipt.order.customer },
    basket: receipt.order.lines.map(({ id, config }) => ({ id, config: { ...config } })),
  });
  gateway = { bootstrap: vi.fn(), createOrder: vi.fn(), changeJob: vi.fn(), login: vi.fn(), logout: vi.fn() };
  configureShopGateway(gateway);
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

function renderCheckout(): HTMLButtonElement {
  act(() => root.render(<I18nProvider><App /></I18nProvider>));
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit) throw new Error("Checkout submit button is missing");
  return submit;
}

describe("server-backed checkout", () => {
  it("waits for the server, prevents duplicate clicks, and confirms only the saved receipt", async () => {
    let acknowledge: ((value: OrderReceipt) => void) | undefined;
    vi.mocked(gateway.createOrder).mockImplementation(() => new Promise<OrderReceipt>((resolve) => { acknowledge = resolve; }));
    const basket = structuredClone(useStore.getState().basket);
    const submit = renderCheckout();
    act(() => submit.click());
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    act(() => submit.click());
    expect(gateway.createOrder).toHaveBeenCalledTimes(1);
    expect(gateway.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      customer: receipt.order.customer, lines: basket, requestKey: expect.any(String),
    }));
    expect(useStore.getState().basket).toEqual(basket);
    expect(useStore.getState().orders).toHaveLength(0);
    expect(useStore.getState().placedRef).toBeNull();
    expect(useStore.getState().view).toBe("basket");
    expect(useStore.getState().toasts).toHaveLength(0);
    expect(host.textContent).not.toContain("That's booked in.");
    expect(host.textContent).not.toContain(receipt.order.ref);
    await act(async () => acknowledge!(receipt));
    act(() => vi.advanceTimersByTime(200));
    expect(useStore.getState().submittingOrder).toBe(false);
    expect(useStore.getState().basket).toHaveLength(0);
    expect(useStore.getState().orders).toEqual([receipt.order]);
    expect(useStore.getState().jobs).toEqual(receipt.jobs);
    expect(useStore.getState().placedRef).toBe(receipt.order.ref);
    expect(useStore.getState().view).toBe("confirm");
    expect(host.querySelector("h1")?.textContent).toBe("That's booked in.");
    expect(host.textContent).toContain("Your order has been saved. Keep your reference to follow its progress.");
    expect(host.textContent).toContain(cents(receipt.order.totalCents));
    expect(host.textContent).toContain(receipt.order.ref);
    for (const line of receipt.order.lines) expect(host.textContent).toContain(line.jobRef);
    expect(host.textContent).not.toContain(localRef);
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(useStore.getState().toasts[0]).toMatchObject({ message: `Order ${receipt.order.ref} is booked in.`, tone: "pos" });
  });

  it("keeps the basket and customer details after failure and reports no success", async () => {
    vi.mocked(gateway.createOrder).mockRejectedValue(new Error("Private database failure"));
    const basket = structuredClone(useStore.getState().basket);
    const details = { ...useStore.getState().details };
    const submit = renderCheckout();
    await act(async () => submit.click());
    expect(gateway.createOrder).toHaveBeenCalledTimes(1);
    expect(useStore.getState().basket).toEqual(basket);
    expect(useStore.getState().details).toEqual(details);
    expect(useStore.getState().orders).toHaveLength(0);
    expect(useStore.getState().jobs).toHaveLength(0);
    expect(useStore.getState().placedRef).toBeNull();
    expect(useStore.getState().view).toBe("basket");
    expect(useStore.getState().submittingOrder).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(host.querySelector("h1")?.textContent).toBe("Your order");
    expect(host.textContent).toContain("your basket is unchanged");
    expect(host.textContent).not.toContain("Private database failure");
    expect(host.textContent).not.toContain("That's booked in.");
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(useStore.getState().toasts[0]?.tone).toBe("warn");
  });

  it("opens the real basket without simulated artwork, card fields, a fictional collection address, or the demo dock", () => {
    useStore.setState({ basket: [], config: null });
    useStore.getState().startConfigure("flyers");
    useStore.getState().addToBasket();
    expect(useStore.getState().view).toBe("basket");
    act(() => vi.advanceTimersByTime(200));
    renderCheckout();
    expect(host.querySelector("h1")?.textContent).toBe("Your order");
    expect(host.textContent).toContain("Payment pending. No card has been charged.");
    expect(host.textContent).not.toContain("Card number");
    expect(host.textContent).not.toContain("3 Market Square");
    expect(host.textContent).not.toContain("This is a demo. No real card is charged.");
    expect(host.querySelector('input[value="4242 4242 4242 4242"]')).toBeNull();
    expect(host.querySelector(".mp-dock")).toBeNull();
    expect(host.querySelector('[role="region"][aria-label="Demo"]')).toBeNull();
    expect(useStore.getState().registry.all).toHaveLength(0);
  });
});
