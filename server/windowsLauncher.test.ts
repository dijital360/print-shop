import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword } from './http.ts';
import { startPortableShop, verifyPortablePackage } from './windowsLauncher.ts';
import type { PortableShop, PortableShopOptions } from './windowsLauncher.ts';
import { BANNER_PRODUCT_DRAFT } from '../src/lib/commerce.ts';

const directories: string[] = [];
const running: PortableShop[] = [];
const TEST_EMAIL = 'owner@example.test';
const TEST_PASSWORD = 'disposable-fixture-password';
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'print-shop-portable-'));
  directories.push(directory);
  const appDir = path.join(directory, 'app');
  await mkdir(path.join(appDir, 'dist'), { recursive: true });
  await writeFile(path.join(appDir, 'dist', 'index.html'), '<!doctype html><html><body>Local shop</body></html>');
  let provisions = 0;
  const options: PortableShopOptions = {
    appDir, dataRoot: path.join(directory, 'data'), ownerEmail: TEST_EMAIL, preferredPort: 0,
    async provisionOwner(repository) {
      provisions++;
      const previous = await repository.findStaff(TEST_EMAIL);
      if (!previous) await repository.createStaff(TEST_EMAIL, await hashPassword(TEST_PASSWORD));
      return { email: TEST_EMAIL, password: TEST_PASSWORD, created: !previous };
    },
  };
  async function start(override: Partial<PortableShopOptions> = {}) {
    const shop = await startPortableShop({ ...options, ...override });
    running.push(shop);
    return shop;
  }
  return { directory, options, start, provisions: () => provisions };
}
afterEach(async () => {
  for (const shop of running.splice(0).reverse()) await shop.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('portable Windows application lifecycle', () => {
  it('reuses the matching running instance instead of opening a second database', async () => {
    const setup = await fixture();
    const first = await setup.start();
    const second = await setup.start();
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.url).toBe(first.url);
    expect(setup.provisions()).toBe(1);
    await second.close();
    expect((await fetch(`${first.url}/api/shop/health`)).status).toBe(200);
    await first.close();
    await expect(readFile(path.join(setup.options.dataRoot, 'local-instance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps staff and edited products across stopping and restarting the package', async () => {
    const setup = await fixture();
    const first = await setup.start();
    const login = await fetch(`${first.url}/api/shop/staff/session`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: first.url }, body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const created = await fetch(`${first.url}/api/shop/catalogue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: first.url, Cookie: cookie },
      body: JSON.stringify({ ...BANNER_PRODUCT_DRAFT, name: 'Persistent local item', unitPriceCents: 23_000 }) });
    expect(created.status).toBe(201);
    const saved = await created.json();
    await first.close();
    const second = await setup.start();
    expect(second.owner?.created).toBe(false);
    const boot = await fetch(`${second.url}/api/shop/bootstrap?side=customer`);
    expect(boot.status).toBe(200);
    const snapshot = await boot.json();
    expect(snapshot.catalogueProducts).toEqual(expect.arrayContaining([saved]));
    expect(snapshot.orders).toEqual([]);
    expect(snapshot.catalogueOrders).toEqual([]);
    const customerCookie = boot.headers.get('set-cookie')!.split(';')[0];
    const product = snapshot.catalogueProducts.find((item: { id: string }) => item.id === 'branda');
    const quote = await fetch(`${second.url}/api/shop/catalogue/quote`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: second.url, Cookie: customerCookie },
      body: JSON.stringify({ lines: [{ productId: product.id, productRevision: product.revision, widthMm: 1000, heightMm: 1000,
        quantity: 1, eyeletsPerItem: 0, weldEdges: false, hemEdges: false }] }) });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ subtotalCents: 50_000, taxCents: 10_000, totalCents: 60_000 });
  });

  it('chooses a free loopback port when the preferred port is already in use', async () => {
    const occupied = createServer((_request, response) => response.end('Another application'));
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const address = occupied.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const setup = await fixture();
      const shop = await setup.start({ preferredPort: address.port });
      expect(new URL(shop.url).port).not.toBe(String(address.port));
      expect((await fetch(`${shop.url}/api/shop/health`)).status).toBe(200);
      expect((await fetch(`${shop.url}/staff/catalogue`)).status).toBe(200);
    } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  });

  it('refuses tampered or outside-root package entries', async () => {
    const setup = await fixture();
    const root = path.join(setup.directory, 'package');
    await mkdir(root);
    const criticalHashes: Record<string, string> = {};
    for (let index = 0; index < 5; index++) {
      const filename = `part-${index}.txt`;
      await writeFile(path.join(root, filename), `verified ${index}`);
      criticalHashes[filename] = createHash('sha256').update(`verified ${index}`).digest('hex');
    }
    const manifest = { nodeVersion: process.version, criticalHashes };
    await writeFile(path.join(root, 'package-manifest.json'), JSON.stringify(manifest));
    await expect(verifyPortablePackage(root)).resolves.toBeUndefined();
    await writeFile(path.join(root, 'part-0.txt'), 'changed');
    await expect(verifyPortablePackage(root)).rejects.toThrow('Paket dosyalari');
    await writeFile(path.join(root, 'part-0.txt'), 'verified 0');
    criticalHashes['../outside.txt'] = '0'.repeat(64);
    await writeFile(path.join(root, 'package-manifest.json'), JSON.stringify(manifest));
    await expect(verifyPortablePackage(root)).rejects.toThrow('Paket dosya listesi');
  });
});
