import { useI18n } from "../i18n/index.tsx";

/** Keep this independent of the store: a failed bootstrap has no usable source. */
export default function LiveStartupError({ retry }: { retry: () => void }) {
  const { t } = useI18n();
  return (
    <main className="mp-main">
      <div className="mp-wrap mp-stack" role="alert" style={{ maxInlineSize: 560 }}>
        <h1>{t("live.serviceUnavailable")}</h1>
        <button className="mp-button mp-btn" type="button" onClick={retry}>{t("live.retry")}</button>
      </div>
    </main>
  );
}
