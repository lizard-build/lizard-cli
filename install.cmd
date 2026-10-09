@echo off
setlocal
set "RELEASE_BASE=https://github.com/lizard-build/lizard-cli/releases/latest/download"
set "INSTALL_DIR=%USERPROFILE%\.lizard\bin"
set "BINARY=lizard-windows-x64.exe"

echo.
echo Lizard CLI installer
echo.
echo Downloading %BINARY%...

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
curl -fsSL "%RELEASE_BASE%/%BINARY%" -o "%INSTALL_DIR%\lizard.exe"
if errorlevel 1 (
  echo Error: Download failed: %RELEASE_BASE%/%BINARY%
  exit /b 1
)

rem Add to the user PATH through PowerShell: setx cuts PATH at 1024 characters
rem and copies the system PATH into the user one.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = $env:INSTALL_DIR; $p = [Environment]::GetEnvironmentVariable('PATH', 'User'); if (($p -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('PATH', ((@($p, $dir) | Where-Object { $_ }) -join ';'), 'User') }"

echo.
echo Installed to %INSTALL_DIR%\lizard.exe
echo.

rem Set the machine up right away: sign in, then whatever the account still
rem needs. lizard picks the mode itself: questions for a person at a terminal,
rem JSON lines for a coding agent whose shell captures the output.
rem LIZARD_NO_ONBOARD=1 skips this, as does CI.
if defined LIZARD_NO_ONBOARD (
  echo   Run: lizard onboard
  echo.
) else if defined CI (
  echo   Run: lizard onboard
  echo.
) else (
  "%INSTALL_DIR%\lizard.exe" onboard
)

rem Make lizard available in this window too; endlocal would drop a plain set.
endlocal & set "PATH=%PATH%;%USERPROFILE%\.lizard\bin"
