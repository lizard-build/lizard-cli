#!/bin/bash
set -e

BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
RED="\033[31m"
DIM="\033[2m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}Lizard CLI${RESET} installer"
echo ""

# ── Check Node.js ────────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Error:${RESET} Node.js is required but not found."
  echo ""
  echo "Install Node.js 18+ from https://nodejs.org"
  echo "Or use a version manager:"
  echo "  curl -fsSL https://fnm.vercel.app/install | bash"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(parseInt(process.version.slice(1))))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${RED}Error:${RESET} Node.js 18+ is required (you have $(node -v))"
  echo "Upgrade at https://nodejs.org"
  exit 1
fi

# ── Install via npm ──────────────────────────────────────────────────────────

if ! command -v npm >/dev/null 2>&1; then
  echo -e "${RED}Error:${RESET} npm not found. Please install npm."
  exit 1
fi

echo -e "${DIM}Installing @lizard-build/cli...${RESET}"
npm install -g @lizard-build/cli --quiet

# ── Verify ───────────────────────────────────────────────────────────────────

if ! command -v lizard >/dev/null 2>&1; then
  echo ""
  echo -e "${RED}Error:${RESET} Installation succeeded but 'lizard' is not in PATH."
  echo "You may need to add npm global bin to your PATH:"
  echo "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  exit 1
fi

VERSION=$(lizard version --json 2>/dev/null | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).version)}catch{process.stdout.write('?')}})" 2>/dev/null || echo "?")

echo ""
echo -e "${GREEN}✓${RESET} Lizard CLI ${BOLD}v${VERSION}${RESET} installed"
echo ""
echo -e "  Run ${CYAN}lizard login${RESET} to get started"
echo ""
