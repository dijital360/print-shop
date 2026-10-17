/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobFile, ShopGateway, ShopSide } from "../data/shopContract.ts";
import { configureShopGateway } from "../data/shopGateway.ts";
import { I18nProvider } from "../i18n/index.tsx";
import type { Job } from "../lib/jobs.ts";
import { OrderLookup } from "../screens/CustomerOrder.tsx";
import { Ticket } from "../screens/Shop.tsx";
import { useStore } from "../state/store.ts";
import { currentProofFile, JobFiles } from "./JobFiles.tsx";

vi.mock("../surface.ts", () => ({ LIVE: true, HOSTED: false, APP_KEY: "printing", CONNECTED: false, SURFACE_SIDE: null, DEMO: false }));

let host: HTMLDivElement;
let root: Root;
let gateway: ShopGateway;
let job: Job;

const original: JobFile = { id: "art-1", kind: "artwork", filename: "original.pdf", mediaType: "application/pdf", size: 1024, uploadedAt: "2026-10-17T10:00:00Z" };
const proof: JobFile = { id: "proof-1", kind: "proof", filename: "proof-v1.png", mediaType: "image/png", size: 2048, uploadedAt: "2026-10-17T11:00:00Z" };

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  localStorage.setItem("print-shop-locale", "en-US");
  useStore.setState(useStore.getInitialState(), true);
  job = { ...structuredClone(useStore.getState().jobs[0]!), ref: "JOB-PRIVATE-1", revision: 3, stage: "prepress", proofs: [], files: [original] };
  useStore.setState({ jobs: [job], pastJobs: [], artwork: [], loading: false, ticketRef: job.ref, lookupResult: { kind: "job", ref: job.ref } });
  gateway = { bootstrap: vi.fn(), createOrder: vi.fn(), changeJob: vi.fn(), uploadJobFile: vi.fn(), login: vi.fn(), logout: vi.fn() };
  configureShopGateway(gateway);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  configureShopGateway(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function FilesHarness({ side }: { side: ShopSide }) {
  const saved = useStore((state) => state.jobs[0]!);
  return <JobFiles job={saved} side={side} />;
}

function render(side: ShopSide = "customer") {
  act(() => root.render(<I18nProvider><FilesHarness side={side} /></I18nProvider>));
}

function choose(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  return input;
}

async function submit() {
  // jsdom has no native file picker; deliver its resulting submit event.
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("private job files", () => {
  it("keeps artwork pending until acknowledgement and links saved versions to the customer scope", async () => {
    let acknowledge: ((value: Job) => void) | undefined;
    vi.mocked(gateway.uploadJobFile).mockImplementation(() => new Promise<Job>((resolve) => { acknowledge = resolve; }));
    render();
    const file = new File(["%PDF-1.7 artwork"], "revision.pdf", { type: "application/pdf" });
    choose(file);
    await submit();
    expect(gateway.uploadJobFile).toHaveBeenCalledWith(job.ref, 3, "artwork", file, undefined);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(useStore.getState().jobs[0]?.files).toEqual([original]);
    const uploaded: JobFile = { ...original, id: "art-2", filename: file.name, size: file.size };
    await act(async () => acknowledge!({ ...job, revision: 4, files: [original, uploaded] }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Artwork file saved");
    expect(host.textContent).toContain("Version 2");
    const download = [...host.querySelectorAll("a")].find((anchor) => anchor.getAttribute("download") === "revision.pdf")!;
    expect(download.getAttribute("href")).toBe("/api/shop/jobs/JOB-PRIVATE-1/files/art-2?side=customer&download=1");
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.value).toBe("");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("keeps the selected file after a failed save and accepts a valid extension when MIME is empty", async () => {
    vi.mocked(gateway.uploadJobFile).mockRejectedValue(new Error("Private storage detail"));
    render();
    const file = new File(["%PDF-1.7"], "artwork.PDF");
    const input = choose(file);
    await submit();
    expect(gateway.uploadJobFile).toHaveBeenCalledWith(job.ref, 3, "artwork", file, undefined);
    expect(input.files?.[0]).toBe(file);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("selection is kept");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain("Private storage detail");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(useStore.getState().jobs[0]?.files).toEqual([original]);
  });

  it.each(["empty", "oversize", "unsupported"])("rejects an %s file before requesting storage", async (kind) => {
    render();
    const file = kind === "empty" ? new File([], "empty.pdf", { type: "application/pdf" })
      : new File(["data"], kind === "unsupported" ? "unsafe.svg" : "large.png", { type: kind === "unsupported" ? "image/svg+xml" : "image/png" });
    if (kind === "oversize") Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });
    choose(file);
    await submit();
    expect(gateway.uploadJobFile).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("non-empty PDF, PNG or JPEG");
  });

  it("publishes a real proof with an optional note and offers a safe PDF link plus download", async () => {
    const pdf: JobFile = { ...proof, mediaType: "application/pdf", filename: "proof-final.pdf" };
    vi.mocked(gateway.uploadJobFile).mockResolvedValue({ ...job, revision: 4, stage: "proofed", files: [original, pdf], proofs: [{ kind: "sent", at: "2026-10-17", fileId: pdf.id }] });
    render("staff");
    const textarea = host.querySelector("textarea")!;
    expect(textarea.maxLength).toBe(1000);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "  Please check the spelling.  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const file = new File(["%PDF-1.7"], pdf.filename, { type: pdf.mediaType });
    choose(file);
    await submit();
    expect(gateway.uploadJobFile).toHaveBeenCalledWith(job.ref, 3, "proof", file, "Please check the spelling.");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("published for customer review");
    const open = host.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(open.getAttribute("href")).toBe("/api/shop/jobs/JOB-PRIVATE-1/files/proof-1?side=staff");
    expect(open.rel).toContain("noopener");
    expect(open.rel).toContain("noreferrer");
    expect(host.querySelector('a[download="proof-final.pdf"]')).not.toBeNull();
    expect(host.querySelector("iframe, object, embed")).toBeNull();
    expect(host.querySelector("textarea")?.value).toBe("");
  });

  it("reserves the last version for a proof and keeps downloads after production starts", () => {
    const versions = Array.from({ length: 19 }, (_, index) => ({ ...original, id: `art-${index}` }));
    useStore.setState({ jobs: [{ ...job, files: versions }] });
    render();
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.textContent).toContain("last space is reserved for a proof");
    expect(host.textContent).toContain("reached its file limit");
    expect(host.querySelectorAll("a[download]")).toHaveLength(19);
    render("staff");
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    act(() => useStore.setState({ jobs: [{ ...job, stage: "printing", files: versions }] }));
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.textContent).toContain("Files can only be changed during prepress");
    expect(host.querySelectorAll("a[download]")).toHaveLength(19);
  });

  it("shows approval only for the latest published file and keeps its preview after server-confirmed approval", async () => {
    const sent = { kind: "sent" as const, at: "2026-10-17", fileId: proof.id, note: "Check the customer-supplied spelling." };
    const published: Job = { ...job, stage: "proofed", files: [original, proof], proofs: [sent] };
    expect(currentProofFile({ ...published, proofs: [{ ...sent, fileId: "missing" }] })).toBeNull();
    expect(currentProofFile({ ...published, proofs: [sent, { kind: "change-asked", at: "2026-10-17" }] })).toBeNull();
    useStore.setState({ jobs: [{ ...published, proofs: [sent, { kind: "change-asked", at: "2026-10-17" }] }] });
    act(() => root.render(<I18nProvider><OrderLookup /></I18nProvider>));
    const approve = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Approve the proof"));
    expect(approve()).toBeUndefined();
    expect(host.textContent).toContain("A new proof is needed before approval");
    act(() => useStore.setState({ jobs: [published] }));
    const image = host.querySelector("img")!;
    expect([...host.querySelectorAll('[dir="auto"]')].some((element) => element.textContent === sent.note)).toBe(true);
    expect(image.alt).toBe("Proof preview: proof-v1.png");
    expect(image.getAttribute("src")).toBe("/api/shop/jobs/JOB-PRIVATE-1/files/proof-1?side=customer");
    let acknowledge: ((value: Job) => void) | undefined;
    vi.mocked(gateway.changeJob).mockImplementation(() => new Promise<Job>((resolve) => { acknowledge = resolve; }));
    act(() => approve()!.click());
    expect(approve()?.disabled).toBe(true);
    expect(gateway.changeJob).toHaveBeenCalledWith(job.ref, 3, { kind: "approve-proof" });
    expect(host.textContent).not.toContain("Proof approved — it's on the schedule.");
    await act(async () => acknowledge!({ ...published, revision: 4, stage: "approved", proofs: [sent, { kind: "approved", at: "2026-10-17", fileId: proof.id }] }));
    expect(approve()).toBeUndefined();
    expect(host.textContent).toContain("Proof approved — it's on the schedule.");
    expect(host.querySelector("img")?.getAttribute("src")).toContain("proof-1?side=customer");
  });

  it("replaces the live ticket's simulated preflight and send-by-email action with real files", () => {
    useStore.setState({ jobs: [{ ...job, files: [original, proof], proofs: [{ kind: "sent", at: "2026-10-17", fileId: proof.id }] }] });
    act(() => root.render(<I18nProvider><Ticket /></I18nProvider>));
    expect(host.textContent).toContain("Upload and publish proof");
    expect(host.querySelectorAll(".mp-verdict")).toHaveLength(0);
    expect(host.querySelector('a[download="original.pdf"]')?.getAttribute("href")).toContain("side=staff");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Send proof")).toBe(false);
  });
});
