import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import type { Server } from 'node:http';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.ts';
import { ShopRepository } from './repository.ts';
import { createLocalShopServer } from './local.ts';
import { ensureWindowsOwner, readWindowsCredentials, showWindowsCredentials } from './windowsCredentials.ts';
import type { WindowsOwnerDetails, WindowsOwnerOptions } from './windowsCredentials.ts';
import { createWindowsBackup } from './windowsBackup.ts';
import { installWindowsDesktopShortcut, showWindowsNotice } from './windowsShell.ts';

export class WindowsLocalError extends Error {
  constructor(message: string) { super(message); this.name = 'WindowsLocalError'; }
}

interface InstanceRecord { application: 'dijital360-print-shop'; pid: number; port: number; instanceId: string }
export interface PortableShopOptions {
  appDir: string;
  dataRoot: string;
  ownerEmail: string;
  preferredPort?: number;
  provisionOwner?: (repository: ShopRepository, options: WindowsOwnerOptions) => Promise<WindowsOwnerDetails>;
}
export interface PortableShop {
  url: string;
  reused: boolean;
  owner?: WindowsOwnerDetails;
  close(): Promise<void>;
}

function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new WindowsLocalError('Paketin personel hesap ayari gecersiz.');
  }
  return value.trim().toLowerCase();
}

async function readJson(filename: string, limit = 65_536): Promise<unknown | undefined> {
  let info;
  try { info = await lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new WindowsLocalError('Yerel uygulama dosyasi gecersiz.');
  return JSON.parse(await readFile(filename, 'utf8'));
}

function instanceRecord(value: unknown): InstanceRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return row.application === 'dijital360-print-shop' && Number.isSafeInteger(row.pid) && (row.pid as number) > 0
    && Number.isInteger(row.port) && (row.port as number) > 0 && (row.port as number) <= 65535
    && typeof row.instanceId === 'string' && /^[0-9a-f-]{36}$/i.test(row.instanceId)
    ? row as unknown as InstanceRecord : undefined;
}

/** Only this machine's loopback interface; proxy settings are never changed. */
function checkInstance(record: InstanceRecord): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => { if (!settled) { settled = true; if (deadline) clearTimeout(deadline); resolve(value); } };
    const request = get({ host: '127.0.0.1', port: record.port, path: '/__print-shop-instance', timeout: 1000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { body += part; if (body.length > 4096) { finish(false); response.destroy(); } });
      response.on('error', () => finish(false));
      response.on('close', () => finish(false));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(response.statusCode === 200 && value.application === record.application && value.instanceId === record.instanceId);
        } catch { finish(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => finish(false));
    deadline = setTimeout(() => { finish(false); request.destroy(); }, 1500);
  });
}

async function runningInstance(filename: string): Promise<InstanceRecord | undefined> {
  const value = await readJson(filename, 4096);
  if (value === undefined) return undefined;
  const record = instanceRecord(value);
  if (!record) throw new WindowsLocalError('Yerel uygulama durum dosyasi gecersiz. Veriler korunuyor.');
  try { process.kill(record.pid, 0); }
  catch { return undefined; }
  return await checkInstance(record) ? record : undefined;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, '127.0.0.1');
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = setTimeout(() => server.closeAllConnections(), 5000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); resolve(); });
    server.closeIdleConnections();
  });
}

/** The portable app always keeps its own local database, independent of cloud variables. */
export async function startPortableShop(options: PortableShopOptions): Promise<PortableShop> {
  const ownerEmail = email(options.ownerEmail);
  const dataRoot = path.resolve(options.dataRoot);
  const preferredPort = options.preferredPort ?? 5173;
  if (!path.isAbsolute(options.dataRoot) || !Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
    throw new WindowsLocalError('Yerel uygulama konumu veya port ayari gecersiz.');
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(dataRoot)).isSymbolicLink()) throw new WindowsLocalError('Veri klasoru bir baglanti olamaz.');
  const stateFile = path.join(dataRoot, 'local-instance.json');
  const existing = await runningInstance(stateFile);
  if (existing) return { url: `http://127.0.0.1:${existing.port}`, reused: true, close: async () => {} };

  let database;
  try { database = await openDatabase({ dataDir: path.join(dataRoot, 'database'), connectionString: '' }); }
  catch {
    // A second double-click can arrive while the first process is opening PGlite.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const winner = await runningInstance(stateFile);
      if (winner) return { url: `http://127.0.0.1:${winner.port}`, reused: true, close: async () => {} };
    }
    throw new WindowsLocalError('Yerel veritabani acilamadi. Acik Print Shop penceresini kontrol edin; veriler korunuyor.');
  }
  let server: Server | undefined;
  let record: InstanceRecord | undefined;
  try {
    const repository = new ShopRepository(database);
    await repository.initialize();
    const owner = await (options.provisionOwner ?? ensureWindowsOwner)(repository,
      { email: ownerEmail, credentialsFile: path.join(dataRoot, 'owner-protected.json') });
    const instanceId = randomUUID();
    server = createLocalShopServer(repository, { distDir: path.join(options.appDir, 'dist'), instanceId });
    try { await listen(server, preferredPort); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferredPort === 0) throw error;
      await listen(server, 0);
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new WindowsLocalError('Yerel site baslatilamadi.');
    record = { application: 'dijital360-print-shop', pid: process.pid, port: address.port, instanceId };
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temp, stateFile); }
    finally { await unlink(temp).catch(() => {}); }
    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${address.port}`, reused: false, owner,
      close() {
        closing ??= (async () => {
          await closeServer(server!);
          try { await database.close(); }
          finally {
            const current = instanceRecord(await readJson(stateFile, 4096));
            if (current?.instanceId === record?.instanceId && current?.pid === process.pid) await unlink(stateFile);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (server) await closeServer(server);
    await database.close();
    throw error;
  }
}

export async function verifyPortablePackage(packageRoot: string): Promise<void> {
  const manifest = await readJson(path.join(packageRoot, 'package-manifest.json'), 1_048_576) as { nodeVersion?: unknown; criticalHashes?: unknown } | undefined;
  if (!manifest || manifest.nodeVersion !== process.version || !manifest.criticalHashes
    || typeof manifest.criticalHashes !== 'object' || Array.isArray(manifest.criticalHashes)) {
    throw new WindowsLocalError('Paket dogrulanamadi. ZIP dosyasinin tamamini ayiklayin.');
  }
  const hashes = Object.entries(manifest.criticalHashes);
  if (hashes.length < 5 || hashes.length > 20_000) throw new WindowsLocalError('Paket dosya listesi gecersiz.');
  for (const [relative, expected] of hashes) {
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected) || relative.includes('\\') || relative.includes(':')) throw new WindowsLocalError('Paket dosya listesi gecersiz.');
    const filename = path.resolve(packageRoot, relative);
    const inside = path.relative(packageRoot, filename);
    if (!inside || inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) throw new WindowsLocalError('Paket dosya listesi gecersiz.');
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(await readFile(filename)).digest('hex') !== expected.toLowerCase()) {
      throw new WindowsLocalError('Paket dosyalari eksik veya degismis. Tam ZIP dosyasini yeniden ayiklayin.');
    }
  }
}

function openBrowser(url: string): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/staff\/catalogue$/.test(url)) throw new WindowsLocalError('Yerel adres gecersiz.');
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new WindowsLocalError('Windows sistem konumu bulunamadi.');
  return new Promise((resolve, reject) => {
    const child = spawn(path.win32.join(systemRoot, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url],
      { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function runWindowsLauncher(args = process.argv.slice(2)): Promise<void> {
  if (process.platform !== 'win32') throw new WindowsLocalError('Bu hazir paket Windows 10 veya 11 icindir.');
  if (args.some((arg) => !['--show-login', '--backup', '--install-shortcut'].includes(arg)) || args.length > 1) {
    throw new WindowsLocalError('Baslat.cmd, Giris-Bilgileri.cmd, Masaustune-Ekle.cmd veya Yedek-Al.cmd dosyasini kullanin.');
  }
  const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const packageRoot = path.dirname(appDir);
  await verifyPortablePackage(packageRoot);
  if (args[0] === '--install-shortcut') {
    await installWindowsDesktopShortcut(packageRoot);
    console.info('Dijital360 Print Shop masaustu kisayolu hazir.');
    await showWindowsNotice('Masaüstüne Dijital360 Print Shop kısayolu eklendi.\n\nBu paket klasörünü taşımayın. Taşırsanız Masaustune-Ekle.cmd dosyasını yeni konumdan tekrar açın.')
      .catch(() => {});
    return;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) throw new WindowsLocalError('Windows kullanici veri klasoru bulunamadi.');
  const dataRoot = path.join(localAppData, 'Dijital360', 'PrintShop');
  if (args[0] === '--backup') {
    const userProfile = process.env.USERPROFILE;
    if (!userProfile || !path.win32.isAbsolute(userProfile) || userProfile.startsWith('\\\\')) {
      throw new WindowsLocalError('Windows kullanici klasoru bulunamadi. Yedek olusturulmadi.');
    }
    const backup = await createWindowsBackup({ dataRoot, backupRoot: path.join(userProfile, 'Dijital360-Yedekler'), packageRoot });
    console.info(`Yedek hazir: ${backup.directory}`);
    await showWindowsNotice(`Yedek tamamlandı.\n\n${backup.directory}\n\nSipariş ve dosya verileriniz yedeklendi. Uygulamayı yeniden başlatabilirsiniz.`)
      .catch(() => {});
    return;
  }
  const config = await readJson(path.join(appDir, 'windows-owner.json')) as { ownerEmail?: unknown } | undefined;
  const ownerEmail = email(config?.ownerEmail);
  const ownerOptions = { email: ownerEmail, credentialsFile: path.join(dataRoot, 'owner-protected.json') };
  if (args[0] === '--show-login') {
    if (!await readJson(ownerOptions.credentialsFile)) throw new WindowsLocalError('Once Baslat.cmd dosyasini calistirin.');
    await showWindowsCredentials(await readWindowsCredentials(ownerOptions));
    return;
  }
  const shop = await startPortableShop({ appDir, dataRoot, ownerEmail });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shop.close().catch(() => { process.exitCode = 1; });
  };
  if (!shop.reused) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  console.info(shop.reused ? 'Print Shop zaten acik; tarayici aciliyor.'
    : 'Dijital360 Print Shop hazir. Bu pencereyi acik birakin; kapatmak icin Ctrl+C.');
  const url = `${shop.url}/staff/catalogue`;
  try { await openBrowser(url); }
  catch { console.info(`Tarayicida acin: ${url}`); }
  if (shop.owner?.created) {
    try { await showWindowsCredentials(shop.owner); }
    catch { console.error('Giris bilgileri penceresi acilamadi. Giris-Bilgileri.cmd dosyasini kullanin.'); }
  }
}
