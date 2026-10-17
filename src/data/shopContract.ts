import type { BoardColumn, Job, StockRow } from "../lib/jobs.ts";
import type { BasketLine, DeliveryChoice, PlacedOrder } from "../state/store.ts";
import type { ArtworkRecord, Now } from "./types.ts";
import type { Works } from "./source.ts";
export type ShopSide = "customer" | "staff";
export interface ShopSnapshot {
  now: Now; works: Works; orders: PlacedOrder[]; jobs: Job[]; pastJobs: Job[];
  stock: StockRow[]; artwork: ArtworkRecord[];
}
export interface OrderSubmission {
  requestKey: string; customer: { name: string; email: string };
  lines: BasketLine[]; deliveryChoice: DeliveryChoice | null;
}
export interface OrderReceipt { order: PlacedOrder; jobs: Job[] }
export type JobCommand =
  | { kind: "move"; column: BoardColumn } | { kind: "send-proof"; note: string }
  | { kind: "approve-proof" } | { kind: "ask-change"; note: string }
  | { kind: "spoilage"; sheets: number } | { kind: "collect" };
export interface ShopGateway {
  bootstrap(side: ShopSide): Promise<ShopSnapshot>;
  createOrder(submission: OrderSubmission): Promise<OrderReceipt>;
  changeJob(ref: string, revision: number, command: JobCommand): Promise<Job>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}
