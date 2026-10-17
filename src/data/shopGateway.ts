import type { ShopGateway } from "./shopContract.ts";
let gateway: ShopGateway | null = null;
export function configureShopGateway(next: ShopGateway | null): void { gateway = next; }
export function getShopGateway(): ShopGateway | null { return gateway; }
