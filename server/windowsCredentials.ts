import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ShopRepository } from './repository.ts';
import { hashPassword, verifyPassword } from './http.ts';

const MAX_CREDENTIAL_FILE_BYTES = 65_536;
const PROTECTION = 'windows-dpapi-current-user';
const SAFE_ERROR = 'Windows sign-in details could not be prepared securely.';

export class WindowsCredentialsError extends Error {
  readonly code = 'WINDOWS_CREDENTIALS_UNAVAILABLE';
  constructor() { super(SAFE_ERROR); this.name = 'WindowsCredentialsError'; }
}

export interface WindowsCredentialProtection {
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

export interface PowerShellInvocation {
  executable: string;
  args: string[];
  input: string;
  captureOutput: boolean;
}
export type PowerShellRunner = (invocation: PowerShellInvocation) => Promise<string>;
export interface WindowsPowerShellOptions {
  /** Dependency injection for tests; production uses the real Windows process. */
  runner?: PowerShellRunner;
  platform?: NodeJS.Platform;
  systemRoot?: string;
}

const POWERSHELL_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  '$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))',
  '$inputData = $reader.ReadToEnd()',
].join('; ');
const PROTECT_COMMAND = `${POWERSHELL_PREAMBLE};
Add-Type -AssemblyName System.Security;
$plain = [Text.Encoding]::UTF8.GetBytes($inputData);
$encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);
$outputBytes = [Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($encrypted));
([Console]::OpenStandardOutput()).Write($outputBytes, 0, $outputBytes.Length);`;
const UNPROTECT_COMMAND = `${POWERSHELL_PREAMBLE};
Add-Type -AssemblyName System.Security;
$encrypted = [Convert]::FromBase64String($inputData);
$plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);
([Console]::OpenStandardOutput()).Write($plain, 0, $plain.Length);`;
const SHOW_COMMAND = `${POWERSHELL_PREAMBLE};
Add-Type -AssemblyName PresentationFramework;
$details = $inputData | ConvertFrom-Json;
$message = 'E-posta: ' + [string]$details.email;
if ($details.password) {
  $message += "\r\nParola: " + [string]$details.password;
  $message += "\r\n\r\nBu bilgiler bu Windows hesabinda guvenle saklanir.";
} else {
  $message += "\r\n\r\nMevcut personel parolanizi kullanin. Parolaniz degistirilmedi.";
};
[void][System.Windows.MessageBox]::Show($message, 'Dijital360 Print Shop', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Information);`;

function windowsPowerShell(options: WindowsPowerShellOptions): string {
  if ((options.platform ?? process.platform) !== 'win32') throw new WindowsCredentialsError();
  const root = options.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root) || root.startsWith('\\\\')) throw new WindowsCredentialsError();
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Output is always a private pipe; the GUI process has no stdout at all. */
const runPowerShell: PowerShellRunner = (invocation) => new Promise((resolve, reject) => {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.executable, invocation.args, {
      shell: false, windowsHide: true,
      stdio: ['pipe', invocation.captureOutput ? 'pipe' : 'ignore', 'ignore'],
    });
  } catch { reject(new WindowsCredentialsError()); return; }
  let settled = false;
  let size = 0;
  const chunks: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (!success) {
      chunks.length = 0;
      child.kill();
      reject(new WindowsCredentialsError());
    } else resolve(Buffer.concat(chunks).toString('utf8'));
  };
  child.on('error', () => finish(false));
  child.on('close', (code) => finish(code === 0));
  child.stdin?.on('error', () => finish(false));
  child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_CREDENTIAL_FILE_BYTES) finish(false);
    else if (!settled) chunks.push(chunk);
  });
  if (invocation.captureOutput) {
    timer = setTimeout(() => finish(false), 15_000);
    timer.unref();
  }
  child.stdin?.end(invocation.input, 'utf8');
});

function invocation(executable: string, command: string, input: string, captureOutput: boolean): PowerShellInvocation {
  return {
    executable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-Command', command],
    input, captureOutput,
  };
}

function validCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CREDENTIAL_FILE_BYTES
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function createWindowsDpapiProtection(options: WindowsPowerShellOptions = {}): WindowsCredentialProtection {
  const executable = windowsPowerShell(options);
  const runner = options.runner ?? runPowerShell;
  return {
    async protect(plaintext) {
      try {
        const ciphertext = (await runner(invocation(executable, PROTECT_COMMAND, plaintext, true))).trim();
        if (!validCiphertext(ciphertext)) throw new WindowsCredentialsError();
        return ciphertext;
      } catch { throw new WindowsCredentialsError(); }
    },
    async unprotect(ciphertext) {
      try {
        if (!validCiphertext(ciphertext)) throw new WindowsCredentialsError();
        return await runner(invocation(executable, UNPROTECT_COMMAND, ciphertext, true));
      } catch { throw new WindowsCredentialsError(); }
    },
  };
}

function normalizedEmail(value: unknown): string {
  if (typeof value !== 'string') throw new WindowsCredentialsError();
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new WindowsCredentialsError();
  return email;
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function scopedCredentialsFile(filename: string, localAppData?: string): string {
  if (!localAppData || !path.isAbsolute(localAppData) || !path.isAbsolute(filename)) throw new WindowsCredentialsError();
  const resolved = path.resolve(filename);
  const relative = path.relative(path.resolve(localAppData), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WindowsCredentialsError();
  }
  return resolved;
}

interface StoredOwner { version: 1; email: string; password: string }
async function readStoredOwner(filename: string, email: string, protection: WindowsCredentialProtection): Promise<StoredOwner | undefined> {
  let info;
  try { info = await lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CREDENTIAL_FILE_BYTES) throw new WindowsCredentialsError();
  const serialized = await readFile(filename, 'utf8');
  if (Buffer.byteLength(serialized) > MAX_CREDENTIAL_FILE_BYTES) throw new WindowsCredentialsError();
  const envelope: unknown = JSON.parse(serialized);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new WindowsCredentialsError();
  const record = envelope as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['version', 'protection', 'ciphertext'].includes(key))
    || record.version !== 1 || record.protection !== PROTECTION || !validCiphertext(record.ciphertext)) {
    throw new WindowsCredentialsError();
  }
  const plaintext: unknown = JSON.parse(await protection.unprotect(record.ciphertext));
  if (!plaintext || typeof plaintext !== 'object' || Array.isArray(plaintext)) throw new WindowsCredentialsError();
  const owner = plaintext as Record<string, unknown>;
  if (Object.keys(owner).some((key) => !['version', 'email', 'password'].includes(key))
    || owner.version !== 1 || normalizedEmail(owner.email) !== email || !validPassword(owner.password)) {
    throw new WindowsCredentialsError();
  }
  return { version: 1, email, password: owner.password };
}

/** A same-directory hard link publishes complete encrypted bytes without replacing a winner. */
async function writeExclusive(filename: string, ciphertext: string): Promise<boolean> {
  if (!validCiphertext(ciphertext)) throw new WindowsCredentialsError();
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.owner-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ version: 1, protection: PROTECTION, ciphertext }) + '\n', 'utf8');
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, filename); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally { await unlink(temporary); }
}

export interface WindowsOwnerOptions { email: string; credentialsFile: string }
export interface WindowsOwnerDependencies {
  /** Fake protection is for unit tests only; production defaults to CurrentUser DPAPI. */
  protection?: WindowsCredentialProtection;
  localAppData?: string;
  generatePassword?: () => string;
}
export interface WindowsOwnerDetails { email: string; password?: string; created: boolean }

/** Read only this application's protected file; no database, creation or reset. */
export async function readWindowsCredentials(
  options: WindowsOwnerOptions,
  dependencies: WindowsOwnerDependencies = {},
): Promise<{ email: string; password?: string }> {
  try {
    const email = normalizedEmail(options.email);
    const filename = scopedCredentialsFile(options.credentialsFile, dependencies.localAppData ?? process.env.LOCALAPPDATA);
    const stored = await readStoredOwner(filename, email, dependencies.protection ?? createWindowsDpapiProtection());
    return { email, ...(stored ? { password: stored.password } : {}) };
  } catch { throw new WindowsCredentialsError(); }
}

export async function ensureWindowsOwner(
  repository: Pick<ShopRepository, 'findStaff' | 'createStaff'>,
  options: WindowsOwnerOptions,
  dependencies: WindowsOwnerDependencies = {},
): Promise<WindowsOwnerDetails> {
  try {
    const email = normalizedEmail(options.email);
    const filename = scopedCredentialsFile(options.credentialsFile, dependencies.localAppData ?? process.env.LOCALAPPDATA);
    const protection = dependencies.protection ?? createWindowsDpapiProtection();
    const existing = await repository.findStaff(email);
    let stored = await readStoredOwner(filename, email, protection);
    if (existing) {
      if (!stored) return { email, created: false };
      if (!await verifyPassword(stored.password, existing.passwordHash)) throw new WindowsCredentialsError();
      return { email, password: stored.password, created: false };
    }
    if (!stored) {
      const password = (dependencies.generatePassword ?? (() => randomBytes(24).toString('base64url')))();
      if (!validPassword(password)) throw new WindowsCredentialsError();
      stored = { version: 1, email, password };
      const ciphertext = await protection.protect(JSON.stringify(stored));
      if (!await writeExclusive(filename, ciphertext)) {
        stored = await readStoredOwner(filename, email, protection);
        if (!stored) throw new WindowsCredentialsError();
      }
    }
    try {
      await repository.createStaff(email, await hashPassword(stored.password));
      return { email, password: stored.password, created: true };
    } catch {
      // A concurrent launch may have created this account. Never reset it.
      const winner = await repository.findStaff(email);
      if (!winner || !await verifyPassword(stored.password, winner.passwordHash)) throw new WindowsCredentialsError();
      return { email, password: stored.password, created: false };
    }
  } catch { throw new WindowsCredentialsError(); }
}

/** Sign-in details are shown only in a native window, never stdout, argv or a file. */
export async function showWindowsCredentials(
  details: { email: string; password?: string },
  options: WindowsPowerShellOptions = {},
): Promise<void> {
  try {
    const email = normalizedEmail(details.email);
    if (details.password !== undefined && !validPassword(details.password)) throw new WindowsCredentialsError();
    await (options.runner ?? runPowerShell)(invocation(windowsPowerShell(options), SHOW_COMMAND,
      JSON.stringify({ email, ...(details.password === undefined ? {} : { password: details.password }) }), false));
  } catch { throw new WindowsCredentialsError(); }
}
