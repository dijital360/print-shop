import { useId, useState, type FormEvent } from "react";

import { getShopGateway } from "../data/shopGateway.ts";
import type { ShopSide } from "../data/shopContract.ts";
import type { CatalogueReceipt } from "../lib/commerce.ts";
import { useI18n } from "../i18n/index.tsx";
import { useStore } from "../state/store.ts";
import App from "./App.tsx";
import { CatalogueManager, CatalogueOrderHistory, CatalogueStorefront } from "../screens/Commerce.tsx";

/** The live entry point receives an already authorized, session-scoped snapshot. */
export default function LiveApp({ side, authenticated }: { side: ShopSide; authenticated: boolean }) {
  const { t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState(() => window.location.pathname.startsWith("/staff/catalogue"));
  const [following, setFollowing] = useState(false);
  const [followFailed, setFollowFailed] = useState(false);
  const view = useStore((state) => state.view);
  const legacyOrders = useStore((state) => state.orders);
  const hasCatalogue = getShopGateway()?.listCatalogue !== undefined;

  if (side === "staff" && !authenticated) return <StaffLogin />;

  async function refreshSnapshot() {
    const gateway = getShopGateway();
    if (!gateway) throw new Error("Shop gateway is unavailable");
    const snapshot = await gateway.bootstrap(side);
    useStore.setState({ jobs: snapshot.jobs, pastJobs: snapshot.pastJobs, orders: snapshot.orders,
      catalogueOrders: snapshot.catalogueOrders ?? [], stock: snapshot.stock, artwork: snapshot.artwork, now: snapshot.now });
  }

  async function acknowledgeOrder(receipt: CatalogueReceipt) {
    useStore.setState((state) => ({
      catalogueOrders: [...state.catalogueOrders.filter((order) => order.ref !== receipt.order.ref), receipt.order],
      jobs: [...state.jobs.filter((job) => !receipt.jobs.some((saved) => saved.ref === job.ref)), ...receipt.jobs],
    }));
    // The acknowledged receipt remains usable even if a subsequent refresh fails.
    await refreshSnapshot();
  }

  async function follow(ref: string, email: string) {
    if (following) return;
    setFollowing(true);
    setFollowFailed(false);
    try {
      try { await refreshSnapshot(); }
      catch {
        const current = useStore.getState();
        const knownOrder = [...current.orders, ...current.catalogueOrders].some((order) =>
          order.customer.email.toLowerCase() === email.toLowerCase() && order.lines.some((line) => line.jobRef === ref));
        if (!knownOrder || ![...current.jobs, ...current.pastJobs].some((job) => job.ref === ref)) throw new Error("UNAVAILABLE");
      }
      const store = useStore.getState();
      store.setLookup({ ref, email });
      store.doLookup();
      if (useStore.getState().lookupResult?.kind !== "job") throw new Error("UNAVAILABLE");
      store.go("order");
      setHistoryOpen(false);
    } catch { setFollowFailed(true); }
    finally { setFollowing(false); }
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutFailed(false);
    try {
      const gateway = getShopGateway();
      if (gateway === null) throw new Error("Shop gateway is unavailable");
      await gateway.logout();
      window.location.reload();
    } catch {
      setLogoutFailed(true);
      setSigningOut(false);
    }
  }

  return (
    <>
      <nav className="mp-wrap" aria-label={side === "staff" ? t("live.staff") : t("live.myOrders")}
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, paddingBlock: 12 }}>
        {side === "customer" ? (
          <>
            <button type="button" className="mp-button mp-button--ghost mp-btn" aria-current={!historyOpen ? "page" : undefined}
              onClick={() => { useStore.getState().go("products"); setHistoryOpen(false); }}>
              {t("live.products")}
            </button>
            <button type="button" className="mp-button mp-button--ghost mp-btn" aria-current={historyOpen ? "page" : undefined}
              onClick={() => setHistoryOpen(true)}>{t("live.myOrders")}</button>
            <a href="/staff" className="mp-button mp-button--ghost mp-btn" style={{ marginInlineStart: "auto" }}>{t("live.staff")}</a>
          </>
        ) : (
          <>
            <a href="/" className="mp-button mp-button--ghost mp-btn">{t("live.products")}</a>
            {hasCatalogue && <>
              <button type="button" className="mp-button mp-button--ghost mp-btn" aria-current={!catalogueOpen ? "page" : undefined}
                onClick={() => setCatalogueOpen(false)}>Üretim</button>
              <button type="button" className="mp-button mp-button--ghost mp-btn" aria-current={catalogueOpen ? "page" : undefined}
                onClick={() => setCatalogueOpen(true)}>Ürünler ve fiyatlar</button>
            </>}
            <button type="button" className="mp-button mp-button--ghost mp-btn" disabled={signingOut}
              onClick={() => void signOut()} style={{ marginInlineStart: "auto" }}>{t("live.logout")}</button>
            {logoutFailed && <span role="alert">{t("live.logoutFailed")}</span>}
          </>
        )}
      </nav>
      {following && <p className="mp-wrap" role="status" lang="tr">Sipariş bilgileri yükleniyor…</p>}
      {followFailed && <p className="mp-wrap" role="alert" lang="tr">Sipariş bilgileri yüklenemedi. Takip düğmesinden tekrar deneyin.</p>}
      {side === "customer" && hasCatalogue ? <>
        <div hidden={historyOpen || view !== "products"}>
          <CatalogueStorefront onOrder={acknowledgeOrder} onFollow={follow} />
        </div>
        {historyOpen ? <>
          <CatalogueOrderHistory onFollow={follow} />
          {legacyOrders.length > 0 && <OrderHistory onFollow={() => setHistoryOpen(false)} />}
        </> : view !== "products" ? <App /> : null}
      </> : side === "staff" && catalogueOpen && hasCatalogue ? <CatalogueManager />
        : side === "customer" && historyOpen ? <OrderHistory onFollow={() => setHistoryOpen(false)} /> : <App />}
    </>
  );
}

function StaffLogin() {
  const { t } = useI18n();
  const titleId = useId();
  const errorId = useId();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (pending || !form.reportValidity()) return;
    const data = new FormData(form);
    setPending(true);
    setFailed(false);
    try {
      const gateway = getShopGateway();
      if (gateway === null) throw new Error("Shop gateway is unavailable");
      await gateway.login(String(data.get("email")).trim(), String(data.get("password")));
      form.reset();
      window.location.reload();
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <main className="mp-main">
      <section className="mp-wrap" style={{ maxInlineSize: 460 }} aria-labelledby={titleId}>
        <h1 id={titleId}>{t("live.loginTitle")}</h1>
        <form onSubmit={(event) => void signIn(event)} aria-busy={pending}>
          <fieldset disabled={pending} className="mp-stack" style={{ padding: 0, border: 0, margin: 0, minInlineSize: 0 }}>
            <label className="mp-field">
              <span className="mp-label">{t("live.email")}</span>
              <input name="email" type="email" className="mp-input mp-fld" required autoComplete="username"
                autoCapitalize="none" spellCheck={false} aria-describedby={failed ? errorId : undefined} />
            </label>
            <label className="mp-field">
              <span className="mp-label">{t("live.password")}</span>
              <input name="password" type="password" className="mp-input mp-fld" required autoComplete="current-password"
                aria-describedby={failed ? errorId : undefined} />
            </label>
            {failed && <p id={errorId} role="alert">{t("live.loginFailed")}</p>}
            <button className="mp-button mp-btn" type="submit">{t(pending ? "live.signingIn" : "live.signIn")}</button>
          </fieldset>
        </form>
        <p><a href="/">{t("live.products")}</a></p>
      </section>
    </main>
  );
}

function OrderHistory({ onFollow }: { onFollow: () => void }) {
  const { t, money, number, date } = useI18n();
  const orders = useStore((state) => state.orders);
  const titleId = useId();
  const formatDate = (iso: string) => date(new Date(`${iso}T00:00:00`), { dateStyle: "medium" });

  function follow(ref: string, email: string) {
    const store = useStore.getState();
    store.setLookup({ ref, email });
    store.doLookup();
    store.go("order");
    onFollow();
  }

  return (
    <main className="mp-main">
      <section className="mp-wrap mp-stack" aria-labelledby={titleId}>
        <h1 id={titleId}>{t("live.myOrders")}</h1>
        <p>{t("live.ordersScope")}</p>
        {orders.length === 0 ? <p className="mp-empty">{t("live.emptyOrders")}</p> : [...orders].reverse().map((order) => (
          <article key={order.ref} className="mp-panel mp-panel-pad">
            <h2><bdi className="mp-mono">{order.ref}</bdi></h2>
            <dl style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
              <div><dt>{t("live.placedOn")}</dt><dd style={{ marginInlineStart: 0 }}>{formatDate(order.placedOn)}</dd></div>
              <div><dt>{t("cust.confirm.readyBy")}</dt><dd style={{ marginInlineStart: 0 }}>{formatDate(order.readyBy)}</dd></div>
              <div><dt>{t("live.total")}</dt><dd style={{ marginInlineStart: 0 }}>{money(order.totalCents / 100)}</dd></div>
            </dl>
            <ul className="mp-stack" style={{ paddingInlineStart: 20 }}>
              {order.lines.map((line) => (
                <li key={line.id}>
                  <span>{t(`data.product.${line.config.product}` as never)} · {t("live.quantity", { quantity: number(line.config.quantity) })}</span>
                  <span style={{ marginInline: 12 }}>{money(line.subtotalCents / 100)}</span>
                  <button type="button" className="mp-button mp-button--ghost mp-btn" onClick={() => follow(line.jobRef, order.customer.email)}>
                    {t("live.follow")} <bdi className="mp-mono">{line.jobRef}</bdi>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </main>
  );
}
