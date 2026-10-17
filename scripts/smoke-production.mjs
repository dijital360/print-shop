/**
 * Destructive integration fixture: creates a real order and private files.
 * Run ONLY against an empty, disposable deployment, never public production.
 * node scripts/smoke-production.mjs <base-url> --allow-test-orders
 * Supply PRINT_SHOP_SMOKE_STAFF_EMAIL and PRINT_SHOP_SMOKE_STAFF_PASSWORD
 * securely through the environment. No credentials or cookies are printed.
 * PRINT_SHOP_SMOKE_ORIGIN may name the configured HTTPS origin when testing
 * a local HTTP reverse proxy. Database restart validation is a separate check.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

class SmokeFailure extends Error {}
const fail = (check) => { throw new SmokeFailure(check); };
let checks = 0;
const passed = (check) => console.info(`ok ${++checks} ${check}`);
const requireCheck = (condition, check) => { if (!condition) fail(check); };
const empty = (snapshot) => Array.isArray(snapshot.orders) && snapshot.orders.length === 0
  && Array.isArray(snapshot.jobs) && snapshot.jobs.length === 0
  && Array.isArray(snapshot.pastJobs) && snapshot.pastJobs.length === 0;
const combined = (...jars) => new Map(jars.flatMap((jar) => [...jar]));

function saveCookies(response, jar) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';', 1)[0];
    const delimiter = pair.indexOf('=');
    if (delimiter < 1) continue;
    const name = pair.slice(0, delimiter);
    const token = pair.slice(delimiter + 1);
    if (token) jar.set(name, token);
    else jar.delete(name);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.filter((argument) => argument !== '--allow-test-orders');
  if (args.length !== 2 || !args.includes('--allow-test-orders') || targets.length !== 1) {
    fail('usage: node scripts/smoke-production.mjs <base-url> --allow-test-orders (empty disposable deployment only)');
  }
  let base;
  let origin;
  try {
    base = new URL(targets[0]);
    origin = process.env.PRINT_SHOP_SMOKE_ORIGIN ?? base.origin;
    const parsedOrigin = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.search || base.hash || base.pathname !== '/'
      || !['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
      fail('invalid-base-url-or-origin');
    }
  } catch { fail('invalid-base-url-or-origin'); }
  const email = process.env.PRINT_SHOP_SMOKE_STAFF_EMAIL;
  const password = process.env.PRINT_SHOP_SMOKE_STAFF_PASSWORD;
  requireCheck(typeof email === 'string' && email.length > 0 && typeof password === 'string' && password.length > 0,
    'missing-smoke-staff-environment');
  const customer = new Map();
  const staff = new Map();
  let authenticated = false;

  async function request(check, path, { jar = customer, method = 'GET', json, body, headers = {}, status = 200 } = {}) {
    const requestHeaders = { Origin: origin, 'Accept-Encoding': 'identity', ...headers };
    if (jar.size) requestHeaders.Cookie = [...jar].map(([name, token]) => `${name}=${token}`).join('; ');
    if (json !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let response;
    try {
      response = await fetch(new URL(`/api/shop${path}`, base), {
        method, headers: requestHeaders, body, redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
    } catch { fail(`${check}:request-failed`); }
    if (response.status !== status) {
      await response.body?.cancel();
      fail(`${check}:HTTP-${response.status}`);
    }
    saveCookies(response, jar);
    return response;
  }
  async function json(check, path, options) {
    const response = await request(check, path, options);
    try { return await response.json(); }
    catch { fail(`${check}:invalid-JSON`); }
  }
  const fixture = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const upload = (check, ref, revision, kind, jar) => json(check,
    `/jobs/${encodeURIComponent(ref)}/files?kind=${kind}`, {
      method: 'POST', jar, body: fixture, headers: {
        'Content-Type': 'application/pdf',
        'X-Print-Shop-Filename': encodeURIComponent(`smoke-${kind}.pdf`),
        'X-Print-Shop-Revision': String(revision),
        ...(kind === 'proof' ? { 'X-Print-Shop-Note': encodeURIComponent('Disposable smoke proof.') } : {}),
      },
    });
  const action = (check, ref, revision, command, jar) => json(check, `/jobs/${encodeURIComponent(ref)}`, {
    method: 'POST', jar, json: { revision, command },
  });
  async function verifyFile(check, ref, file, side, jar) {
    const response = await request(check,
      `/jobs/${encodeURIComponent(ref)}/files/${encodeURIComponent(file.id)}?side=${side}`, { jar });
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); }
    catch { fail(`${check}:read-failed`); }
    requireCheck(bytes.length === fixture.length && timingSafeEqual(bytes, fixture), `${check}:bytes-mismatch`);
    requireCheck(response.headers.get('content-type') === 'application/pdf'
      && response.headers.get('cache-control') === 'no-store'
      && response.headers.get('x-content-type-options') === 'nosniff'
      && response.headers.get('content-security-policy') === "sandbox; default-src 'none'"
      && response.headers.get('content-disposition')?.startsWith(file.kind === 'artwork' ? 'attachment;' : 'inline;'),
    `${check}:unsafe-response-headers`);
  }

  try {
    const initial = await json('customer-bootstrap', '/bootstrap?side=customer');
    requireCheck(empty(initial) && customer.has('print_shop_customer'), 'customer-empty-bootstrap');
    passed('customer-empty-bootstrap');
    await json('staff-login', '/staff/session', { method: 'POST', jar: staff, json: { email, password } });
    authenticated = true;
    const preflight = await json('staff-empty-database-preflight', '/bootstrap?side=staff', { jar: staff });
    requireCheck(empty(preflight), 'staff-empty-database-preflight:requires-empty-disposable-database');
    passed('staff-empty-database-preflight');

    const receipt = await json('create-order', '/orders', { method: 'POST', status: 201, json: {
      requestKey: `smoke-${randomUUID()}`,
      customer: { name: 'Disposable Smoke Customer', email: 'disposable-smoke@example.test' },
      lines: [{ id: 'smoke-cards', config: {
        product: 'business-cards', material: 'silk-350', size: 'business-card', sides: 2,
        finish: 'none', quantity: 100, packaging: 'bundled', printedProof: false,
        express: false, delivery: 'collection',
      } }],
      deliveryChoice: null,
    } });
    requireCheck(/^[A-Za-z0-9-]{1,64}$/.test(receipt.order?.ref ?? '') && receipt.jobs?.length === 1,
      'create-order:invalid-receipt');
    let job = receipt.jobs[0];
    requireCheck(/^[A-Za-z0-9-]{1,64}$/.test(job.ref ?? '') && Number.isSafeInteger(job.revision),
      'create-order:invalid-job');
    passed('order-created');
    job = await upload('upload-artwork', job.ref, job.revision, 'artwork', combined(customer, staff));
    const artwork = job.files?.findLast((file) => file.kind === 'artwork');
    requireCheck(artwork?.id && job.stage === 'prepress', 'upload-artwork:missing-file');
    passed('artwork-uploaded');
    job = await upload('upload-proof', job.ref, job.revision, 'proof', staff);
    const proof = job.files?.findLast((file) => file.kind === 'proof');
    requireCheck(proof?.id && job.stage === 'proofed' && job.proofs?.at(-1)?.fileId === proof.id,
      'upload-proof:missing-proof-version');
    passed('proof-uploaded');
    job = await action('customer-approval', job.ref, job.revision, { kind: 'approve-proof' }, combined(customer, staff));
    requireCheck(job.stage === 'approved' && job.proofs?.at(-1)?.kind === 'approved'
      && job.proofs?.at(-1)?.fileId === proof.id, 'customer-approval:wrong-proof-version');
    passed('customer-proof-approved');
    job = await action('staff-printing', job.ref, job.revision, { kind: 'move', column: 'printing' }, staff);
    requireCheck(job.stage === 'printing', 'staff-printing:wrong-stage');
    passed('staff-printing');

    for (const [side, jar] of [['customer', customer], ['staff', staff]]) {
      const snapshot = await json(`${side}-saved-snapshot`, `/bootstrap?side=${side}`, { jar });
      const saved = snapshot.jobs?.find((entry) => entry.ref === job.ref);
      requireCheck(snapshot.orders?.length === 1 && snapshot.orders[0].ref === receipt.order.ref
        && saved?.stage === 'printing' && saved.revision === job.revision
        && saved.files?.some((file) => file.id === artwork.id)
        && saved.files?.some((file) => file.id === proof.id), `${side}-saved-snapshot:mismatch`);
      await verifyFile(`${side}-artwork-download`, job.ref, artwork, side, jar);
      await verifyFile(`${side}-proof-download`, job.ref, proof, side, jar);
      passed(`${side}-saved-snapshot-and-downloads`);
    }

    const other = new Map();
    requireCheck(empty(await json('other-customer-bootstrap', '/bootstrap?side=customer', { jar: other })),
      'other-customer-bootstrap:not-isolated');
    const forbidden = await json('other-customer-proof-download',
      `/jobs/${encodeURIComponent(job.ref)}/files/${encodeURIComponent(proof.id)}?side=customer`, {
        jar: combined(other, staff), status: 403,
      });
    requireCheck(forbidden.error?.code === 'FORBIDDEN', 'other-customer-proof-download:wrong-error');
    await json('other-customer-approval', `/jobs/${encodeURIComponent(job.ref)}`, {
      jar: combined(other, staff), method: 'POST', status: 403,
      json: { revision: job.revision, command: { kind: 'approve-proof' } },
    });
    await json('anonymous-staff-bootstrap', '/bootstrap?side=staff', { jar: other, status: 401 });
    passed('other-customer-cannot-read-or-mutate');
    await json('staff-logout', '/staff/session', { method: 'DELETE', jar: staff, json: {} });
    authenticated = false;
    await json('staff-session-revoked', '/bootstrap?side=staff', { jar: staff, status: 401 });
    passed('staff-session-revoked');
    console.info(`PASS ${checks} checks; order ${receipt.order.ref}.`);
  } finally {
    if (authenticated) {
      await request('staff-cleanup', '/staff/session', { method: 'DELETE', jar: staff, json: {} }).catch(() => {});
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof SmokeFailure ? error.message : 'smoke-check-failed');
  process.exitCode = 1;
});
