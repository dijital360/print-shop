import { runWindowsLauncher, WindowsLocalError } from '../server/windowsLauncher.ts';
import { WindowsBackupError } from '../server/windowsBackup.ts';
import { WindowsShellError } from '../server/windowsShell.ts';

void runWindowsLauncher().catch((error) => {
  console.error(error instanceof WindowsLocalError || error instanceof WindowsBackupError || error instanceof WindowsShellError ? error.message
    : 'Print Shop baslatilamadi. Paketi tamamen ayiklayin; mevcut veriler korunuyor.');
  process.exitCode = 1;
});
