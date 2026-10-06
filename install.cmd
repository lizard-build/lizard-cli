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
echo   Run: lizard login
echo.

rem Make lizard available in this window too; endlocal would drop a plain set.
endlocal & set "PATH=%PATH%;%USERPROFILE%\.lizard\bin"
