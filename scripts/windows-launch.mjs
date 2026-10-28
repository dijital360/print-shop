import { runWindowsLauncher, WindowsLocalError } from '../server/windowsLauncher.ts';

void runWindowsLauncher().catch((error) => {
  console.error(error instanceof WindowsLocalError ? error.message
    : 'Print Shop baslatilamadi. Paketi tamamen ayiklayin; mevcut veriler korunuyor.');
  process.exitCode = 1;
});
