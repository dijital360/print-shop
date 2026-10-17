import { useId, useRef, useState, type FormEvent } from "react";

import { MAX_JOB_FILE_BYTES, MAX_JOB_FILES, type JobFile, type ShopSide } from "../data/shopContract.ts";
import { jobFileUrl } from "../data/shopHttp.ts";
import { useI18n } from "../i18n/index.tsx";
import type { Job } from "../lib/jobs.ts";
import { useStore } from "../state/store.ts";
import { Typed } from "./Primitives.tsx";

/** Approval belongs to the last published version, after any requested change. */
export function currentProofFile(job: Job): JobFile | null {
  const event = job.proofs.at(-1);
  if (event?.kind !== "sent" || event.fileId === undefined) return null;
  return job.files?.find((file) => file.id === event.fileId && file.kind === "proof") ?? null;
}

function lastProofFile(job: Job): JobFile | null {
  const event = [...job.proofs].reverse().find((entry) => entry.kind === "sent" && entry.fileId !== undefined);
  return job.files?.find((file) => file.id === event?.fileId && file.kind === "proof") ?? null;
}

/** Files are links to scoped server routes; uploads go through the store. */
export function JobFiles({ job, side }: { job: Job; side: ShopSide }) {
  const { t } = useI18n();
  const proof = lastProofFile(job);
  const proofNote = [...job.proofs].reverse().find((entry) => entry.kind === "sent" && entry.fileId === proof?.id)?.note;
  return (
    <div className="mp-stack" style={{ gap: 16 }}>
      <section className="mp-panel mp-panel-pad">
        <h2 className="mp-h2">{t("live.files.artworkTitle")}</h2>
        <FileVersions job={job} kind="artwork" side={side} />
        {side === "customer" && <FileUpload key={job.ref} job={job} kind="artwork" />}
      </section>
      <section className="mp-panel mp-panel-pad">
        <h2 className="mp-h2">{t("live.files.proofTitle")}</h2>
        {side === "staff" && <FileUpload key={job.ref} job={job} kind="proof" />}
        {proof === null ? <p>{t("live.files.noProof")}</p> : (
          <div className="mp-stack" style={{ gap: 10, marginBlock: 14 }}>
            <strong><Typed>{proof.filename}</Typed></strong>
            {proofNote && <p><Typed>{proofNote}</Typed></p>}
            {proof.mediaType === "image/png" || proof.mediaType === "image/jpeg" ? (
              <img src={jobFileUrl(job.ref, proof.id, side)} alt={t("live.files.previewAlt", { filename: proof.filename })}
                style={{ display: "block", maxInlineSize: "100%", maxBlockSize: 480, objectFit: "contain", border: "1px solid var(--border)", borderRadius: 10 }} />
            ) : (
              <a className="mp-button mp-button--ghost mp-btn" href={jobFileUrl(job.ref, proof.id, side)} target="_blank" rel="noopener noreferrer">
                {t("live.files.openProof")}
              </a>
            )}
            {job.proofs.at(-1)?.kind === "change-asked" && <p role="note">{t("live.files.awaitingProof")}</p>}
          </div>
        )}
        <FileVersions job={job} kind="proof" side={side} />
      </section>
    </div>
  );
}

function FileVersions({ job, kind, side }: { job: Job; kind: JobFile["kind"]; side: ShopSide }) {
  const { t, number, date } = useI18n();
  const files = (job.files ?? []).filter((file) => file.kind === kind);
  if (files.length === 0) return kind === "artwork" ? <p>{t("live.files.noArtwork")}</p> : null;
  return (
    <ul className="mp-stack" style={{ listStyle: "none", padding: 0, gap: 10 }}>
      {files.map((file, index) => (
        <li key={file.id} style={{ borderBlockEnd: "1px solid var(--border)", paddingBlock: 10, overflowWrap: "anywhere" }}>
          <div className="mp-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span><strong>{t("live.files.version", { version: index + 1 })}</strong> · <Typed>{file.filename}</Typed></span>
            <a className="mp-button mp-button--ghost mp-btn" href={jobFileUrl(job.ref, file.id, side, true)} download={file.filename}>
              {t("live.files.download")} <span className="mp-sr-only"><Typed>{file.filename}</Typed></span>
            </a>
          </div>
          <small style={{ color: "var(--fg-muted)" }}>
            {t("live.files.size", { size: number(file.size / 1024, { maximumFractionDigits: 1 }) })} · {date(new Date(file.uploadedAt), { dateStyle: "medium", timeStyle: "short" })}
          </small>
        </li>
      ))}
    </ul>
  );
}

function FileUpload({ job, kind }: { job: Job; kind: JobFile["kind"] }) {
  const { t } = useI18n();
  const upload = useStore((state) => state.uploadJobFile);
  const pending = useStore((state) => state.pendingJobs.includes(job.ref));
  const inputRef = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<"saved" | "failed" | "invalid" | null>(null);
  const full = (job.files?.length ?? 0) >= (kind === "artwork" ? MAX_JOB_FILES - 1 : MAX_JOB_FILES);
  const editable = ["ordered", "prepress", "proofed", "approved"].includes(job.stage);
  const artworkRequired = kind === "proof" && !(job.files ?? []).some((entry) => entry.kind === "artwork");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || full || !editable || artworkRequired || file === null) return;
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const mediaType = file.type || ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" } as Record<string, string>)[extension ?? ""];
    if (file.size === 0 || file.size > MAX_JOB_FILE_BYTES || !["application/pdf", "image/png", "image/jpeg"].includes(mediaType ?? "")) {
      setFeedback("invalid");
      return;
    }
    setFeedback(null);
    let saved = false;
    try { saved = await upload(job.ref, kind, file, kind === "proof" ? note.trim() : undefined); } catch { /* Keep the selected file available for retry. */ }
    if (!saved) { setFeedback("failed"); return; }
    setFile(null);
    setNote("");
    if (inputRef.current !== null) inputRef.current.value = "";
    setFeedback("saved");
  }

  if (!editable) return <p role="note">{t("live.files.readOnly")}</p>;

  return (
    <form onSubmit={(event) => void submit(event)} style={{ marginBlockStart: 16 }} aria-busy={pending}>
      <p id={helpId} style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        {t("live.files.help", { maxSize: MAX_JOB_FILE_BYTES / 1024 / 1024, maxFiles: MAX_JOB_FILES })}
      </p>
      {full && <p role="note">{t("live.files.limit")}</p>}
      {artworkRequired && <p role="note">{t("live.files.artworkRequired")}</p>}
      <fieldset disabled={pending || full || artworkRequired} className="mp-stack" style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0, gap: 12 }}>
        <label className="mp-field">
          <span className="mp-label">{t(kind === "artwork" ? "live.files.chooseArtwork" : "live.files.chooseProof")}</span>
          <input ref={inputRef} type="file" className="mp-input mp-fld" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            required aria-describedby={helpId} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setFeedback(null); }} />
        </label>
        {kind === "proof" && <label className="mp-field">
          <span className="mp-label">{t("live.files.note")}</span>
          <textarea className="mp-input mp-fld" rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>}
        <button type="submit" className="mp-button mp-btn" disabled={file === null || pending || full || artworkRequired}>
          {t(pending ? "live.files.uploading" : kind === "artwork" ? "live.files.uploadArtwork" : "live.files.publishProof")}
        </button>
      </fieldset>
      {feedback === "saved" && <p role="status">{t(kind === "artwork" ? "live.files.saved" : "live.files.published")}</p>}
      {feedback === "failed" && <p role="alert">{t("live.files.failed")}</p>}
      {feedback === "invalid" && <p role="alert">{t("live.files.invalid")}</p>}
    </form>
  );
}
