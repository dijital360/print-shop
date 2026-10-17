/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShopGateway } from "../data/shopContract.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { I18nProvider } from "../i18n/index.tsx";
import { useStore, type PlacedOrder } from "../state/store.ts";
import LiveApp from "./LiveApp.tsx";
import LiveStartupError from "./LiveStartupError.tsx";

// The wrapper owns access to App. Its screens have their own integration tests.
vi.mock("./App.tsx", () => ({ default: () => <div data-testid="shop-app">Shop application</div> }));

let host: HTMLDivElement;
let root: Root;
let gateway: ShopGateway;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("print-shop-locale", "en-US");
  useStore.setState(useStore.getInitialState(), true);
  gateway = {
    bootstrap: vi.fn(), createOrder: vi.fn(), changeJob: vi.fn(), uploadJobFile: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined),
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(side: "customer" | "staff", authenticated = false) {
  act(() => root.render(<I18nProvider><LiveApp side={side} authenticated={authenticated} /></I18nProvider>));
}

function button(text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

function fillLogin(email = "staff@example.test", password = "test-only-password") {
  host.querySelector<HTMLInputElement>('input[name="email"]')!.value = email;
  host.querySelector<HTMLInputElement>('input[name="password"]')!.value = password;
}

function ownOrder(): PlacedOrder {
  const store = useStore.getState();
  store.startConfigure("flyers");
  const config = useStore.getState().config!;
  const job = useStore.getState().jobs[0]!;
  return {
    ref: "ORDER-OWN", customer: { name: "Session customer", email: "session@example.test" },
    placedOn: "2026-10-16", readyBy: "2026-10-20",
    lines: [
      { id: "line-1", config, jobRef: job.ref, subtotalCents: 2400, readyBy: "2026-10-20" },
      { id: "line-2", config: { ...config, product: "posters", quantity: 10 }, jobRef: "JOB-OWN-2", subtotalCents: 1600, readyBy: "2026-10-19" },
    ],
    deliveryChoice: null, subtotalCents: 4000, taxCents: 800, totalCents: 4800,
  };
}

describe("live staff access", () => {
  it("keeps the staff application behind a validated sign-in form", () => {
    useStore.setState({ view: "today", loading: false });
    render("staff");
    expect(host.querySelector('[data-testid="shop-app"]')).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Staff sign-in");
    const email = host.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(email.required).toBe(true);
    expect(email.autocomplete).toBe("username");
    expect(password.required).toBe(true);
    expect(password.autocomplete).toBe("current-password");
    act(() => button("Sign in").click());
    expect(gateway.login).not.toHaveBeenCalled();
    fillLogin("invalid-email");
    act(() => button("Sign in").click());
    expect(gateway.login).not.toHaveBeenCalled();
  });

  it("shows a safe error after failed sign-in and allows a retry", async () => {
    vi.mocked(gateway.login).mockRejectedValue(new Error("Private server authentication details"));
    render("staff");
    fillLogin();
    await act(async () => button("Sign in").click());
    expect(gateway.login).toHaveBeenCalledWith("staff@example.test", "test-only-password");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sign-in failed");
    expect(host.textContent).not.toContain("Private server");
    expect(button("Sign in").disabled).toBe(false);
    expect(host.querySelector('[data-testid="shop-app"]')).toBeNull();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("test-only-password");
  });

  it("waits for authentication, clears the password, and accepts the refetched staff session", async () => {
    let finishLogin: (() => void) | undefined;
    vi.mocked(gateway.login).mockImplementation(() => new Promise<void>((resolve) => { finishLogin = resolve; }));
    // jsdom reports an unimplemented navigation when the successful login reloads.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render("staff");
    fillLogin();
    await act(async () => button("Sign in").click());
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.textContent).toContain("Signing in…");
    expect(host.querySelector('[data-testid="shop-app"]')).toBeNull();
    await act(async () => finishLogin!());
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(gateway.login).toHaveBeenCalledTimes(1);
    // Boot supplies authenticated=true only after retrieving an authorized snapshot.
    render("staff", true);
    expect(host.querySelector('[data-testid="shop-app"]')).not.toBeNull();
    expect(host.querySelector('a[href="/"]')?.textContent).toBe("Products");
    expect(button("Sign out")).toBeDefined();
    consoleError.mockRestore();
  });

  it("handles a failed logout without claiming that the staff session ended", async () => {
    vi.mocked(gateway.logout).mockRejectedValue(new Error("Internal session details"));
    render("staff", true);
    await act(async () => button("Sign out").click());
    expect(gateway.logout).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("couldn't sign you out");
    expect(host.textContent).not.toContain("Internal session");
    expect(host.querySelector('[data-testid="shop-app"]')).not.toBeNull();
    expect(button("Sign out").disabled).toBe(false);
  });
});

describe("customer session orders", () => {
  it("makes an empty history and its browser scope clear", () => {
    useStore.setState({ orders: [] });
    render("customer");
    act(() => button("My orders").click());
    expect(host.querySelector("h1")?.textContent).toBe("My orders");
    expect(host.textContent).toContain("Orders placed in this browser appear here.");
    expect(host.textContent).toContain("You haven't placed an order here yet.");
    expect(host.querySelectorAll("article")).toHaveLength(0);
    expect(host.querySelector('a[href="/staff"]')?.textContent).toBe("Staff");
  });

  it("renders only the authorized order list and follows each line using its own reference", () => {
    const order = ownOrder();
    const existingJob = useStore.getState().jobs[0]!;
    useStore.setState({ orders: [order], jobs: [existingJob, { ...existingJob, ref: "JOB-OWN-2", productKey: "posters" }] });
    render("customer");
    act(() => button("My orders").click());
    expect(host.querySelectorAll("article")).toHaveLength(1);
    expect(host.textContent).toContain("ORDER-OWN");
    expect(host.textContent).toContain("$48.00");
    expect(host.textContent).toContain("Flyers");
    expect(host.textContent).toContain("Posters");
    expect(host.textContent).toContain("Quantity: 10");
    expect(host.textContent).not.toContain(existingJob.customer);
    act(() => button("Follow JOB-OWN-2").click());
    expect(useStore.getState().lookup).toEqual({ ref: "JOB-OWN-2", email: order.customer.email });
    expect(useStore.getState().lookupResult).toEqual({ kind: "job", ref: "JOB-OWN-2" });
    expect(useStore.getState().view).toBe("order");
    expect(host.querySelectorAll("article")).toHaveLength(0);
    expect(host.querySelector('[data-testid="shop-app"]')).not.toBeNull();
    act(() => button("Products").click());
    expect(useStore.getState().view).toBe("products");
  });
});

it("offers a retry when startup fails", () => {
  const retry = vi.fn();
  act(() => root.render(<I18nProvider><LiveStartupError retry={retry} /></I18nProvider>));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("temporarily unavailable");
  act(() => button("Try again").click());
  expect(retry).toHaveBeenCalledTimes(1);
});
