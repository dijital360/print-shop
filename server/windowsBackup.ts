import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { acquireDatabaseLock } from './database.ts';

const MESSAGES = {
  INVALID_BACKUP_PATH: 'Yedekleme konumu gecersiz. Veri ve uygulama klasorunun disinda tam bir klasor yolu kullanin.',
  DATABASE_NOT_FOUND: 'Yedeklenecek yerel veritabani bulunamadi. Once Baslat.cmd ile uygulamayi calistirin.',
  DATABASE_IN_USE: 'Print Shop acik veya veritabani kilitli. Uygulama penceresinde Ctrl+C ile kapatin; sonra yedeklemeyi yeniden deneyin.',
  UNSAFE_BACKUP_SOURCE: 'Veri veya yedek klasorunde baglanti ya da desteklenmeyen dosya bulundu. Kaynak veriler korunuyor.',
  INVALID_CREDENTIALS: 'Kayitli giris bilgileri guvenli bicimde dogrulanamadi. Kaynak veriler korunuyor; yedek olusturulmadi.',
  BACKUP_VERIFICATION_FAILED: 'Yedek dosyalari dogrulanamadi. Kaynak veriler korunuyor; tamamlanmamis yedek silindi.',
  BACKUP_FAILED: 'Yedek olusturulamadi. Kaynak veriler korunuyor; hedef klasor iznini ve bos alani kontrol edin.',
} as const;
type BackupErrorCode = keyof typeof MESSAGES;

export class WindowsBackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode) { super(MESSAGES[code]); this.name = 'WindowsBackupError'; this.code = code; }
}
const fail = (code: BackupErrorCode): never => { throw new WindowsBackupError(code); };

export interface WindowsBackupOptions { dataRoot: string; backupRoot: string; packageRoot?: string }
interface PayloadFile { path: string; source: string; size: number; fingerprint: string }
interface Inventory { directories: string[]; files: PayloadFile[] }

function absolute(input: string): string {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')
    || input.split(/[\\/]/).some((part) => part === '.' || part === '..')) return fail('INVALID_BACKUP_PATH');
  return path.resolve(input);
}
function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function fingerprint(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
function portableName(name: string): boolean {
  return name !== '.' && name !== '..' && !/[\u0000-\u001f\u007f\\/:<>"|?*]/.test(name)
    && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

/** Resolve missing target suffixes without following existing junctions/links. */
async function safeDirectory(input: string, missingAllowed: boolean): Promise<string> {
  const parsed = path.parse(input);
  let current = parsed.root;
  const parts = input.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (parts.some((name) => !portableName(name))) return fail('INVALID_BACKUP_PATH');
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index]!;
    current = path.join(current, name);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return fail('UNSAFE_BACKUP_SOURCE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !missingAllowed) throw error;
      const parent = await realpath(path.dirname(current));
      return path.join(parent, ...parts.slice(index));
    }
  }
  return realpath(input);
}

async function inventory(dataRoot: string): Promise<Inventory> {
  const result: Inventory = { directories: [], files: [] };
  const inspect = async (relative: string): Promise<void> => {
    const source = path.join(dataRoot, ...relative.split('/'));
    const info = await lstat(source, { bigint: true });
    if (info.isSymbolicLink()) return fail('UNSAFE_BACKUP_SOURCE');
    if (info.isDirectory()) {
      result.directories.push(relative);
      for (const name of (await readdir(source)).sort()) {
        if (!portableName(name)) return fail('UNSAFE_BACKUP_SOURCE');
        await inspect(`${relative}/${name}`);
      }
    } else if (info.isFile() && info.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
      result.files.push({ path: relative, source, size: Number(info.size), fingerprint: fingerprint(info) });
    } else return fail('UNSAFE_BACKUP_SOURCE');
  };
  await inspect('database');
  try {
    const owner = await lstat(path.join(dataRoot, 'owner-protected.json'));
    if (!owner.isFile() || owner.isSymbolicLink()) return fail('UNSAFE_BACKUP_SOURCE');
    await inspect('owner-protected.json');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return result;
}

async function validateCredentials(file: PayloadFile | undefined): Promise<void> {
  if (!file) return;
  if (file.size > 65_536) return fail('INVALID_CREDENTIALS');
  try {
    const value: unknown = JSON.parse(await readFile(file.source, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_CREDENTIALS');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['version', 'protection', 'ciphertext'].includes(key))
      || row.version !== 1 || row.protection !== 'windows-dpapi-current-user'
      || typeof row.ciphertext !== 'string' || !row.ciphertext || row.ciphertext.length > 65_536
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.ciphertext)) return fail('INVALID_CREDENTIALS');
  } catch { return fail('INVALID_CREDENTIALS'); }
}

async function sha256(filename: string): Promise<string> {
  const handle = await open(filename, 'r');
  try {
    if (!(await handle.stat()).isFile()) return fail('UNSAFE_BACKUP_SOURCE');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** A verified cold copy, never a live-database export or credential decryption. */
export async function createWindowsBackup(options: WindowsBackupOptions): Promise<{ directory: string; files: number }> {
  let release: (() => Promise<void>) | undefined;
  let staging: string | undefined;
  try {
    const requestedData = absolute(options.dataRoot);
    const requestedBackup = absolute(options.backupRoot);
    const requestedPackage = options.packageRoot === undefined ? undefined : absolute(options.packageRoot);
    let dataRoot: string;
    try {
      dataRoot = await safeDirectory(requestedData, false);
      const database = await lstat(path.join(dataRoot, 'database'));
      if (database.isSymbolicLink()) return fail('UNSAFE_BACKUP_SOURCE');
      if (!database.isDirectory()) return fail('DATABASE_NOT_FOUND');
    } catch (error) {
      if (error instanceof WindowsBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('DATABASE_NOT_FOUND');
      throw error;
    }
    const backupRoot = await safeDirectory(requestedBackup, true);
    const packageRoot = requestedPackage === undefined ? undefined : await realpath(requestedPackage);
    if (within(dataRoot, backupRoot) || (packageRoot !== undefined && within(packageRoot, backupRoot))) return fail('INVALID_BACKUP_PATH');
    try { release = await acquireDatabaseLock(path.join(dataRoot, 'database'), { recoverStale: false }); }
    catch { return fail('DATABASE_IN_USE'); }
    const before = await inventory(dataRoot);
    if (!before.files.some((file) => file.path === 'database/PG_VERSION' && file.size > 0)) return fail('DATABASE_NOT_FOUND');
    await validateCredentials(before.files.find((file) => file.path === 'owner-protected.json'));
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    if (await safeDirectory(backupRoot, false) !== backupRoot) return fail('INVALID_BACKUP_PATH');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const name = `Dijital360-${createdAt.replace(/[:.]/g, '-')}-${id}`;
    const candidate = path.join(backupRoot, `.dijital360-${id}.partial`);
    await mkdir(candidate, { mode: 0o700 });
    staging = candidate;
    for (const relative of before.directories) await mkdir(path.join(staging, ...relative.split('/')), { mode: 0o700 });
    const files: { path: string; size: number; sha256: string }[] = [];
    for (const file of before.files) {
      const destination = path.join(staging, ...file.path.split('/'));
      const current = await lstat(file.source, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || fingerprint(current) !== file.fingerprint) return fail('BACKUP_VERIFICATION_FAILED');
      await copyFile(file.source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      const sourceHash = await sha256(file.source);
      const copyHash = await sha256(destination);
      if (sourceHash !== copyHash || (await lstat(destination)).size !== file.size) return fail('BACKUP_VERIFICATION_FAILED');
      files.push({ path: file.path, size: file.size, sha256: sourceHash });
    }
    const after = await inventory(dataRoot);
    if (JSON.stringify(before) !== JSON.stringify(after)) return fail('BACKUP_VERIFICATION_FAILED');
    await writeFile(path.join(staging, 'backup-manifest.json'), JSON.stringify({
      application: 'dijital360-print-shop', formatVersion: 1, createdAt, files,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const directory = path.join(backupRoot, name);
    try { await lstat(directory); return fail('BACKUP_FAILED'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(staging, directory);
    staging = undefined;
    return { directory, files: files.length };
  } catch (error) {
    if (error instanceof WindowsBackupError) throw error;
    throw new WindowsBackupError('BACKUP_FAILED');
  } finally {
    let cleanupFailed = false;
    if (staging) { try { await rm(staging, { recursive: true, force: true }); } catch { cleanupFailed = true; } }
    if (release) { try { await release(); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new WindowsBackupError('BACKUP_FAILED');
  }
}
