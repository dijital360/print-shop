import type { BoardColumn, Job, StockRow } from "../lib/jobs.ts";
import type { BasketLine, DeliveryChoice, PlacedOrder } from "../state/store.ts";
import type { ArtworkRecord, Now } from "./types.ts";
import type { Works } from "./source.ts";
import type { CatalogueOrder, CatalogueOrderSubmission, CatalogueProduct, CatalogueProductDraft, CatalogueQuote, CatalogueReceipt, CatalogueSelection } from "../lib/commerce.ts";
export type ShopSide = "customer" | "staff";
export interface ShopSnapshot {
  now: Now; works: Works; orders: PlacedOrder[]; jobs: Job[]; pastJobs: Job[];
  stock: StockRow[]; artwork: ArtworkRecord[];
  catalogueProducts?: CatalogueProduct[];
  catalogueOrders?: CatalogueOrder[];
}
export interface OrderSubmission {
  requestKey: string; customer: { name: string; email: string };
  lines: BasketLine[]; deliveryChoice: DeliveryChoice | null;
}
export interface OrderReceipt { order: PlacedOrder; jobs: Job[] }
export type JobFileKind = "artwork" | "proof";
export type JobFileMediaType = "application/pdf" | "image/png" | "image/jpeg";
/** Private file metadata; bytes are fetched only through the scoped file route. */
export interface JobFile {
  id: string; kind: JobFileKind; filename: string; mediaType: JobFileMediaType;
  size: number; uploadedAt: string;
}
export const MAX_JOB_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_JOB_FILES = 20;
export type JobCommand =
  | { kind: "move"; column: BoardColumn } | { kind: "send-proof"; note: string }
  | { kind: "approve-proof" } | { kind: "ask-change"; note: string }
  | { kind: "spoilage"; sheets: number } | { kind: "collect" };
export interface ShopGateway {
  bootstrap(side: ShopSide): Promise<ShopSnapshot>;
  createOrder(submission: OrderSubmission): Promise<OrderReceipt>;
  changeJob(ref: string, revision: number, command: JobCommand): Promise<Job>;
  uploadJobFile(ref: string, revision: number, kind: JobFileKind, file: File, note?: string): Promise<Job>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  listCatalogue?(side: ShopSide): Promise<CatalogueProduct[]>;
  createCatalogueProduct?(product: CatalogueProductDraft): Promise<CatalogueProduct>;
  updateCatalogueProduct?(id: string, revision: number, product: CatalogueProductDraft): Promise<CatalogueProduct>;
  quoteCatalogue?(lines: CatalogueSelection[]): Promise<CatalogueQuote>;
  createCatalogueOrder?(submission: CatalogueOrderSubmission): Promise<CatalogueReceipt>;
}
