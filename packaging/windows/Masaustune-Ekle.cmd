@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PRINT_SHOP_BOOT_EXIT=1"
cd /d "%~dp0"
if errorlevel 1 goto root_error
set "PRINT_SHOP_BOOT_ROOT=%~dp0"
set "PRINT_SHOP_RUNTIME_ARCH="
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PRINT_SHOP_RUNTIME_ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "PRINT_SHOP_RUNTIME_ARCH=arm64"
if not defined PRINT_SHOP_RUNTIME_ARCH if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "PRINT_SHOP_RUNTIME_ARCH=x64"
if not defined PRINT_SHOP_RUNTIME_ARCH if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "PRINT_SHOP_RUNTIME_ARCH=x64"
if not defined PRINT_SHOP_RUNTIME_ARCH goto architecture_error
set "PRINT_SHOP_NODE_EXE=%PRINT_SHOP_BOOT_ROOT%runtime\%PRINT_SHOP_RUNTIME_ARCH%\node.exe"
if not exist "%PRINT_SHOP_NODE_EXE%" goto runtime_error
if not exist "%PRINT_SHOP_BOOT_ROOT%runtime-manifest.json" goto runtime_error
if not exist "%PRINT_SHOP_BOOT_ROOT%app\scripts\windows-launch.mjs" goto runtime_error
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto powershell_error
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { $manifestPath=Join-Path -Path $env:PRINT_SHOP_BOOT_ROOT -ChildPath 'runtime-manifest.json'; $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json; $runtime=$manifest.PSObject.Properties[$env:PRINT_SHOP_RUNTIME_ARCH]; if ($null -eq $runtime) { throw 'Runtime entry is missing.' }; $expected=$runtime.Value.exeSha256; if ($expected -isnot [string] -or $expected -notmatch '\A[0-9a-fA-F]{64}\z') { throw 'Invalid runtime checksum.' }; $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $env:PRINT_SHOP_NODE_EXE).Hash; if (-not [string]::Equals($actual,$expected,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime checksum mismatch.' }; exit 0 } catch { [Console]::Error.WriteLine('Bundled Node verification failed. Extract a fresh, complete package.'); exit 1 }"
set "PRINT_SHOP_BOOT_EXIT=%ERRORLEVEL%"
if not "%PRINT_SHOP_BOOT_EXIT%"=="0" goto finish
"%PRINT_SHOP_NODE_EXE%" "%PRINT_SHOP_BOOT_ROOT%app\scripts\windows-launch.mjs" --install-shortcut
set "PRINT_SHOP_BOOT_EXIT=%ERRORLEVEL%"
goto finish

:root_error
echo Could not open the application folder. Extract the ZIP before starting.
goto finish

:architecture_error
echo This package requires Windows 10 or 11 on x64 or ARM64.
echo 32-bit Windows is not supported.
goto finish

:runtime_error
echo The package is incomplete. Extract the full ZIP into one folder.
goto finish

:powershell_error
echo Windows PowerShell is required to verify the bundled runtime.
goto finish

:finish
if not "%PRINT_SHOP_BOOT_EXIT%"=="0" (
  echo.
  echo Print Shop could not finish normally. The error is shown above.
  pause
)
exit /b %PRINT_SHOP_BOOT_EXIT%
