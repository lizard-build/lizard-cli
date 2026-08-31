#!/bin/bash
set -e

BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
RED="\033[31m"
DIM="\033[2m"
RESET="\033[0m"

RELEASE_BASE="https://github.com/lizard-build/lizard-cli/releases/latest/download"
INSTALL_DIR="$HOME/.lizard/bin"

echo ""
echo -e "${BOLD}Lizard CLI${RESET} installer"
echo ""

# Detect OS and arch
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) BINARY="lizard-darwin-arm64" ;;
      x86_64) BINARY="lizard-darwin-x64" ;;
      *) echo -e "${RED}Error:${RESET} Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)  BINARY="lizard-linux-x64" ;;
      aarch64) BINARY="lizard-linux-arm64" ;;
      arm64)   BINARY="lizard-linux-arm64" ;;
      *) echo -e "${RED}Error:${RESET} Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo -e "${RED}Error:${RESET} Unsupported OS: $OS"
    echo -e "  On Windows, install from npm: ${CYAN}npm i -g @lizard-build/cli${RESET}"
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp)"

echo -e "${DIM}Downloading $BINARY...${RESET}"

# `set -e` aborts on a failed curl before any `$?` check could run, so handle
# the failure inline to keep the message useful.
if ! curl -fL --progress-bar "$RELEASE_BASE/$BINARY" -o "$TMP"; then
  rm -f "$TMP"
  echo -e "${RED}Error:${RESET} Download failed: $RELEASE_BASE/$BINARY"
  exit 1
fi

chmod +x "$TMP"
mv "$TMP" "$INSTALL_DIR/lizard"

# Add to PATH in shell config if not already there
SHELL_RC=""
case "$SHELL" in
  */zsh)  SHELL_RC="$HOME/.zshrc" ;;
  */bash) SHELL_RC="$HOME/.bashrc" ;;
esac
if [ -n "$SHELL_RC" ] && ! grep -q "\.lizard/bin" "$SHELL_RC" 2>/dev/null; then
  echo 'export PATH="$HOME/.lizard/bin:$PATH"' >> "$SHELL_RC"
fi
export PATH="$INSTALL_DIR:$PATH"

# `lizard version` is not a command — the flag is the only way to read it.
VERSION="$("$INSTALL_DIR/lizard" --version 2>/dev/null | head -1 || echo "?")"

echo ""
echo -e "${GREEN}✓${RESET} Lizard CLI ${BOLD}v${VERSION}${RESET} installed"
echo ""
echo -e "  Run ${CYAN}lizard login${RESET} to get started"
echo -e "  ${DIM}(if 'lizard' is not found, run: export PATH="\$HOME/.lizard/bin:\$PATH")${RESET}"
echo ""
