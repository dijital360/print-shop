import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n/index.tsx";
import { setDataSource } from "../data/source.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { createShopHttp, ShopRequestError } from "../data/shopHttp.ts";
import { shopSource } from "../data/shopSource.ts";
import type { ShopSide, ShopSnapshot } from "../data/shopContract.ts";
import LiveStartupError from "./LiveStartupError.tsx";

/** Resolve scoped records before importing any module that reads the store. */
export async function bootLive(container: HTMLElement): Promise<void> {
  const root = createRoot(container);
  try {
    const side: ShopSide = /^\/staff(?:\/|$)/.test(window.location.pathname) ? "staff" : "customer";
    const api = createShopHttp();
    let authenticated = true;
    let snapshot: ShopSnapshot;
    try { snapshot = await api.bootstrap(side); }
    catch (error) {
      if (side !== "staff" || !(error instanceof ShopRequestError) || error.status !== 401) throw error;
      authenticated = false;
      snapshot = await api.bootstrap("customer");
    }
    configureShopGateway(api);
    setDataSource(shopSource(snapshot));
    const { default: LiveApp } = await import("./LiveApp.tsx");
    if (side === "staff" && authenticated) {
      const { useStore } = await import("../state/store.ts");
      useStore.setState({ persona: "shop", view: "today", loading: false });
    }
    root.render(<StrictMode><I18nProvider><LiveApp side={side} authenticated={authenticated} /></I18nProvider></StrictMode>);
  } catch {
    root.render(<I18nProvider><LiveStartupError retry={() => window.location.reload()} /></I18nProvider>);
  }
}
