$ErrorActionPreference = 'Stop'
$RELEASE_BASE = "https://github.com/lizard-build/lizard-cli/releases/latest/download"
$INSTALL_DIR = "$env:USERPROFILE\.lizard\bin"

Write-Host ""
Write-Host "Lizard CLI installer" -ForegroundColor White
Write-Host ""

$BINARY = "lizard-windows-x64.exe"
Write-Host "Downloading $BINARY..." -ForegroundColor DarkGray

New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
$dest = "$INSTALL_DIR\lizard.exe"
Invoke-WebRequest -Uri "$RELEASE_BASE/$BINARY" -OutFile $dest

$currentPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$INSTALL_DIR*") {
  [System.Environment]::SetEnvironmentVariable("PATH", "$currentPath;$INSTALL_DIR", "User")
  $env:PATH += ";$INSTALL_DIR"
}

$VERSION = & $dest --version 2>$null | Select-Object -First 1
Write-Host ""
Write-Host "Lizard CLI v$VERSION installed" -ForegroundColor Green
Write-Host ""

# Sign in right away, then set up what the account still needs: `lizard
# login` offers Pro when there is no plan. A person at a terminal gets
# questions and a browser. A coding agent, whose shell captures the output,
# gets JSON with the sign-in links and what to do next, and the installer
# returns at once. LIZARD_NO_LOGIN=1 skips this, as does CI.
if ($env:LIZARD_NO_LOGIN -or $env:CI) {
  Write-Host "  Run: lizard login" -ForegroundColor Cyan
  Write-Host ""
} elseif ([Console]::IsOutputRedirected -or [Console]::IsInputRedirected) {
  & $dest login --json
} else {
  & $dest login
}
