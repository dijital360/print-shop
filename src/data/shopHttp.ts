import type { Job } from "../lib/jobs.ts";
import { MAX_JOB_FILE_BYTES } from "./shopContract.ts";
import type { JobCommand, JobFileKind, OrderReceipt, OrderSubmission, ShopGateway, ShopSide, ShopSnapshot } from "./shopContract.ts";

/** Real request retry identities are separate from the deterministic demo. */
export function newSubmissionKey(): string { return crypto.randomUUID(); }

export class ShopRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

export function jobFileUrl(ref: string, fileId: string, side: ShopSide, download = false): string {
  return `/api/shop/jobs/${encodeURIComponent(ref)}/files/${encodeURIComponent(fileId)}?side=${encodeURIComponent(side)}${download ? "&download=1" : ""}`;
}

/** Only same-origin routes; session capabilities stay in HttpOnly cookies. */
export function createShopHttp(send: typeof fetch = globalThis.fetch.bind(globalThis)): ShopGateway {
  async function sendRequest<T>(path: string, options: RequestInit, timeout = 15_000): Promise<T> {
    if (!path.startsWith("/api/shop/")) throw new ShopRequestError("INVALID_REQUEST", 400);
    let response: Response;
    try {
      response = await send(path, {
        ...options, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(timeout),
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
  function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return sendRequest(path, { method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return {
    bootstrap: (side: ShopSide) => request<ShopSnapshot>(`/api/shop/bootstrap?side=${side}`),
    createOrder: (input: OrderSubmission) => request<OrderReceipt>("/api/shop/orders", "POST", input),
    changeJob: (ref: string, revision: number, command: JobCommand) => request<Job>(`/api/shop/jobs/${encodeURIComponent(ref)}`, "POST", { revision, command }),
    uploadJobFile: async (ref: string, revision: number, kind: JobFileKind, file: File, note = "") => {
      if (file.size < 1) throw new ShopRequestError("INVALID_FILE", 400);
      if (file.size > MAX_JOB_FILE_BYTES) throw new ShopRequestError("FILE_TOO_LARGE", 413);
      const extension = file.name.split(".").at(-1)?.toLowerCase();
      const mediaType = file.type || ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" } as Record<string, string>)[extension ?? ""] || "application/octet-stream";
      return sendRequest<Job>(`/api/shop/jobs/${encodeURIComponent(ref)}/files?kind=${encodeURIComponent(kind)}`, {
        method: "POST", body: file,
        headers: { "Content-Type": mediaType, "X-Print-Shop-Filename": encodeURIComponent(file.name),
          "X-Print-Shop-Revision": String(revision), "X-Print-Shop-Note": encodeURIComponent(note) },
      }, 60_000);
    },
    login: async (email, password) => { await request("/api/shop/staff/session", "POST", { email, password }); },
    logout: async () => { await request("/api/shop/staff/session", "DELETE", {}); },
  };
}
