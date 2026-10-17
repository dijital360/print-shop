import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PRODUCTS, PRODUCT_BY_KEY, incompatibleReason } from '../src/lib/catalogue.ts';
import { MATERIALS, DELIVERY_BY_KEY, TAX_RATE, LARGE_FORMAT_MAX_QUANTITY } from '../src/lib/rates.ts';
import { addWorkingDays, priceQuote, promiseFor } from '../src/lib/quote.ts';
import type { JobCommand, OrderReceipt, OrderSubmission, ShopSnapshot } from '../src/data/shopContract.ts';
import { MAX_JOB_FILES } from '../src/data/shopContract.ts';
import type { JobFile } from '../src/data/shopContract.ts';
import type { BasketLine, PlacedOrder } from '../src/state/store.ts';
import type { Database } from './database.ts';
import { FileValidationError, validateJobFile } from './fileValidation.ts';
import type { JobFileInput } from './fileValidation.ts';

type Job = ShopSnapshot['jobs'][number];
type Works = ShopSnapshot['works'];
type Scope = { side: 'customer' | 'staff'; customerHash?: string };
type Config = BasketLine['config'];

export class RepoError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code: string, status: number, message?: string): never => { throw new RepoError(code, status, message); };
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_ORDER', 400, 'An object is required.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) return fail('INVALID_ORDER', 400, 'Unknown field.');
  return result;
}
function text(value: unknown, maximum: number, required = true): string {
  if (typeof value !== 'string' || value.length > maximum) return fail('INVALID_ORDER', 400, 'Invalid text.');
  const clean = value.trim();
  if ((required && !clean) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) return fail('INVALID_ORDER', 400, 'Invalid text.');
  return clean;
}
function positiveInteger(value: unknown, maximum = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) return fail('INVALID_ORDER', 400, 'Invalid quantity.');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateSubmission(input: OrderSubmission): OrderSubmission {
  const body = object(input, ['requestKey', 'customer', 'lines', 'deliveryChoice']);
  const requestKey = text(body.requestKey, 128);
  const details = object(body.customer, ['name', 'email']);
  const customer = { name: text(details.name, 200), email: text(details.email, 254).toLowerCase() };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) return fail('INVALID_ORDER', 400, 'A valid email is required.');
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 50) return fail('INVALID_ORDER', 400, 'Orders require 1–50 lines.');
  if (body.deliveryChoice !== null) return fail('INVALID_ORDER', 400, 'Carrier quotations are not available yet.');
  const ids = new Set<string>();
  const lines: BasketLine[] = body.lines.map((value) => {
    const line = object(value, ['id', 'config', 'artwork']);
    const id = text(line.id, 128);
    if (ids.has(id)) return fail('INVALID_ORDER', 400, 'Line identifiers must be unique.');
    ids.add(id);
    const raw = object(line.config, ['product', 'material', 'size', 'customWidthMm', 'customHeightMm', 'sides', 'finish', 'quantity', 'packaging', 'printedProof', 'express', 'delivery']);
    if (typeof raw.product !== 'string' || !Object.hasOwn(PRODUCT_BY_KEY, raw.product)) return fail('INVALID_ORDER', 400, 'Unknown product.');
    const product = PRODUCT_BY_KEY[raw.product as Config['product']];
    if (typeof raw.material !== 'string' || !product.materials.includes(raw.material as Config['material']) ||
        typeof raw.size !== 'string' || !product.sizes.includes(raw.size) ||
        typeof raw.finish !== 'string' || !product.finishes.includes(raw.finish as Config['finish']) ||
        typeof raw.packaging !== 'string' || !product.packaging.includes(raw.packaging as Config['packaging']) ||
        typeof raw.delivery !== 'string' || !Object.hasOwn(DELIVERY_BY_KEY, raw.delivery) ||
        (raw.sides !== 1 && raw.sides !== 2) || (!product.sidesChoice && raw.sides !== 1) ||
        typeof raw.express !== 'boolean' || typeof raw.printedProof !== 'boolean') return fail('INVALID_ORDER', 400, 'Unsupported product options.');
    const quantity = positiveInteger(raw.quantity, product.quantityMode === 'small-run' ? LARGE_FORMAT_MAX_QUANTITY : 1_000_000);
    if (incompatibleReason(raw.finish as Config['finish'], raw.material as Config['material'])) return fail('INVALID_ORDER', 400, 'The finish is incompatible with the material.');
    const config: Config = {
      product: product.key, material: raw.material as Config['material'], size: raw.size,
      sides: raw.sides, finish: raw.finish as Config['finish'], quantity,
      packaging: raw.packaging as Config['packaging'], printedProof: raw.printedProof,
      express: raw.express, delivery: raw.delivery as Config['delivery'],
    };
    for (const key of ['customWidthMm', 'customHeightMm'] as const) {
      if (raw[key] !== undefined) {
        const dimension = raw[key];
        if (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0 || dimension > 100_000 || Math.abs(Math.round(dimension * 10) - dimension * 10) > 1e-7) return fail('INVALID_ORDER', 400, 'Invalid dimensions.');
        config[key] = dimension;
      }
    }
    if (config.size === 'custom' && (config.customWidthMm === undefined || config.customHeightMm === undefined)) return fail('INVALID_ORDER', 400, 'Custom dimensions are required.');
    const quote = priceQuote(config);
    if (quote.blocked.length || !Number.isSafeInteger(quote.totalCents) || quote.totalCents < 0 || quote.totalCents > 999_999_999_999 || (product.press === 'sheet' && quote.up === 0)) return fail('INVALID_ORDER', 400, 'This configuration cannot be quoted.');
    if (line.artwork === undefined) return { id, config };
    const artwork = object(line.artwork, ['filename', 'source']);
    return { id, config, artwork: { filename: text(artwork.filename, 255), ...(artwork.source === undefined ? {} : { source: text(artwork.source, 80) }) } };
  });
  return { requestKey, customer, lines, deliveryChoice: null };
}

interface JobRow {
  id: number; ref: string; product_key: string; material_key: string; customer_name: string;
  quantity: number; trim_width_mm: string | number; trim_height_mm: string | number;
  sides: 1 | 2; finish_key: string; packaging_key: string; stage: Job['stage']; promised_date: string;
  express: boolean; spoiled_sheets: number; revision: number; owner_session_hash: string | null;
  proofs: { kind: Job['proofs'][number]['kind']; at: string; note: string | null; fileId: string | null }[];
  files: (JobFile & { artworkId: string | null })[];
  dispatch: { kind: 'collected' | 'carrier'; at: string; tracking: string | null } | null;
}

const JOB_SELECT = `SELECT j.*, p.key AS product_key, m.key AS material_key,
  COALESCE(o.snapshot->'customer'->>'name', c.name) AS customer_name,
  to_char(j.promised_for, 'YYYY-MM-DD') AS promised_date, o.owner_session_hash,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', pr.kind, 'at', to_char(pr.at, 'YYYY-MM-DD'), 'note', pr.note, 'fileId', pr.file_id) ORDER BY pr.id)
    FROM public.proofs pr WHERE pr.job_id=j.id), '[]'::jsonb) AS proofs,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'filename', f.filename,
    'mediaType', f.media_type, 'size', f.size, 'uploadedAt', f.uploaded_at, 'artworkId', f.artwork_id) ORDER BY f.version)
    FROM print_shop.job_files f WHERE f.job_id=j.id), '[]'::jsonb) AS files,
  (SELECT jsonb_build_object('kind', d.kind, 'at', d.at, 'tracking', d.tracking) FROM public.dispatches d WHERE d.job_id=j.id) AS dispatch
  FROM public.jobs j JOIN public.products p ON p.id=j.product_id
  JOIN public.materials m ON m.id=j.material_id JOIN public.customers c ON c.id=j.customer_id
  LEFT JOIN print_shop.orders o ON o.id=j.order_id`;

function jobFrom(row: JobRow): Job {
  return {
    ref: row.ref, productKey: row.product_key, materialKey: row.material_key, customer: row.customer_name,
    quantity: row.quantity, trimWidthMm: Number(row.trim_width_mm), trimHeightMm: Number(row.trim_height_mm),
    sides: row.sides, finishKey: row.finish_key, packagingKey: row.packaging_key,
    stage: row.stage, promisedFor: row.promised_date, express: row.express,
    proofs: row.proofs.map((proof) => ({ kind: proof.kind, at: proof.at, ...(proof.note === null ? {} : { note: proof.note }), ...(proof.fileId === null ? {} : { fileId: proof.fileId }) })),
    files: row.files.map(fileMetadata),
    spoiledSheets: row.spoiled_sheets, revision: row.revision,
    ...(row.dispatch === null ? {} : { dispatch: { kind: row.dispatch.kind, at: new Date(row.dispatch.at).toISOString(), ...(row.dispatch.tracking === null ? {} : { tracking: row.dispatch.tracking }) } }),
  };
}

function fileMetadata(file: JobFile): JobFile {
  return { id: file.id, kind: file.kind, filename: file.filename, mediaType: file.mediaType, size: file.size, uploadedAt: new Date(file.uploadedAt).toISOString() };
}

function currentProof(row: JobRow): boolean {
  const artwork = row.files.filter((file) => file.kind === 'artwork').at(-1);
  const proof = row.files.filter((file) => file.kind === 'proof').at(-1);
  return !!artwork && !!proof && proof.artworkId === artwork.id && row.proofs.at(-1)?.fileId === proof.id;
}

export class ShopRepository {
  private readonly db: Database;
  private readonly clock: () => Date;
  private readonly timezone: string;
  private readonly works: Works;

  constructor(db: Database, options: { now?: () => Date; timezone?: string; works?: Works } = {}) {
    this.db = db;
    this.clock = options.now ?? (() => new Date());
    this.timezone = options.timezone ?? 'Europe/Istanbul';
    this.works = options.works ?? { name: 'Print Shop', lines: [], city: '', postcode: '', country: '', countryCode: '', established: 0, people: 0 };
  }

  private now(): ShopSnapshot['now'] {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(this.clock());
    const get = (part: string) => parts.find((entry) => entry.type === part)!.value;
    return { iso: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
  }

  async initialize(): Promise<void> {
    await this.db.transaction(async (db) => {
      // Lock before inspecting emptiness so only the first instance may bootstrap.
      await db.query('SELECT pg_advisory_xact_lock(726543821)');
      const { rows } = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
      if (rows.length === 0) await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
      else {
        const existing = new Set(rows.map((row) => row.table_name));
        const missing = ['customers', 'products', 'materials', 'quotes', 'jobs', 'artwork', 'proofs', 'dispatches', 'stock_movements'].filter((table) => !existing.has(table));
        if (missing.length) fail('SCHEMA_REQUIRED', 503, `The existing database is missing required Print Shop tables: ${missing.join(', ')}.`);
      }
      await db.exec(await readFile(new URL('../db/migrations/001-orders.sql', import.meta.url), 'utf8'));
      await db.exec(await readFile(new URL('../db/migrations/002-job-files.sql', import.meta.url), 'utf8'));
      for (const product of PRODUCTS) await db.query('INSERT INTO public.products(key,name,family,from_quantity,sides_choice) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key) DO NOTHING', [product.key, product.key, product.family, product.fromQuantity, product.sidesChoice]);
      for (const material of MATERIALS) await db.query('INSERT INTO public.materials(key,name,kind,gsm,sheet_cost,on_hand,reorder_at) VALUES($1,$2,$3,$4,$5,0,0) ON CONFLICT(key) DO NOTHING', [material.key, material.key, material.kind, material.gsm || null, material.rateCents / 100]);
    });
  }

  async ensureCustomerSession(tokenHash: string, expiresAt: number): Promise<void> {
    this.checkSessionArguments(tokenHash, expiresAt);
    await this.db.query('INSERT INTO print_shop.customer_sessions(token_hash,expires_at) VALUES($1,$2) ON CONFLICT(token_hash) DO UPDATE SET expires_at=GREATEST(print_shop.customer_sessions.expires_at,EXCLUDED.expires_at)', [tokenHash, expiresAt]);
  }

  private checkSessionArguments(tokenHash: string, expiresAt: number): void {
    if (!tokenHash || tokenHash.length > 256 || !Number.isSafeInteger(expiresAt) || expiresAt <= this.clock().getTime()) fail('INVALID_REQUEST', 400, 'Invalid session metadata.');
  }

  async validCustomerSession(tokenHash: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM print_shop.customer_sessions WHERE token_hash=$1 AND expires_at>$2', [tokenHash, this.clock().getTime()])).rows.length > 0;
  }

  private async requireCustomer(db: Database, tokenHash?: string, lock = false): Promise<void> {
    if (!tokenHash || !(await db.query(`SELECT 1 FROM print_shop.customer_sessions WHERE token_hash=$1 AND expires_at>$2${lock ? ' FOR UPDATE' : ''}`, [tokenHash, this.clock().getTime()])).rows.length) fail('UNAUTHENTICATED', 401, 'The customer session has expired.');
  }

  private async nextReference(db: Database): Promise<string> {
    for (;;) {
      const { rows } = await db.query<{ number: string }>("SELECT nextval('print_shop.reference_seq')::text AS number");
      const ref = `PS-${rows[0]!.number.padStart(6, '0')}`;
      const used = await db.query('SELECT 1 FROM public.jobs WHERE ref=$1 UNION ALL SELECT 1 FROM public.quotes WHERE ref=$1 UNION ALL SELECT 1 FROM print_shop.orders WHERE ref=$1', [ref]);
      if (!used.rows.length) return ref;
    }
  }

  async createOrder(ownerHash: string, submission: OrderSubmission): Promise<OrderReceipt> {
    const clean = validateSubmission(submission);
    const hash = createHash('sha256').update(canonical({ customer: clean.customer, lines: clean.lines, deliveryChoice: clean.deliveryChoice })).digest('hex');
    return this.db.transaction(async (db) => {
      await this.requireCustomer(db, ownerHash, true);
      const previous = await db.query<{ id: string; snapshot: PlacedOrder; payload_hash: string }>('SELECT id,snapshot,payload_hash FROM print_shop.orders WHERE owner_session_hash=$1 AND request_key=$2', [ownerHash, clean.requestKey]);
      if (previous.rows[0]) {
        const saved = previous.rows[0];
        if (saved.payload_hash !== hash) fail('CONFLICT', 409, 'This request key already belongs to another basket.');
        const jobs = await db.query<JobRow>(`${JOB_SELECT} WHERE j.order_id=$1 ORDER BY j.id`, [saved.id]);
        return { order: saved.snapshot, jobs: jobs.rows.map(jobFrom) };
      }
      await db.query('INSERT INTO public.customers(name,email,town) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [clean.customer.name, clean.customer.email, '']);
      const customer = (await db.query<{ id: number }>('SELECT id FROM public.customers WHERE lower(email)=$1', [clean.customer.email])).rows[0]!;
      const now = this.now();
      const quotes = clean.lines.map((line) => priceQuote(line.config));
      const refs: string[] = [];
      for (let index = 0; index < clean.lines.length; index++) refs.push(await this.nextReference(db));
      const lines = clean.lines.map((line, index) => ({ ...line, jobRef: refs[index]!, subtotalCents: quotes[index]!.subtotalCents, readyBy: promiseFor(line.config, now).readyBy }));
      const subtotalCents = quotes.reduce((sum, quote) => sum + quote.subtotalCents, 0);
      const taxCents = Math.round(subtotalCents * TAX_RATE);
      const order: PlacedOrder = {
        ref: refs[0]!, customer: clean.customer, placedOn: now.iso,
        readyBy: lines.map((line) => line.readyBy).sort().at(-1)!, lines,
        deliveryChoice: null, subtotalCents, taxCents, totalCents: subtotalCents + taxCents,
      };
      const stored = (await db.query<{ id: string }>('INSERT INTO print_shop.orders(ref,owner_session_hash,request_key,payload_hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id', [order.ref, ownerHash, clean.requestKey, hash, JSON.stringify(order)])).rows[0]!;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const quote = quotes[index]!;
        await db.query(`INSERT INTO public.jobs(ref,customer_id,product_id,material_id,quantity,trim_width_mm,trim_height_mm,sides,finish_key,packaging_key,stage,promised_for,express,total,order_id)
          VALUES($1,$2,(SELECT id FROM public.products WHERE key=$3),(SELECT id FROM public.materials WHERE key=$4),$5,$6,$7,$8,$9,$10,'ordered',$11,$12,$13,$14)`,
        [line.jobRef, customer.id, line.config.product, line.config.material, line.config.quantity, quote.size.widthMm, quote.size.heightMm, line.config.sides, line.config.finish, line.config.packaging, line.readyBy, line.config.express, quote.totalCents / 100, stored.id]);
      }
      const jobs = await db.query<JobRow>(`${JOB_SELECT} WHERE j.order_id=$1 ORDER BY j.id`, [stored.id]);
      return { order, jobs: jobs.rows.map(jobFrom) };
    });
  }

  async snapshot(scope: Scope): Promise<ShopSnapshot> {
    if (scope.side === 'customer') await this.requireCustomer(this.db, scope.customerHash);
    const filter = scope.side === 'customer' ? ' WHERE o.owner_session_hash=$1' : '';
    const parameters = scope.side === 'customer' ? [scope.customerHash] : [];
    const rows = (await this.db.query<JobRow>(`${JOB_SELECT}${filter} ORDER BY j.id`, parameters)).rows;
    const jobs = rows.map(jobFrom);
    const orders = await this.db.query<{ snapshot: PlacedOrder }>(`SELECT snapshot FROM print_shop.orders${scope.side === 'customer' ? ' WHERE owner_session_hash=$1' : ''} ORDER BY id`, parameters);
    const stock = scope.side === 'staff' ? (await this.db.query<{ key: string; kind: 'sheet' | 'roll'; on_hand: number; reorder_at: number }>('SELECT key,kind,on_hand,reorder_at FROM public.materials ORDER BY id')).rows.map((row) => ({ key: row.key, kind: row.kind, onHand: row.on_hand, reorderAt: row.reorder_at })) : [];
    const artwork = await this.db.query<{ job_ref: string; filename: string; width_px: number; height_px: number; width_mm: string; height_mm: string; bleed_mm: string; nearest_ink_mm: string; colour_space: 'CMYK' | 'RGB'; fonts_embedded: boolean; pages: number; source: string | null }>(`SELECT j.ref AS job_ref,a.filename,a.width_px,a.height_px,a.width_mm,a.height_mm,a.bleed_mm,a.nearest_ink_mm,a.colour_space,a.fonts_embedded,a.pages,a.source FROM public.artwork a JOIN public.jobs j ON j.id=a.job_id LEFT JOIN print_shop.orders o ON o.id=j.order_id${filter} ORDER BY a.id`, parameters);
    return {
      now: this.now(), works: structuredClone(this.works), orders: orders.rows.map((row) => row.snapshot),
      jobs: jobs.filter((job) => job.stage !== 'collected' && job.stage !== 'dispatched'),
      pastJobs: jobs.filter((job) => job.stage === 'collected' || job.stage === 'dispatched'), stock,
      artwork: artwork.rows.map((row) => ({ jobRef: row.job_ref, filename: row.filename, widthPx: row.width_px, heightPx: row.height_px, widthMm: Number(row.width_mm), heightMm: Number(row.height_mm), bleedMm: Number(row.bleed_mm), nearestInkMm: Number(row.nearest_ink_mm), colourSpace: row.colour_space, fontsEmbedded: row.fonts_embedded, pages: row.pages, ...(row.source === null ? {} : { source: row.source }) })),
    };
  }

  async uploadJobFile(scope: Scope, ref: string, revision: number, input: JobFileInput): Promise<Job> {
    if (!Number.isSafeInteger(revision) || revision < 0) fail('INVALID_REQUEST', 400, 'A job revision is required.');
    if (input?.kind === 'artwork' ? scope.side !== 'customer' : input?.kind === 'proof' ? scope.side !== 'staff' : false) fail('FORBIDDEN', 403, 'This session cannot upload this file kind.');
    let file: ReturnType<typeof validateJobFile>;
    try { file = validateJobFile(input); }
    catch (error) {
      if (error instanceof FileValidationError) throw new RepoError(error.code, error.status, error.message);
      throw error;
    }
    return this.db.transaction(async (db) => {
      if (scope.side === 'customer') await this.requireCustomer(db, scope.customerHash);
      const row = (await db.query<JobRow>(`${JOB_SELECT} WHERE j.ref=$1 FOR UPDATE OF j`, [ref])).rows[0];
      if (!row) return fail('NOT_FOUND', 404, 'Job not found.');
      if (scope.side === 'customer' && row.owner_session_hash !== scope.customerHash) fail('FORBIDDEN', 403, 'This job belongs to another session.');
      if (revision !== row.revision) fail('CONFLICT', 409, 'This job has changed. Reload before trying again.');
      if (!['ordered', 'prepress', 'proofed', 'approved'].includes(row.stage)) fail('CONFLICT', 409, 'Files can only be uploaded during prepress.');
      if (row.files.length >= MAX_JOB_FILES) fail('FILE_LIMIT', 409, 'This job already has 20 file versions.');
      if (file.kind === 'artwork' && row.files.length >= MAX_JOB_FILES - 1) fail('FILE_LIMIT', 409, 'Keep the final file version available for the required proof.');
      const artwork = row.files.filter((entry) => entry.kind === 'artwork').at(-1);
      if (file.kind === 'proof' && !artwork) fail('ARTWORK_REQUIRED', 409, 'Upload the artwork before sending a proof.');
      const id = randomUUID();
      const uploadedAt = this.clock().toISOString();
      await db.query(`INSERT INTO print_shop.job_files(id,job_id,kind,filename,media_type,size,bytes,uploaded_at,artwork_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, row.id, file.kind, file.filename, file.mediaType, file.bytes.byteLength, file.bytes, uploadedAt, file.kind === 'proof' ? artwork!.id : null]);
      if (file.kind === 'proof') {
        await db.query("INSERT INTO public.proofs(job_id,kind,note,at,file_id) VALUES($1,'sent',$2,$3,$4)", [row.id, file.note || null, this.now().iso, id]);
      } else if (row.proofs.length) {
        // Keep the earlier evidence; the new source file requires a fresh proof.
        await db.query("INSERT INTO public.proofs(job_id,kind,note,at,file_id) VALUES($1,'change-asked',NULL,$2,$3)", [row.id, this.now().iso, row.proofs.at(-1)!.fileId]);
      }
      await db.query('UPDATE public.jobs SET stage=$2,revision=revision+1,updated_at=$3 WHERE id=$1', [row.id, file.kind === 'proof' ? 'proofed' : 'prepress', uploadedAt]);
      return jobFrom((await db.query<JobRow>(`${JOB_SELECT} WHERE j.id=$1`, [row.id])).rows[0]!);
    });
  }

  async readJobFile(scope: Scope, ref: string, fileId: string): Promise<{ file: JobFile; bytes: Uint8Array }> {
    if (scope.side === 'customer') await this.requireCustomer(this.db, scope.customerHash);
    const row = (await this.db.query<JobRow>(`${JOB_SELECT} WHERE j.ref=$1`, [ref])).rows[0];
    if (!row) return fail('NOT_FOUND', 404, 'Job not found.');
    if (scope.side === 'customer' && row.owner_session_hash !== scope.customerHash) fail('FORBIDDEN', 403, 'This job belongs to another session.');
    const file = row.files.find((entry) => entry.id === fileId);
    if (!file) return fail('NOT_FOUND', 404, 'File not found.');
    const saved = (await this.db.query<{ bytes: Uint8Array }>('SELECT bytes FROM print_shop.job_files WHERE id=$1 AND job_id=$2', [fileId, row.id])).rows[0];
    if (!saved) return fail('NOT_FOUND', 404, 'File not found.');
    return { file: fileMetadata(file), bytes: new Uint8Array(saved.bytes) };
  }

  async changeJob(scope: Scope, ref: string, revision: number, command: JobCommand): Promise<Job> {
    if (!Number.isSafeInteger(revision) || revision < 0) fail('INVALID_REQUEST', 400, 'A job revision is required.');
    const raw = object(command, ['kind', 'column', 'note', 'sheets']);
    const customerCommand = raw.kind === 'approve-proof' || raw.kind === 'ask-change';
    if ((scope.side === 'customer') !== customerCommand) fail('FORBIDDEN', 403, 'This action is not permitted for this session.');
    return this.db.transaction(async (db) => {
      if (scope.side === 'customer') await this.requireCustomer(db, scope.customerHash);
      const result = await db.query<JobRow>(`${JOB_SELECT} WHERE j.ref=$1 FOR UPDATE OF j`, [ref]);
      const row = result.rows[0];
      if (!row) return fail('NOT_FOUND', 404, 'Job not found.');
      if (scope.side === 'customer' && row.owner_session_hash !== scope.customerHash) fail('FORBIDDEN', 403, 'This job belongs to another session.');
      if (revision !== row.revision) fail('CONFLICT', 409, 'This job has changed. Reload before trying again.');
      const latest = row.proofs.at(-1);
      const prepress = ['ordered', 'prepress', 'proofed', 'approved'].includes(row.stage);
      let stage = row.stage;
      let spoiled = row.spoiled_sheets;
      let promisedFor = row.promised_date;
      const today = this.now().iso;
      switch (raw.kind) {
        case 'send-proof':
          object(command, ['kind', 'note']);
          return fail('PROOF_FILE_REQUIRED', 409, 'Upload the proof file to send a proof.');
        case 'approve-proof':
          object(command, ['kind']);
          if (!prepress || latest?.kind !== 'sent') fail('PROOF_REQUIRED', 409, 'The latest proof must be sent before approval.');
          if (!currentProof(row)) fail('PROOF_FILE_REQUIRED', 409, 'Approval requires a proof of the current artwork.');
          await db.query("INSERT INTO public.proofs(job_id,kind,at,file_id) VALUES($1,'approved',$2,$3)", [row.id, today, latest!.fileId]);
          stage = 'approved';
          break;
        case 'ask-change':
          object(command, ['kind', 'note']);
          if (!prepress || (latest?.kind !== 'sent' && latest?.kind !== 'approved')) fail('PROOF_REQUIRED', 409, 'No current proof is available.');
          if (!currentProof(row)) fail('PROOF_FILE_REQUIRED', 409, 'A change request requires a proof of the current artwork.');
          await db.query("INSERT INTO public.proofs(job_id,kind,note,at,file_id) VALUES($1,'change-asked',$2,$3,$4)", [row.id, text(raw.note, 4000), today, latest!.fileId]);
          stage = 'prepress';
          promisedFor = addWorkingDays(promisedFor, 1);
          break;
        case 'move': {
          object(command, ['kind', 'column']);
          if (!['prepress', 'printing', 'finishing', 'ready'].includes(raw.column as string)) fail('INVALID_REQUEST', 400, 'Unknown board column.');
          if (['quoted', 'collected', 'dispatched'].includes(row.stage)) fail('CONFLICT', 409, 'This job is not open for production.');
          if (raw.column !== 'prepress' && !row.files.some((file) => file.kind === 'artwork')) fail('ARTWORK_REQUIRED', 409, 'Upload the artwork before production.');
          if (raw.column !== 'prepress' && latest?.kind !== 'approved') fail('PROOF_REQUIRED', 409, 'Approve the latest proof before production.');
          if (raw.column !== 'prepress' && !currentProof(row)) fail('PROOF_FILE_REQUIRED', 409, 'Production requires an approved proof of the current artwork.');
          stage = raw.column === 'prepress' ? (latest?.kind === 'approved' && currentProof(row) ? 'approved' : 'prepress') : raw.column as Job['stage'];
          break;
        }
        case 'spoilage': {
          object(command, ['kind', 'sheets']);
          if (['quoted', 'collected', 'dispatched'].includes(row.stage)) fail('CONFLICT', 409, 'Spoilage can only be added to an open job.');
          const sheets = positiveInteger(raw.sheets);
          spoiled += sheets;
          if (!Number.isSafeInteger(spoiled) || spoiled > 2_147_483_647) fail('INVALID_REQUEST', 400, 'Spoilage exceeds the supported limit.');
          await db.query("INSERT INTO public.stock_movements(material_id,job_id,kind,sheets,at) VALUES((SELECT material_id FROM public.jobs WHERE id=$1),$1,'spoilage',$2,$3)", [row.id, sheets, this.clock().toISOString()]);
          break;
        }
        case 'collect':
          object(command, ['kind']);
          if (row.stage !== 'ready') fail('CONFLICT', 409, 'Only ready jobs can be collected.');
          await db.query("INSERT INTO public.dispatches(job_id,kind,at) VALUES($1,'collected',$2)", [row.id, this.clock().toISOString()]);
          stage = 'collected';
          break;
        default: fail('INVALID_REQUEST', 400, 'Unknown job action.');
      }
      await db.query('UPDATE public.jobs SET stage=$2,spoiled_sheets=$3,revision=revision+1,updated_at=$4,promised_for=$5 WHERE id=$1', [row.id, stage, spoiled, this.clock().toISOString(), promisedFor]);
      return jobFrom((await db.query<JobRow>(`${JOB_SELECT} WHERE j.id=$1`, [row.id])).rows[0]!);
    });
  }

  async createStaff(email: string, passwordHash: string): Promise<void> {
    const normalized = text(email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || !passwordHash) fail('INVALID_REQUEST', 400, 'Invalid staff credentials.');
    const inserted = await this.db.query('INSERT INTO print_shop.staff(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [randomUUID(), normalized, passwordHash]);
    if (!inserted.rows.length) fail('CONFLICT', 409, 'This staff account already exists.');
  }

  async findStaff(email: string): Promise<{ id: string; passwordHash: string } | null> {
    const row = (await this.db.query<{ id: string; password_hash: string }>('SELECT id,password_hash FROM print_shop.staff WHERE lower(email)=lower($1)', [email.trim()])).rows[0];
    return row ? { id: row.id, passwordHash: row.password_hash } : null;
  }

  async createStaffSession(tokenHash: string, staffId: string, expiresAt: number): Promise<void> {
    this.checkSessionArguments(tokenHash, expiresAt);
    await this.db.query('INSERT INTO print_shop.staff_sessions(token_hash,staff_id,expires_at) VALUES($1,$2,$3)', [tokenHash, staffId, expiresAt]);
  }

  async validStaffSession(tokenHash: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM print_shop.staff_sessions WHERE token_hash=$1 AND expires_at>$2', [tokenHash, this.clock().getTime()])).rows.length > 0;
  }

  async deleteStaffSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM print_shop.staff_sessions WHERE token_hash=$1', [tokenHash]);
  }
}
