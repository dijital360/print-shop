// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PowerShellInvocation } from './windowsCredentials.ts';
import { installWindowsDesktopShortcut, showWindowsNotice, WindowsShellError } from './windowsShell.ts';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'print-shop-windows-shell-test-'));
  directories.push(directory);
  const root = path.join(directory, "Dijital360 'paket' (örnek)");
  await mkdir(root);
  await writeFile(path.join(root, 'Baslat.cmd'), '@echo off\r\n');
  const runner = vi.fn(async (_request: PowerShellInvocation) => '');
  return { directory, root, runner, options: { platform: 'win32' as const, systemRoot: 'C:\\Windows', runner } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Windows desktop shell adapters with an injected process runner', () => {
  it('passes validated absolute package paths only through stdin with safe process arguments', async () => {
    const setup = await fixture();
    await installWindowsDesktopShortcut(setup.root, setup.options);
    const invocation = setup.runner.mock.calls[0]![0];
    expect(invocation.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(JSON.parse(invocation.input)).toEqual({ packageRoot: setup.root, target: path.join(setup.root, 'Baslat.cmd') });
    expect(invocation.args.join(' ')).not.toContain(setup.root);
    expect(invocation.args).not.toContain('-ExecutionPolicy');
    expect(invocation.args).toContain('-NoProfile');
    expect(invocation.captureOutput).toBe(false);
  });

  it('uses the same fixed shortcut command when the package has moved', async () => {
    const setup = await fixture();
    await installWindowsDesktopShortcut(setup.root, setup.options);
    const moved = path.join(setup.directory, 'Moved package');
    await mkdir(moved);
    await writeFile(path.join(moved, 'Baslat.cmd'), '@echo off\r\n');
    await installWindowsDesktopShortcut(moved, setup.options);
    const [first, second] = setup.runner.mock.calls.map(([invocation]) => invocation);
    expect(second!.args).toEqual(first!.args);
    expect(JSON.parse(second!.input)).toEqual({ packageRoot: moved, target: path.join(moved, 'Baslat.cmd') });
  });

  it('rejects invalid, missing, or linked package paths before invoking PowerShell', async () => {
    const setup = await fixture();
    await expect(installWindowsDesktopShortcut('relative', setup.options)).rejects.toEqual(new WindowsShellError());
    await expect(installWindowsDesktopShortcut(path.join(setup.directory, 'missing'), setup.options)).rejects.toEqual(new WindowsShellError());
    await expect(installWindowsDesktopShortcut(path.join(setup.root, 'Baslat.cmd'), setup.options)).rejects.toEqual(new WindowsShellError());
    const empty = path.join(setup.directory, 'empty');
    await mkdir(empty);
    await expect(installWindowsDesktopShortcut(empty, setup.options)).rejects.toEqual(new WindowsShellError());
    const linked = path.join(setup.directory, 'linked-package');
    await symlink(setup.root, linked, 'junction');
    await expect(installWindowsDesktopShortcut(linked, setup.options)).rejects.toEqual(new WindowsShellError());
    expect(setup.runner).not.toHaveBeenCalled();
  });

  it('sanitizes an unrelated-shortcut failure without modifying the package or logging private paths', async () => {
    const setup = await fixture();
    const before = await readFile(path.join(setup.root, 'Baslat.cmd'));
    setup.runner.mockRejectedValueOnce(new Error(`Unrelated desktop file: ${setup.root}`));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(installWindowsDesktopShortcut(setup.root, setup.options)).rejects.toEqual(new WindowsShellError());
    expect(await readFile(path.join(setup.root, 'Baslat.cmd'))).toEqual(before);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('shows Turkish notices only in a native dialog with text passed as UTF-8 JSON input', async () => {
    const setup = await fixture();
    const message = "Kurulum tamamlandı. 'Özel' mesaj: $(Write-Output test)\nİkinci satır.";
    setup.runner.mockResolvedValueOnce('Ignored process output');
    await expect(showWindowsNotice(message, setup.options)).resolves.toBeUndefined();
    const invocation = setup.runner.mock.calls[0]![0];
    expect(JSON.parse(invocation.input)).toEqual({ message });
    expect(invocation.args.join(' ')).not.toContain(message);
    expect(invocation.captureOutput).toBe(false);
  });

  it('fails closed on unsupported platforms and invalid notices without process calls', async () => {
    const setup = await fixture();
    await expect(installWindowsDesktopShortcut(setup.root, { ...setup.options, platform: 'linux' })).rejects.toEqual(new WindowsShellError());
    await expect(showWindowsNotice('Notice', { ...setup.options, systemRoot: 'relative' })).rejects.toEqual(new WindowsShellError());
    for (const message of ['', ' ', '\0unsafe', 'x'.repeat(4001)]) {
      await expect(showWindowsNotice(message, setup.options)).rejects.toEqual(new WindowsShellError());
    }
    expect(setup.runner).not.toHaveBeenCalled();
  });
});
