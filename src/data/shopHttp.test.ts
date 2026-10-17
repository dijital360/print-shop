import { describe, expect, it, vi } from "vitest";
import { createShopHttp, ShopRequestError } from "./shopHttp.ts";
describe("same-origin shop transport", () => {
  it("uses relative routes, cookies, a timeout and refused redirects", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ jobs: [] })));
    const api = createShopHttp(send);
    await api.bootstrap("customer");
    expect(send).toHaveBeenCalledWith("/api/shop/bootstrap?side=customer", expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
    await api.changeJob("https://unrelated.test/path", 2, { kind: "approve-proof" });
    expect(send.mock.calls[1]![0]).toBe("/api/shop/jobs/https%3A%2F%2Funrelated.test%2Fpath");
  });
  it("preserves safe error codes and HTTP status", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 }));
    await expect(createShopHttp(send).bootstrap("staff")).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
  });
  it("turns network and malformed responses into failures", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("private detail"));
    await expect(createShopHttp(send).bootstrap("customer")).rejects.toEqual(new ShopRequestError("UNAVAILABLE", 0));
    send.mockResolvedValueOnce(new Response("not JSON"));
    await expect(createShopHttp(send).bootstrap("customer")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("sends JSON on logout without exposing session tokens", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await createShopHttp(send).logout();
    expect(send).toHaveBeenCalledWith("/api/shop/staff/session", expect.objectContaining({ method: "DELETE", body: "{}", headers: { "Content-Type": "application/json" } }));
  });
});
