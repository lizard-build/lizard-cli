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
Write-Host "  Run: lizard login" -ForegroundColor Cyan
Write-Host ""
