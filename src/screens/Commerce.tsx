import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { getShopGateway } from "../data/shopGateway.ts";
import { newSubmissionKey } from "../data/shopHttp.ts";
import type { ShopSide } from "../data/shopContract.ts";
import { BANNER_PRODUCT_DRAFT, CATALOGUE_LIMITS, quoteCatalogue, validateCatalogueProductDraft, type CatalogueOrder, type CatalogueProduct, type CatalogueProductDraft, type CatalogueQuote, type CatalogueReceipt, type CatalogueSelection } from "../lib/commerce.ts";
import "../styles/commerce.css";

const money = (cents: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(cents / 100);
const number = (value: number) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 }).format(value);
const date = (iso: string) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso));

/** Decimal commas are decimal separators; grouping separators are not accepted. */
function decimal(value: string): number {
  if (!/^\d+(?:[.,]\d+)?$/.test(value.trim())) throw new Error("INVALID_NUMBER");
  const parsed = Number(value.trim().replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error("INVALID_NUMBER");
  return parsed;
}

function cents(value: string): number {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) throw new Error("INVALID_MONEY");
  return Math.round(decimal(value) * 100);
}

function useCatalogue(side: ShopSide) {
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const gateway = getShopGateway();
      if (!gateway?.listCatalogue) throw new Error("UNAVAILABLE");
      const saved = await gateway.listCatalogue(side);
      if (generation.current !== current) return null;
      setProducts(saved);
      return saved;
    } catch {
      if (generation.current === current) setFailed(true);
      return null;
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [side]);
  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [reload]);
  return { products, setProducts, loading, failed, reload };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="commerce-field"><span>{label}</span>{children}</label>;
}

function LoadState({ loading, failed, reload }: { loading: boolean; failed: boolean; reload: () => unknown }) {
  if (loading) return <p role="status">Ürünler yükleniyor…</p>;
  if (!failed) return null;
  return <div className="commerce-alert" role="alert">Ürünler yüklenemedi. <button type="button" onClick={() => void reload()}>Tekrar dene</button></div>;
}

function QuoteSummary({ quote, details = true }: { quote: CatalogueQuote; details?: boolean }) {
  const sums = (field: "baseCents" | "eyeletsCents" | "weldCents" | "hemCents") => quote.lines.reduce((total, line) => total + line[field], 0);
  return <><dl className="commerce-totals">
    {details && <>
      <div><dt>Baskı bedeli</dt><dd>{money(sums("baseCents"))}</dd></div>
      <div><dt>Kuşgözü</dt><dd>{money(sums("eyeletsCents"))}</dd></div>
      <div><dt>Kenar kaynağı</dt><dd>{money(sums("weldCents"))}</dd></div>
      <div><dt>Kenar kıvırma</dt><dd>{money(sums("hemCents"))}</dd></div>
      <div><dt>En az sipariş farkı <small>({money(quote.minimumOrderCents)})</small></dt><dd>{money(quote.minimumTopUpCents)}</dd></div>
    </>}
    <div><dt>KDV hariç toplam</dt><dd>{money(quote.subtotalCents)}</dd></div>
    <div><dt>KDV (%{number(quote.taxRateBps / 100)})</dt><dd>{money(quote.taxCents)}</dd></div>
    <div className="commerce-grand-total"><dt>Ödenecek toplam</dt><dd>{money(quote.totalCents)}</dd></div>
  </dl>{details && <p className="commerce-help">Kalem bedelleri {quote.taxIncluded ? "KDV dahil" : "KDV hariç"} gösterilir. En az sipariş tutarı sepetin tamamına bir kez uygulanır.</p>}</>;
}

type Follow = (ref: string, email: string) => void;

export function CatalogueStorefront({ onOrder, onFollow }: { onOrder: (receipt: CatalogueReceipt) => void | Promise<void>; onFollow: Follow }) {
  const catalogue = useCatalogue("customer");
  const products = catalogue.products.filter((product) => product.active);
  const [productId, setProductId] = useState("");
  const product = products.find((item) => item.id === productId) ?? products[0];
  const [width, setWidth] = useState("100");
  const [height, setHeight] = useState("100");
  const [quantity, setQuantity] = useState("1");
  const [eyelets, setEyelets] = useState("0");
  const [weldEdges, setWeldEdges] = useState(false);
  const [hemEdges, setHemEdges] = useState(false);
  const [cart, setCart] = useState<CatalogueSelection[]>([]);
  const [customer, setCustomer] = useState({ name: "", email: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState<CatalogueOrder | null>(null);
  const [notice, setNotice] = useState("");
  const attempt = useRef<{ fingerprint: string; requestKey: string } | null>(null);
  const pendingRef = useRef(false);
  const titleId = useId();

  const selection = useMemo<CatalogueSelection | null>(() => {
    if (!product) return null;
    try {
      return { productId: product.id, productRevision: product.revision, widthMm: decimal(width) * 10, heightMm: decimal(height) * 10,
        quantity: decimal(quantity), eyeletsPerItem: decimal(eyelets), weldEdges, hemEdges };
    } catch { return null; }
  }, [product, width, height, quantity, eyelets, weldEdges, hemEdges]);
  let preview: CatalogueQuote | null = null;
  let cartQuote: CatalogueQuote | null = null;
  let cartError = "Sepetteki ürün veya fiyat bilgileri güncel değil. Güncel fiyatları yükleyin; satıştan kalkmış kalemleri sepetten çıkarın.";
  try { if (selection) preview = quoteCatalogue(catalogue.products, [selection]); } catch { /* The form explains invalid dimensions or quantities below. */ }
  try { if (cart.length) cartQuote = quoteCatalogue(catalogue.products, cart); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "MIXED_TAX_POLICY") {
      cartError = "Sepette aynı KDV oranı ve KDV dahil/hariç biçimi kullanılmalı. Bu ürünler için ayrı siparişler oluşturun.";
    }
  }

  async function reloadProducts() {
    const saved = await catalogue.reload();
    if (saved === null) return;
    setCart((current) => current.map((line) => ({ ...line, productRevision: saved.find((item) => item.id === line.productId)?.revision ?? line.productRevision })));
    setNotice("Güncel ürün ve fiyatlar yüklendi. Sepet tutarını kontrol edin.");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !cartQuote || !event.currentTarget.reportValidity()) return;
    const draft = { customer: { name: customer.name.trim(), email: customer.email.trim() }, lines: cart };
    if (!draft.customer.name || !draft.customer.email) return;
    const fingerprint = JSON.stringify(draft);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, requestKey: newSubmissionKey() };
    pendingRef.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const gateway = getShopGateway();
      if (!gateway?.createCatalogueOrder) throw new Error("UNAVAILABLE");
      const saved = await gateway.createCatalogueOrder({ ...draft, requestKey: attempt.current.requestKey });
      setOrder(saved.order);
      setCart([]);
      attempt.current = null;
      try { await onOrder(saved); } catch { setNotice("Sipariş kaydedildi. Takip bilgileri yenilenemedi; Siparişlerim ekranından tekrar açabilirsiniz."); }
    } catch {
      setError("Sipariş kaydedilemedi veya yanıt alınamadı. Sepetiniz korunuyor; tekrar deneyebilirsiniz. Ürün bilgileri değiştiyse güncel fiyatları yükleyin.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return <main className="commerce" lang="tr" dir="ltr" aria-labelledby={titleId}>
    <header className="commerce-hero">
      <div><span className="commerce-eyebrow">DIŞ MEKÂN BASKI</span><h1 id={titleId}>Ölçünüzü girin.<br />Baskınızı hesaplayın.</h1>
        <p>Malzemenizi seçin, ölçü ve işçilikleri belirleyin. Tüm tutarları sipariş vermeden önce görün.</p></div>
      <div className="commerce-measure-mark" aria-hidden="true"><span>EN × BOY</span><strong>m²</strong><span>ÖZEL ÖLÇÜ BASKI</span></div>
    </header>
    <LoadState loading={catalogue.loading} failed={catalogue.failed} reload={reloadProducts} />
    {!catalogue.loading && !catalogue.failed && products.length === 0 && <p className="commerce-panel">Şu anda satışta ürün bulunmuyor.</p>}
    {order && <section className="commerce-panel commerce-confirmation" role="status"><h2>Siparişiniz kaydedildi</h2><p>Ödeme bekleniyor; kartınızdan tahsilat yapılmadı. Baskı dosyanızı takip ekranından yükleyebilirsiniz.</p><OrderCard order={order} onFollow={onFollow} /></section>}
    {notice && <p role="status" className="commerce-notice">{notice}</p>}
    {product && <div className="commerce-workspace">
      <section className="commerce-panel"><h2>Ürün ve ölçüler</h2>
        <div className="commerce-product-grid">{products.map((item) => <button key={item.id} type="button" disabled={pending} aria-pressed={item.id === product.id}
          className="commerce-product" onClick={() => setProductId(item.id)}>
          <span className="commerce-product-mode">{item.calculationMode === "area" ? "m² bazlı" : "Adet bazlı"}</span><strong>{item.name}</strong><span>{item.materialName}</span>
          <span className="commerce-product-price">{money(item.unitPriceCents)} / {item.calculationMode === "area" ? "m²" : "adet"}</span><small>{item.taxIncluded ? "KDV dahil" : "+ KDV"}</small>
        </button>)}</div>
        {product.description && <p className="commerce-help">{product.description}</p>}
        <fieldset disabled={pending} className="commerce-fields"><legend className="mp-sr-only">Baskı ölçüleri ve işçilik</legend>
          <Field label="En (cm)"><input inputMode="decimal" value={width} onChange={(event) => setWidth(event.target.value)} /></Field>
          <Field label="Boy (cm)"><input inputMode="decimal" value={height} onChange={(event) => setHeight(event.target.value)} /></Field>
          <Field label="Adet"><input type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
          <Field label="Adet başına kuşgözü"><input type="number" min="0" step="1" value={eyelets} onChange={(event) => setEyelets(event.target.value)} /></Field>
          <p className="commerce-help commerce-full">Ölçüler santimetredir; ondalık için virgül veya nokta kullanabilirsiniz. Kuşgözü sayısı her bir baskı için girilir.</p>
          <label className="commerce-check commerce-full"><input type="checkbox" checked={weldEdges} onChange={(event) => setWeldEdges(event.target.checked)} />Kenar kaynağı <small>{money(product.weldPricePerMetreCents)} / metre</small></label>
          <label className="commerce-check commerce-full"><input type="checkbox" checked={hemEdges} onChange={(event) => setHemEdges(event.target.checked)} />Kenar kıvırma <small>{money(product.hemPricePerMetreCents)} / metre</small></label>
          <p className="commerce-help commerce-full">Kaynak ve kıvırma ayrı işçiliklerdir. Seçilen her işçilik, her baskının tam çevresi üzerinden belirlenir. Kuşgözü: {money(product.eyeletPriceCents)} / adet.</p>
        </fieldset>
      </section>
      <aside className="commerce-panel commerce-estimate"><span className="commerce-eyebrow">ANLIK HESAP</span><h2>Bu kalemin ön hesabı</h2>
        {preview ? <><div className="commerce-measures"><span>Toplam alan<strong>{number(preview.lines[0]!.areaSqm)} m²</strong></span><span>Toplam çevre<strong>{number(preview.lines[0]!.perimeterMetres)} m</strong></span></div><QuoteSummary quote={preview} />
          <button type="button" className="commerce-primary" disabled={pending || cart.length >= CATALOGUE_LIMITS.maxLines} onClick={() => { if (selection) { setCart((current) => [...current, { ...selection }]); setError(""); setOrder(null); } }}>Sepete ekle</button>
          {cart.length >= CATALOGUE_LIMITS.maxLines && <p role="note">Bir siparişe en fazla {number(CATALOGUE_LIMITS.maxLines)} kalem eklenebilir.</p>}</>
          : <p role="alert">Geçerli ölçü, tam sayı adet ve kuşgözü sayısı girin.</p>}
        <p className="commerce-help">Tek kalem hesabıdır; toplam sepet tutarı aşağıda gösterilir. Kesin fiyat sipariş sırasında sunucuda yeniden belirlenir.</p>
      </aside>
    </div>}
    {cart.length > 0 && <section className="commerce-panel commerce-cart"><div className="commerce-section-head"><h2>Sepetiniz <span>({number(cart.length)} kalem)</span></h2><button type="button" disabled={pending || catalogue.loading} onClick={() => void reloadProducts()}>Güncel fiyatları yükle</button></div>
      <ol className="commerce-cart-lines">{cart.map((line, index) => <li key={index}><div><strong>{catalogue.products.find((item) => item.id === line.productId)?.name ?? "Artık satışta olmayan ürün"}</strong><p>{number(line.widthMm / 10)} × {number(line.heightMm / 10)} cm · {number(line.quantity)} adet · Baskı başına {number(line.eyeletsPerItem)} kuşgözü</p>
        <small>{line.weldEdges ? "Kenar kaynağı" : "Kaynak yok"} · {line.hemEdges ? "Kenar kıvırma" : "Kıvırma yok"}</small></div>
        <strong>{cartQuote ? money(cartQuote.lines[index]!.totalCents) : "Fiyat güncellenmeli"}</strong><button type="button" disabled={pending} aria-label={`${index + 1}. kalemi sepetten çıkar`} onClick={() => setCart((current) => current.filter((_, i) => i !== index))}>Çıkar</button></li>)}</ol>
      {cartQuote ? <form onSubmit={(event) => void submit(event)} className="commerce-checkout" aria-busy={pending}><fieldset disabled={pending} className="commerce-fields"><legend>Müşteri bilgileri</legend>
        <Field label="Adınız veya şirketiniz"><input autoComplete="name" required maxLength={200} value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></Field>
        <Field label="E-posta"><input type="email" autoComplete="email" required maxLength={254} value={customer.email} onChange={(event) => setCustomer({ ...customer, email: event.target.value })} /></Field>
        <p className="commerce-help commerce-full">Siparişten sonra baskı dosyanızı yükleyip ilgili prova sürümünü onaylayabilirsiniz. Bu adımda kart bilgisi alınmaz.</p>
      </fieldset><div><QuoteSummary quote={cartQuote} /><button type="submit" className="commerce-primary" disabled={pending}>{pending ? "Sipariş kaydediliyor…" : "Siparişi oluştur"}</button></div></form>
        : <p role="alert">{cartError}</p>}
      {error && <p role="alert" className="commerce-alert">{error}</p>}
    </section>}
  </main>;
}

function draftOf(product: CatalogueProduct): CatalogueProductDraft {
  return { name: product.name, description: product.description, materialName: product.materialName, calculationMode: product.calculationMode, active: product.active,
    unitPriceCents: product.unitPriceCents, minimumOrderCents: product.minimumOrderCents, eyeletPriceCents: product.eyeletPriceCents,
    weldPricePerMetreCents: product.weldPricePerMetreCents, hemPricePerMetreCents: product.hemPricePerMetreCents,
    taxRateBps: product.taxRateBps, taxIncluded: product.taxIncluded, leadDays: product.leadDays };
}

export function CatalogueManager() {
  const catalogue = useCatalogue("staff");
  const [editing, setEditing] = useState<CatalogueProduct | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return <main className="commerce" lang="tr" dir="ltr"><header className="commerce-section-head"><div><span className="commerce-eyebrow">MATBAA YÖNETİMİ</span><h1>Ürünler ve satış tutarları</h1><p>Yeni ürün ekleyin; tutarları, işçilikleri ve satış durumunu düzenleyin.</p></div><button type="button" disabled={busy} onClick={() => { setEditing(null); setSaved(false); setFormVersion((current) => current + 1); }}>Yeni ürün</button></header>
    <LoadState loading={catalogue.loading} failed={catalogue.failed} reload={catalogue.reload} />
    {saved && <p role="status" className="commerce-notice">Ürün kaydedildi.</p>}
    <div className="commerce-admin-layout"><section className="commerce-panel"><h2>Kayıtlı ürünler</h2><button type="button" onClick={() => void catalogue.reload()} disabled={busy || catalogue.loading}>Listeyi yenile</button>
      {!catalogue.loading && !catalogue.failed && catalogue.products.length === 0 && <p>Henüz ürün eklenmedi.</p>}
      <ul className="commerce-admin-products">{catalogue.products.map((product) => <li key={product.id}><div><strong>{product.name}</strong><p>{product.materialName} · {money(product.unitPriceCents)} / {product.calculationMode === "area" ? "m²" : "adet"}</p><small>{product.active ? "Satışta" : "Arşivde"} · {product.taxIncluded ? "KDV dahil" : "+ KDV"}</small></div><button type="button" disabled={busy} aria-label={`${product.name} ürününü düzenle`} onClick={() => { setEditing(product); setSaved(false); }}>Düzenle</button></li>)}</ul>
    </section><ProductEditor key={editing ? `${editing.id}-${editing.revision}` : `new-${formVersion}`} product={editing} onPending={setBusy} onSaved={(product) => { catalogue.setProducts((current) => [...current.filter((item) => item.id !== product.id), product]); setEditing(product); setSaved(true); }} /></div>
  </main>;
}

const moneyFields = [
  ["unitPriceCents", "Birim tutar (TL)"], ["minimumOrderCents", "En az sipariş tutarı (TL)"], ["eyeletPriceCents", "Kuşgözü / adet (TL)"],
  ["weldPricePerMetreCents", "Kenar kaynağı / metre (TL)"], ["hemPricePerMetreCents", "Kenar kıvırma / metre (TL)"],
] as const;

function ProductEditor({ product, onSaved, onPending }: { product: CatalogueProduct | null; onSaved: (saved: CatalogueProduct) => void; onPending: (pending: boolean) => void }) {
  const initial: CatalogueProductDraft = product ? draftOf(product) : { ...BANNER_PRODUCT_DRAFT, name: "", description: "", materialName: "", taxIncluded: false };
  const [draft, setDraft] = useState(initial);
  const [amounts, setAmounts] = useState(() => Object.fromEntries(moneyFields.map(([key]) => [key, String(initial[key] / 100)])) as Record<(typeof moneyFields)[number][0], string>);
  const [tax, setTax] = useState(String(initial.taxRateBps / 100));
  const [lead, setLead] = useState(String(initial.leadDays));
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !event.currentTarget.reportValidity()) return;
    let payload: CatalogueProductDraft;
    try {
      payload = validateCatalogueProductDraft({ ...draft, name: draft.name.trim(), materialName: draft.materialName.trim(), description: draft.description.trim(),
        ...Object.fromEntries(moneyFields.map(([key]) => [key, cents(amounts[key])])), taxRateBps: cents(tax), leadDays: decimal(lead) });
      if (!payload.name || !payload.materialName || !Number.isInteger(payload.leadDays)) throw new Error("INVALID_PRODUCT");
    } catch { setError("Alanları kontrol edin. Tutarları en fazla iki ondalık basamakla; hazırlık süresini tam gün olarak yazın."); return; }
    pendingRef.current = true;
    setPending(true);
    onPending(true);
    setError("");
    try {
      const gateway = getShopGateway();
      if (!gateway?.createCatalogueProduct || !gateway.updateCatalogueProduct) throw new Error("UNAVAILABLE");
      const saved = product ? await gateway.updateCatalogueProduct(product.id, product.revision, payload) : await gateway.createCatalogueProduct(payload);
      onSaved(saved);
    } catch { setError("Kaydetme sonucu doğrulanamadı. Güncel verileri yeniden yükleyip ürünü tekrar açın; yeniden kaydetmeden önce kayıtlı bilgileri kontrol edin."); }
    finally { pendingRef.current = false; setPending(false); onPending(false); }
  }
  return <section className="commerce-panel"><h2>{product ? "Ürünü düzenle" : "Yeni ürün ekle"}</h2><form onSubmit={(event) => void submit(event)} aria-busy={pending}><fieldset className="commerce-fields" disabled={pending}><legend className="mp-sr-only">Ürün bilgileri</legend>
    <Field label="Ürün adı"><input required maxLength={160} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
    <Field label="Malzeme adı"><input required maxLength={160} value={draft.materialName} onChange={(event) => setDraft({ ...draft, materialName: event.target.value })} /></Field>
    <label className="commerce-field commerce-full"><span>Açıklama</span><textarea rows={3} maxLength={4000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
    <Field label="Hesaplama biçimi"><select value={draft.calculationMode} onChange={(event) => setDraft({ ...draft, calculationMode: event.target.value as "area" | "unit" })}><option value="area">Metrekare (m²)</option><option value="unit">Adet</option></select></Field>
    {moneyFields.map(([key, label]) => <Field key={key} label={label}><input required inputMode="decimal" value={amounts[key]} onChange={(event) => setAmounts({ ...amounts, [key]: event.target.value })} /></Field>)}
    <Field label="KDV oranı (%)"><input required inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} /></Field>
    <Field label="Hazırlık süresi (iş günü)"><input required type="number" min="0" max="365" step="1" value={lead} onChange={(event) => setLead(event.target.value)} /></Field>
    <label className="commerce-check commerce-full"><input type="checkbox" checked={draft.taxIncluded} onChange={(event) => setDraft({ ...draft, taxIncluded: event.target.checked })} />Birim tutarlara KDV dahildir</label>
    <label className="commerce-check commerce-full"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />Ürün satışta</label>
    <p className="commerce-help commerce-full">Satışı kapatılan ürün vitrinden kalkar; geçmiş siparişler korunur. Kaynak ve kıvırma tutarları ayrı ayrı tam çevreye uygulanır.</p>
    <button className="commerce-primary commerce-full" type="submit">{pending ? "Kaydediliyor…" : "Ürünü kaydet"}</button>
  </fieldset>{error && <p role="alert" className="commerce-alert">{error}</p>}</form></section>;
}

function OrderCard({ order, onFollow }: { order: CatalogueOrder; onFollow: Follow }) {
  return <article className="commerce-order"><div className="commerce-section-head"><h3><bdi>{order.ref}</bdi></h3><strong>{money(order.totalCents)}</strong></div>
    <p>Sipariş: {date(order.placedOn)} · Hazır olacağı gün: {date(order.readyBy)}</p>
    <ul>{order.lines.map((line) => <li key={line.jobRef}><div><strong>{line.productName}</strong><p>{line.materialName} · {number(line.widthMm / 10)} × {number(line.heightMm / 10)} cm · {number(line.quantity)} adet</p><small>Hazır olacağı gün: {date(line.readyBy)}</small>
      <details className="commerce-order-calculation"><summary>Kaydedilen hesap ayrıntıları</summary><p>Toplam alan: {number(line.areaSqm)} m² · Toplam çevre: {number(line.perimeterMetres)} m</p>
        <p>Baskı başına {number(line.eyeletsPerItem)} kuşgözü · {line.weldEdges ? "Kenar kaynağı var" : "Kaynak yok"} · {line.hemEdges ? "Kenar kıvırma var" : "Kıvırma yok"}</p>
        <dl className="commerce-totals"><div><dt>Baskı bedeli</dt><dd>{money(line.baseCents)}</dd></div><div><dt>Kuşgözü</dt><dd>{money(line.eyeletsCents)}</dd></div><div><dt>Kenar kaynağı</dt><dd>{money(line.weldCents)}</dd></div><div><dt>Kenar kıvırma</dt><dd>{money(line.hemCents)}</dd></div></dl>
        <p className="commerce-help">Bu kalem tutarları sipariş anındaki {line.taxIncluded ? "KDV dahil" : "KDV hariç"} tutarlardır.</p>
      </details></div>
      <button type="button" onClick={() => onFollow(line.jobRef, order.customer.email)}>Dosya yükle ve takip et <bdi>{line.jobRef}</bdi></button></li>)}</ul>
    <dl className="commerce-totals"><div><dt>En az sipariş farkı ({order.lines[0]?.taxIncluded ? "KDV dahil" : "KDV hariç"})</dt><dd>{money(order.minimumTopUpCents)}</dd></div><div><dt>KDV hariç toplam</dt><dd>{money(order.subtotalCents)}</dd></div><div><dt>KDV</dt><dd>{money(order.taxCents)}</dd></div><div><dt>Toplam</dt><dd>{money(order.totalCents)}</dd></div></dl>
  </article>;
}

export function CatalogueOrderHistory({ onFollow, orders }: { onFollow: Follow; orders?: CatalogueOrder[] }) {
  const [loaded, setLoaded] = useState<CatalogueOrder[]>(orders ?? []);
  const [loading, setLoading] = useState(orders === undefined);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (orders !== undefined) { setLoaded(orders); setLoading(false); return; }
    let live = true;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const gateway = getShopGateway();
        if (!gateway) throw new Error("UNAVAILABLE");
        const snapshot = await gateway.bootstrap("customer");
        if (live) setLoaded(snapshot.catalogueOrders ?? []);
      } catch { if (live) setFailed(true); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [orders, generation]);
  return <section className="commerce" lang="tr" dir="ltr"><h1>Siparişlerim</h1><p>Bu tarayıcıdan oluşturduğunuz siparişler burada görünür.</p>
    {loading ? <p role="status">Siparişler yükleniyor…</p> : failed ? <p role="alert">Siparişler yüklenemedi. <button type="button" onClick={() => setGeneration((current) => current + 1)}>Tekrar dene</button></p>
      : loaded.length === 0 ? <p className="commerce-panel">Henüz siparişiniz bulunmuyor.</p> : [...loaded].reverse().map((order) => <div key={order.ref} className="commerce-panel"><OrderCard order={order} onFollow={onFollow} /></div>)}
  </section>;
}
