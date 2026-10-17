/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../app/App.tsx";
import { configureShopGateway } from "../data/shopGateway.ts";
import { I18nProvider } from "../i18n/index.tsx";
import { cents, day } from "../lib/format.ts";
import { promiseFor } from "../lib/quote.ts";
import { useStore } from "../state/store.ts";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  localStorage.setItem("print-shop-locale", "en-US");
  configureShopGateway(null);
  useStore.setState(useStore.getInitialState(), true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderCheckout(): HTMLButtonElement {
  useStore.setState({ view: "basket", loading: false });
  act(() => root.render(<I18nProvider><App /></I18nProvider>));
  return host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

function settleView(): void {
  act(() => vi.advanceTimersByTime(200));
}

describe("submitted order screens", () => {
  it("shows the actual multi-line order and lets customer and staff follow every job", () => {
    const store = () => useStore.getState();
    store().startConfigure("business-cards");
    store().addToBasket();
    store().startConfigure("posters");
    store().patchConfig({ quantity: 10, printedProof: true });
    store().addToBasket();
    store().setDetails({ name: "A customer", email: "customer@example.test" });
    store().advanceDay();
    const expectedReadyBy = store().basket.map((line) =>
      promiseFor(line.config, { iso: store().todayIso(), hour: store().now.hour }).readyBy,
    ).sort().at(-1)!;

    const submit = renderCheckout();
    expect(host.textContent).toContain(day(expectedReadyBy));
    act(() => submit.click());
    settleView();

    const order = store().orders[0]!;
    expect(store().view).toBe("confirm");
    expect(host.querySelector("h1")?.textContent).toBe("That's booked in.");
    expect(order.readyBy).toBe(expectedReadyBy);
    expect(host.textContent).toContain(day(expectedReadyBy));
    expect(host.textContent).toContain(cents(order.totalCents));
    expect(host.textContent).toContain("A customer");
    for (const line of order.lines) expect(host.textContent).toContain(line.jobRef);

    const secondRef = order.lines[1]!.jobRef;
    const followSecond = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(secondRef),
    )!;
    act(() => followSecond.click());
    settleView();
    expect(store().lookup).toEqual({ ref: secondRef, email: order.customer.email });
    expect(store().lookupResult).toEqual({ kind: "job", ref: secondRef });
    expect(host.textContent).toContain(secondRef);
    expect(host.textContent).toContain("A customer");

    act(() => store().go("jobs"));
    settleView();
    for (const line of order.lines) expect(host.textContent).toContain(line.jobRef);
  });

  it("announces the allocated reference when a second order is submitted", () => {
    const store = () => useStore.getState();
    store().setDetails({ name: "A customer", email: "customer@example.test" });
    store().startConfigure("flyers");
    store().addToBasket();
    const firstRef = store().placeOrder();
    store().startConfigure("flyers");
    store().addToBasket();

    const submit = renderCheckout();
    act(() => submit.click());
    settleView();

    expect(store().placedRef).not.toBe(firstRef);
    expect(store().toasts.at(-1)?.message).toContain(store().placedRef);
    expect(host.querySelector("h1")?.textContent).toBe("That's booked in.");
  });

  it("keeps invalid checkout details out of confirmation", () => {
    const store = () => useStore.getState();
    store().startConfigure("flyers");
    store().addToBasket();
    const submit = renderCheckout();
    expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.required).toBe(true);

    act(() => submit.click());
    expect(store().orders).toHaveLength(0);
    expect(store().basket).toHaveLength(1);
    expect(store().view).toBe("basket");
    expect(host.querySelector("form")?.checkValidity()).toBe(false);
  });

  it("does not invent a confirmation when no order was submitted", () => {
    useStore.setState({ view: "confirm", loading: false });
    act(() => root.render(<I18nProvider><App /></I18nProvider>));
    expect(host.querySelector("h1")?.textContent).not.toBe("That's booked in.");
    expect(host.textContent).not.toContain("MP-4127");
  });

  it("explains a rejected submission while retaining the basket", () => {
    const store = () => useStore.getState();
    store().startConfigure("flyers");
    store().addToBasket();
    store().setDetails({ name: "   ", email: "customer@example.test" });
    const submit = renderCheckout();
    // Spaces satisfy HTML required; domain validation must still give feedback.
    expect(host.querySelector("form")?.checkValidity()).toBe(true);
    act(() => submit.click());
    expect(store().orders).toHaveLength(0);
    expect(store().basket).toHaveLength(1);
    expect(store().toasts.at(-1)?.tone).toBe("warn");
    expect(host.textContent).toContain("your basket is unchanged");
  });
});
