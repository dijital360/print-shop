import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { PowerShellInvocation, PowerShellRunner } from './windowsCredentials.ts';

export interface WindowsShellOptions {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  runner?: PowerShellRunner;
}
export class WindowsShellError extends Error {
  readonly code = 'WINDOWS_SHELL_UNAVAILABLE';
  constructor() {
    super('Windows desktop integration could not be prepared securely.');
    this.name = 'WindowsShellError';
  }
}

const PREAMBLE = `$ErrorActionPreference = 'Stop';
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false));
$details = $reader.ReadToEnd() | ConvertFrom-Json;`;

const SHORTCUT_COMMAND = `${PREAMBLE}
$packageRoot = [string]$details.packageRoot;
$target = [string]$details.target;
if (-not [IO.Path]::IsPathRooted($packageRoot) -or -not [IO.Path]::IsPathRooted($target)) { throw 'Invalid package path' };
if ([IO.Path]::Combine($packageRoot, 'Baslat.cmd') -ine $target) { throw 'Invalid command path' };
$packageItem = Get-Item -LiteralPath $packageRoot -Force;
$commandItem = Get-Item -LiteralPath $target -Force;
if (-not $packageItem.PSIsContainer -or $commandItem.PSIsContainer -or
    ($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    ($commandItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid package type' };
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory);
if ([string]::IsNullOrWhiteSpace($desktop) -or -not [IO.Directory]::Exists($desktop)) { throw 'Desktop unavailable' };
$destination = [IO.Path]::Combine($desktop, 'Dijital360 Print Shop.lnk');
$description = 'Dijital360 Print Shop local application';
$shell = New-Object -ComObject WScript.Shell;
$temporary = $null;
$shortcut = $null;
function Assert-OwnedShortcut([string]$filename) {
  $item = Get-Item -LiteralPath $filename -Force -ErrorAction SilentlyContinue;
  if ($null -eq $item) { return $false };
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unrelated desktop item' };
  $existing = $shell.CreateShortcut($filename);
  try {
    if ($existing.Description -cne $description -or
        [IO.Path]::GetFileName([string]$existing.TargetPath) -ine 'Baslat.cmd' -or
        -not [string]::IsNullOrEmpty([string]$existing.Arguments) -or
        [IO.Path]::GetDirectoryName([string]$existing.TargetPath) -ine [string]$existing.WorkingDirectory) {
      throw 'Unrelated desktop shortcut';
    };
    return $true;
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($existing) };
};
try {
  $owned = Assert-OwnedShortcut $destination;
  $temporary = [IO.Path]::Combine($desktop, ([Guid]::NewGuid().ToString() + '.lnk'));
  if (Get-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue) { throw 'Temporary item exists' };
  $shortcut = $shell.CreateShortcut($temporary);
  $shortcut.TargetPath = $target;
  $shortcut.WorkingDirectory = $packageRoot;
  $shortcut.Arguments = '';
  $shortcut.Description = $description;
  $shortcut.Save();
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut);
  $shortcut = $null;
  $staged = Get-Item -LiteralPath $temporary -Force;
  if ($staged.PSIsContainer -or ($staged.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid temporary shortcut' };
  if ($owned) {
    if (-not (Assert-OwnedShortcut $destination)) { throw 'Shortcut changed' };
    [IO.File]::Replace($temporary, $destination, $null);
  } else {
    if (Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue) { throw 'Desktop item appeared' };
    [IO.File]::Move($temporary, $destination);
  };
  $temporary = $null;
} finally {
  if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) };
  if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) };
  if ($null -ne $temporary) {
    $remaining = Get-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue;
    if ($null -ne $remaining -and -not $remaining.PSIsContainer -and
        ($remaining.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { [IO.File]::Delete($temporary) };
  };
};`;

const NOTICE_COMMAND = `${PREAMBLE}
Add-Type -AssemblyName PresentationFramework;
[void][System.Windows.MessageBox]::Show([string]$details.message, 'Dijital360 Print Shop', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Information);`;

function executable(options: WindowsShellOptions): string {
  if ((options.platform ?? process.platform) !== 'win32') throw new WindowsShellError();
  const root = options.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root) || root.startsWith('\\\\')) throw new WindowsShellError();
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowerShell(request: PowerShellInvocation, timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(request.executable, request.args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch { reject(new WindowsShellError()); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (success) resolve('');
      else { child.kill(); reject(new WindowsShellError()); }
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    child.stdin?.on('error', () => finish(false));
    if (timeout) { timer = setTimeout(() => finish(false), timeout); timer.unref(); }
    child.stdin?.end(request.input, 'utf8');
  });
}

function request(executablePath: string, command: string, details: object): PowerShellInvocation {
  return {
    executable: executablePath,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-Command', command],
    input: JSON.stringify(details), captureOutput: false,
  };
}

/** Install or refresh only this application's DesktopDirectory shortcut. */
export async function installWindowsDesktopShortcut(packageRoot: string, options: WindowsShellOptions = {}): Promise<void> {
  try {
    const executablePath = executable(options);
    if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) throw new WindowsShellError();
    const root = path.resolve(packageRoot);
    const target = path.join(root, 'Baslat.cmd');
    const [directory, command] = await Promise.all([lstat(root), lstat(target)]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !command.isFile() || command.isSymbolicLink()) {
      throw new WindowsShellError();
    }
    await (options.runner ?? ((invocation) => runPowerShell(invocation, 15_000)))(request(executablePath, SHORTCUT_COMMAND, { packageRoot: root, target }));
  } catch { throw new WindowsShellError(); }
}

/** Native informational dialog; text never reaches the console or process argv. */
export async function showWindowsNotice(message: string, options: WindowsShellOptions = {}): Promise<void> {
  try {
    const executablePath = executable(options);
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) {
      throw new WindowsShellError();
    }
    await (options.runner ?? runPowerShell)(request(executablePath, NOTICE_COMMAND, { message }));
  } catch { throw new WindowsShellError(); }
}
