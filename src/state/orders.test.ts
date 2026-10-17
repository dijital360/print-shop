import { beforeEach, describe, expect, it } from "vitest";

import { source } from "../data/source.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { columnFor } from "../lib/jobs.ts";
import { priceQuote, promiseFor } from "../lib/quote.ts";
import { TAX_RATE } from "../lib/rates.ts";
import { useStore } from "./store.ts";

const store = () => useStore.getState();

beforeEach(() => {
  configureShopGateway(null);
  useStore.setState(useStore.getInitialState(), true);
  store().setDetails({ name: " A customer ", email: " customer@example.test " });
});

function addLine(): void {
  store().startConfigure("business-cards");
  store().addToBasket();
}

describe("order submission", () => {
  it("keeps the submitted lines and creates a trackable production job for each", () => {
    addLine();
    store().attachArtwork("cards.pdf");
    store().startConfigure("posters");
    store().patchConfig({ quantity: 10, printedProof: true });
    store().addToBasket();
    const basket = store().basket;
    const previousJobs = store().jobs;

    const ref = store().placeOrder();
    const order = store().orders[0]!;
    expect(ref).toBe(order.ref);
    expect(order.customer).toEqual({ name: "A customer", email: "customer@example.test" });
    expect(order.lines).toHaveLength(2);
    expect(new Set(order.lines.map((line) => line.jobRef)).size).toBe(2);
    expect(order.lines[0]?.artwork).toEqual({ filename: "cards.pdf" });
    expect(store().jobs).toHaveLength(previousJobs.length + 2);
    for (const [index, line] of order.lines.entries()) {
      const quote = priceQuote(basket[index]!.config);
      expect(store().jobs.find((job) => job.ref === line.jobRef)).toMatchObject({
        productKey: line.config.product,
        materialKey: line.config.material,
        customer: order.customer.name,
        quantity: line.config.quantity,
        trimWidthMm: quote.size.widthMm,
        trimHeightMm: quote.size.heightMm,
        promisedFor: line.readyBy,
        stage: "ordered",
        proofs: [],
      });
      expect(columnFor(store().jobs.find((job) => job.ref === line.jobRef)!.stage)).toBe("prepress");
      store().setLookup({ ref: line.jobRef });
      store().doLookup();
      expect(store().lookupResult).toEqual({ kind: "job", ref: line.jobRef });
    }
    expect(store().basket).toEqual([]);
    expect(store().config).toBeNull();
    expect(store().view).toBe("confirm");
  });

  it("captures the chosen delivery and exact totals independently of later changes", () => {
    addLine();
    store().attachArtwork("cards.pdf");
    const delivery = {
      addOn: "a-delivery-add-on", code: "standard", label: "Standard", amount: 9.4,
      currency: "USD", estimatedDelivery: "2026-08-07",
    };
    store().chooseAddOnDelivery(delivery);
    const basket = store().basket;
    const details = store().details;
    const subtotal = priceQuote(basket[0]!.config).subtotalCents + 940;
    store().placeOrder();

    const order = store().orders[0]!;
    expect(order.subtotalCents).toBe(subtotal);
    expect(order.taxCents).toBe(Math.round(subtotal * TAX_RATE));
    expect(order.totalCents).toBe(subtotal + Math.round(subtotal * TAX_RATE));
    expect(order.deliveryChoice).toEqual(delivery);
    expect(store().deliveryChoice).toBeNull();

    basket[0]!.config.quantity = 999;
    basket[0]!.artwork!.filename = "changed.pdf";
    details.name = "Changed";
    delivery.amount = 500;
    expect(order.lines[0]!.config.quantity).not.toBe(999);
    expect(order.lines[0]!.artwork!.filename).toBe("cards.pdf");
    expect(order.customer.name).toBe("A customer");
    expect(order.deliveryChoice!.amount).toBe(9.4);
    expect(order.subtotalCents).toBe(subtotal);
  });

  it("uses the current working day and preserves promised dates after the clock advances", () => {
    addLine();
    store().advanceDay();
    store().advanceDay();
    const expected = promiseFor(store().basket[0]!.config, {
      iso: store().todayIso(), hour: store().now.hour,
    }).readyBy;
    const placedOn = store().todayIso();
    store().placeOrder();
    store().advanceDay();
    expect(store().orders[0]).toMatchObject({ placedOn, readyBy: expected });
    expect(store().jobs.at(-1)!.promisedFor).toBe(expected);
  });

  it("avoids active, archived and saved quote references across consecutive submissions", () => {
    const start = source.nextRef();
    const match = /^(.*?)(\d+)$/.exec(start)!;
    const refAt = (offset: number) => `${match[1]}${String(Number(match[2]) + offset).padStart(match[2]!.length, "0")}`;
    useStore.setState({
      jobs: [...store().jobs, { ...store().jobs[0]!, ref: refAt(0) }],
      pastJobs: [...store().pastJobs, { ...store().jobs[0]!, ref: refAt(1) }],
      savedQuotes: [...store().savedQuotes, { ...store().savedQuotes[0]!, ref: refAt(2) }],
    });
    addLine();
    addLine();
    expect(store().placeOrder()).toBe(refAt(3));
    expect(store().orders[0]!.lines.map((line) => line.jobRef)).toEqual([refAt(3), refAt(4)]);
    addLine();
    expect(store().placeOrder()).toBe(refAt(5));
  });

  it("ignores an empty resubmission without duplicating the submitted order", () => {
    addLine();
    store().placeOrder();
    const state = store();
    expect(store().placeOrder()).toBeNull();
    expect(store()).toBe(state);
    expect(store().orders).toHaveLength(1);
  });

  it.each([
    { name: "   ", email: "customer@example.test", quantity: 100 },
    { name: "Customer", email: "not-an-email", quantity: 100 },
    { name: "Customer", email: "customer@example.test", quantity: 0 },
    { name: "Customer", email: "customer@example.test", quantity: 1.5 },
  ])("rejects invalid details or quantities without changing the basket: %j", ({ name, email, quantity }) => {
    addLine();
    useStore.setState({
      details: { name, email },
      basket: store().basket.map((line) => ({ ...line, config: { ...line.config, quantity } })),
    });
    const state = store();
    expect(store().placeOrder()).toBeNull();
    expect(store()).toBe(state);
  });

  it("keeps a blocked custom-size basket for correction", () => {
    store().startConfigure("pvc-banners");
    store().patchConfig({ size: "custom", customWidthMm: 0, customHeightMm: 0 });
    store().addToBasket();
    const state = store();
    expect(priceQuote(state.basket[0]!.config).blocked.length).toBeGreaterThan(0);
    expect(store().placeOrder()).toBeNull();
    expect(store()).toBe(state);
  });
});
