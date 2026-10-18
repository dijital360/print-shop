import type { DataSource } from "./source.ts";
import type { ShopSnapshot } from "./shopContract.ts";
/** A private scoped snapshot, never a fallback to invented records. */
export function shopSource(snapshot: ShopSnapshot): DataSource {
  return {
    now: () => ({ ...snapshot.now }), jobs: () => structuredClone(snapshot.jobs),
    pastJobs: () => structuredClone(snapshot.pastJobs), savedQuotes: () => [], customers: () => [],
    stock: () => structuredClone(snapshot.stock), artwork: () => structuredClone(snapshot.artwork),
    nextRef: () => "", works: () => structuredClone(snapshot.works), orders: () => structuredClone(snapshot.orders),
    catalogueOrders: () => structuredClone(snapshot.catalogueOrders ?? []),
  };
}
