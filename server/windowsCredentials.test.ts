// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './http.ts';
import { RepoError } from './repository.ts';
import {
  createWindowsDpapiProtection, ensureWindowsOwner, readWindowsCredentials,
  showWindowsCredentials, WindowsCredentialsError,
  type PowerShellInvocation, type WindowsCredentialProtection,
} from './windowsCredentials.ts';

const EMAIL = 'owner@example.test';
const directories: string[] = [];
const password = () => randomBytes(24).toString('base64url');

function fakeProtection() {
  const records = new Map<string, string>();
  const protection: WindowsCredentialProtection = {
    protect: vi.fn(async (plaintext: string) => {
      const ciphertext = randomBytes(48).toString('base64');
      records.set(ciphertext, plaintext);
      return ciphertext;
    }),
    unprotect: vi.fn(async (ciphertext: string) => {
      const plaintext = records.get(ciphertext);
      if (plaintext === undefined) throw new Error('Fixture cannot be decrypted.');
      return plaintext;
    }),
  };
  return protection;
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'print-shop-windows-owner-test-'));
  directories.push(directory);
  const options = { email: EMAIL, credentialsFile: path.join(directory, 'Dijital360', 'owner.json') };
  const protection = fakeProtection();
  let account: { id: string; passwordHash: string } | undefined;
  const repository = {
    findStaff: vi.fn(async (_email: string) => account ?? null),
    createStaff: vi.fn(async (_email: string, passwordHash: string) => {
      if (account) throw new RepoError('CONFLICT', 409);
      account = { id: 'fixture-owner', passwordHash };
    }),
  };
  return {
    directory, options, protection, repository,
    dependencies: { protection, localAppData: directory },
    get account() { return account; },
    setAccount(value: { id: string; passwordHash: string }) { account = value; },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Windows owner provisioning with an injected protection backend', () => {
  it('publishes only protected bytes before creating an account and reuses them on restart', async () => {
    const setup = await fixture();
    const secret = password();
    const generatePassword = vi.fn(() => secret);
    const originalCreate = setup.repository.createStaff.getMockImplementation()!;
    setup.repository.createStaff.mockImplementation(async (email, passwordHash) => {
      const serialized = await readFile(setup.options.credentialsFile, 'utf8');
      expect(JSON.parse(serialized)).toMatchObject({ version: 1, protection: 'windows-dpapi-current-user' });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(email);
      expect(await readdir(path.dirname(setup.options.credentialsFile))).toEqual(['owner.json']);
      await originalCreate(email, passwordHash);
    });
    const dependencies = { ...setup.dependencies, generatePassword };
    const created = await ensureWindowsOwner(setup.repository, setup.options, dependencies);
    expect(created).toEqual({ email: EMAIL, password: secret, created: true });
    expect(await verifyPassword(secret, setup.account!.passwordHash)).toBe(true);
    const before = await readFile(setup.options.credentialsFile);
    expect(await ensureWindowsOwner(setup.repository, setup.options, dependencies)).toEqual({
      email: EMAIL, password: secret, created: false,
    });
    expect(await readWindowsCredentials(setup.options, setup.dependencies)).toEqual({ email: EMAIL, password: secret });
    expect(await readFile(setup.options.credentialsFile)).toEqual(before);
    expect(setup.repository.createStaff).toHaveBeenCalledTimes(1);
    expect(setup.protection.protect).toHaveBeenCalledTimes(1);
    expect(generatePassword).toHaveBeenCalledTimes(1);
  });

  it('does not create files or reset an existing account without saved credentials', async () => {
    const setup = await fixture();
    const passwordHash = await hashPassword(password());
    setup.setAccount({ id: 'existing-owner', passwordHash });
    const generatePassword = vi.fn(password);
    expect(await ensureWindowsOwner(setup.repository, setup.options, { ...setup.dependencies, generatePassword }))
      .toEqual({ email: EMAIL, created: false });
    expect(await readWindowsCredentials(setup.options, setup.dependencies)).toEqual({ email: EMAIL });
    expect(setup.account).toEqual({ id: 'existing-owner', passwordHash });
    expect(setup.repository.createStaff).not.toHaveBeenCalled();
    expect(generatePassword).not.toHaveBeenCalled();
    expect(setup.protection.protect).not.toHaveBeenCalled();
    expect(setup.protection.unprotect).not.toHaveBeenCalled();
    await expect(access(path.dirname(setup.options.credentialsFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves protected recovery information if database creation fails, then safely retries', async () => {
    const setup = await fixture();
    const secret = password();
    const generatePassword = vi.fn(() => secret);
    setup.repository.createStaff.mockRejectedValueOnce(new Error(`Private fixture detail ${secret}`));
    const dependencies = { ...setup.dependencies, generatePassword };
    await expect(ensureWindowsOwner(setup.repository, setup.options, dependencies)).rejects.toEqual(new WindowsCredentialsError());
    const protectedBefore = await readFile(setup.options.credentialsFile);
    expect(setup.account).toBeUndefined();
    expect(await ensureWindowsOwner(setup.repository, setup.options, dependencies)).toEqual({
      email: EMAIL, password: secret, created: true,
    });
    expect(await readFile(setup.options.credentialsFile)).toEqual(protectedBefore);
    expect(setup.protection.protect).toHaveBeenCalledTimes(1);
    expect(generatePassword).toHaveBeenCalledTimes(1);
  });

  it('lets concurrent launches share the exclusively published password without resetting the winner', async () => {
    const setup = await fixture();
    const results = await Promise.all([
      ensureWindowsOwner(setup.repository, setup.options, setup.dependencies),
      ensureWindowsOwner(setup.repository, setup.options, setup.dependencies),
    ]);
    expect(results[0]!.password).toBe(results[1]!.password);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await verifyPassword(results[0]!.password!, setup.account!.passwordHash)).toBe(true);
    expect(await readdir(path.dirname(setup.options.credentialsFile))).toEqual(['owner.json']);
  });

  it('fails closed for malformed, undecryptable, and mismatched protected credentials', async () => {
    const setup = await fixture();
    await ensureWindowsOwner(setup.repository, setup.options, setup.dependencies);
    const original = await readFile(setup.options.credentialsFile, 'utf8');
    const originalHash = setup.account!.passwordHash;
    for (const contents of ['not JSON', JSON.stringify({
      version: 1, protection: 'windows-dpapi-current-user', ciphertext: randomBytes(32).toString('base64'),
    })]) {
      await writeFile(setup.options.credentialsFile, contents);
      await expect(ensureWindowsOwner(setup.repository, setup.options, setup.dependencies)).rejects.toEqual(new WindowsCredentialsError());
      await expect(readWindowsCredentials(setup.options, setup.dependencies)).rejects.toEqual(new WindowsCredentialsError());
      expect(await readFile(setup.options.credentialsFile, 'utf8')).toBe(contents);
      expect(setup.account!.passwordHash).toBe(originalHash);
    }
    await writeFile(setup.options.credentialsFile, original);
    const changedHash = await hashPassword(password());
    setup.setAccount({ id: 'fixture-owner', passwordHash: changedHash });
    await expect(ensureWindowsOwner(setup.repository, setup.options, setup.dependencies)).rejects.toEqual(new WindowsCredentialsError());
    expect(await readFile(setup.options.credentialsFile, 'utf8')).toBe(original);
    expect(setup.account!.passwordHash).toBe(changedHash);
    expect(setup.repository.createStaff).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a different account when creation encounters a conflict', async () => {
    const setup = await fixture();
    const otherHash = await hashPassword(password());
    setup.repository.createStaff.mockImplementation(async () => {
      setup.setAccount({ id: 'other-owner', passwordHash: otherHash });
      throw new RepoError('CONFLICT', 409);
    });
    await expect(ensureWindowsOwner(setup.repository, setup.options, setup.dependencies)).rejects.toEqual(new WindowsCredentialsError());
    expect(setup.account).toEqual({ id: 'other-owner', passwordHash: otherHash });
    expect(await readWindowsCredentials(setup.options, setup.dependencies)).toHaveProperty('password');
    expect(setup.repository.createStaff).toHaveBeenCalledTimes(1);
  });

  it('rejects an unexpected stored owner and files outside the application-data root', async () => {
    const setup = await fixture();
    await mkdir(path.dirname(setup.options.credentialsFile), { recursive: true });
    const ciphertext = await setup.protection.protect(JSON.stringify({ version: 1, email: 'different@example.test', password: password() }));
    const contents = JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', ciphertext });
    await writeFile(setup.options.credentialsFile, contents);
    await expect(ensureWindowsOwner(setup.repository, setup.options, setup.dependencies)).rejects.toEqual(new WindowsCredentialsError());
    expect(await readFile(setup.options.credentialsFile, 'utf8')).toBe(contents);
    await expect(readWindowsCredentials({ ...setup.options, credentialsFile: path.join(setup.directory, '..', 'outside.json') }, setup.dependencies))
      .rejects.toEqual(new WindowsCredentialsError());
    expect(setup.repository.createStaff).not.toHaveBeenCalled();
  });
});

describe('fixed Windows PowerShell adapters', () => {
  it('keeps plaintext out of arguments and selects CurrentUser DPAPI using the built-in executable', async () => {
    const calls: PowerShellInvocation[] = [];
    const secret = password();
    const plaintext = JSON.stringify({ email: EMAIL, password: secret });
    const ciphertext = randomBytes(48).toString('base64');
    const runner = vi.fn(async (request: PowerShellInvocation) => {
      calls.push(request);
      return calls.length === 1 ? ciphertext : plaintext;
    });
    const protection = createWindowsDpapiProtection({ platform: 'win32', systemRoot: 'C:\\Windows', runner });
    expect(await protection.protect(plaintext)).toBe(ciphertext);
    expect(await protection.unprotect(ciphertext)).toBe(plaintext);
    for (const call of calls) {
      expect(call.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(call.args).toContain('-NoProfile');
      expect(call.args).not.toContain('-ExecutionPolicy');
      expect(call.args.join(' ')).not.toContain(secret);
      expect(call.args.join(' ')).not.toContain(ciphertext);
      expect(call.args.at(-1)).toContain('DataProtectionScope]::CurrentUser');
      expect(call.captureOutput).toBe(true);
    }
    expect(calls[0]!.input).toBe(plaintext);
    expect(calls[1]!.input).toBe(ciphertext);
  });

  it('presents credentials only in a native GUI and suppresses process stdout', async () => {
    const secret = password() + "'; Write-Output 'fixture'; $";
    const runner = vi.fn(async (_request: PowerShellInvocation) => '');
    const options = { platform: 'win32' as const, systemRoot: 'C:\\Windows', runner };
    await showWindowsCredentials({ email: EMAIL, password: secret }, options);
    const call = runner.mock.calls[0]![0];
    expect(JSON.parse(call.input)).toEqual({ email: EMAIL, password: secret });
    expect(call.args.join(' ')).not.toContain(secret);
    expect(call.args.at(-1)).toContain('Add-Type -AssemblyName PresentationFramework');
    expect(call.args.at(-1)).toContain('[void][System.Windows.MessageBox]::Show');
    expect(call.captureOutput).toBe(false);
    await showWindowsCredentials({ email: EMAIL }, options);
    expect(JSON.parse(runner.mock.calls[1]![0].input)).toEqual({ email: EMAIL });
    expect(runner.mock.calls[1]![0].args).toEqual(call.args);
  });

  it('refuses unsupported platforms and exposes only fixed safe errors without logging secrets', async () => {
    const secret = password();
    const runner = vi.fn(async () => { throw new Error(secret); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => createWindowsDpapiProtection({ platform: 'linux', runner })).toThrow(WindowsCredentialsError);
    expect(() => createWindowsDpapiProtection({ platform: 'win32', systemRoot: 'relative', runner })).toThrow(WindowsCredentialsError);
    const options = { platform: 'win32' as const, systemRoot: 'C:\\Windows', runner };
    await expect(createWindowsDpapiProtection(options).protect(secret)).rejects.toEqual(new WindowsCredentialsError());
    await expect(showWindowsCredentials({ email: EMAIL, password: secret }, options)).rejects.toEqual(new WindowsCredentialsError());
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
