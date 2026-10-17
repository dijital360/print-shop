import type { Job } from "../lib/jobs.ts";
import type { JobCommand, OrderReceipt, OrderSubmission, ShopGateway, ShopSide, ShopSnapshot } from "./shopContract.ts";

/** Real request retry identities are separate from the deterministic demo. */
export function newSubmissionKey(): string { return crypto.randomUUID(); }

export class ShopRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

/** Only same-origin routes; session capabilities stay in HttpOnly cookies. */
export function createShopHttp(send: typeof fetch = globalThis.fetch.bind(globalThis)): ShopGateway {
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!path.startsWith("/api/shop/")) throw new ShopRequestError("INVALID_REQUEST", 400);
    let response: Response;
    try {
      response = await send(path, {
        method, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ShopRequestError("UNAVAILABLE", 0); }
    if (response.status === 204) return undefined as T;
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = typeof value === "object" && value !== null && "error" in value ? value.error : value;
      const code = typeof envelope === "object" && envelope !== null && "code" in envelope && typeof envelope.code === "string"
        ? envelope.code : "UNAVAILABLE";
      throw new ShopRequestError(code, response.status);
    }
    if (value === null) throw new ShopRequestError("UNAVAILABLE", response.status);
    return value as T;
  }
  return {
    bootstrap: (side: ShopSide) => request<ShopSnapshot>(`/api/shop/bootstrap?side=${side}`),
    createOrder: (input: OrderSubmission) => request<OrderReceipt>("/api/shop/orders", "POST", input),
    changeJob: (ref: string, revision: number, command: JobCommand) => request<Job>(`/api/shop/jobs/${encodeURIComponent(ref)}`, "POST", { revision, command }),
    login: async (email, password) => { await request("/api/shop/staff/session", "POST", { email, password }); },
    logout: async () => { await request("/api/shop/staff/session", "DELETE", {}); },
  };
}
