import { useId, useState, type FormEvent } from "react";

import { getShopGateway } from "../data/shopGateway.ts";
import type { ShopSide } from "../data/shopContract.ts";
import { useI18n } from "../i18n/index.tsx";
import { useStore } from "../state/store.ts";
import App from "./App.tsx";

/** The live entry point receives an already authorized, session-scoped snapshot. */
export default function LiveApp({ side, authenticated }: { side: ShopSide; authenticated: boolean }) {
  const { t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);

  if (side === "staff" && !authenticated) return <StaffLogin />;

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
            <button type="button" className="mp-button mp-button--ghost mp-btn" disabled={signingOut}
              onClick={() => void signOut()} style={{ marginInlineStart: "auto" }}>{t("live.logout")}</button>
            {logoutFailed && <span role="alert">{t("live.logoutFailed")}</span>}
          </>
        )}
      </nav>
      {side === "customer" && historyOpen ? <OrderHistory onFollow={() => setHistoryOpen(false)} /> : <App />}
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
