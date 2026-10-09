#!/bin/bash
# Served at https://lizard.build/install.sh. Every release attaches this file,
# install.ps1 and install.cmd, and the platform serves them from the latest
# release, so this repo holds the only copy.
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

# Coding agents and terminals that are already open keep the PATH they started
# with, so they see ~/.lizard/bin only in new shells. Link lizard into a
# directory that is already on PATH and writable without sudo, so it works
# right away. Skip a directory that holds some other lizard, such as npm's.
LINK=""
for dir in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) continue ;; esac
  [ -d "$dir" ] && [ -w "$dir" ] || continue
  if [ -e "$dir/lizard" ] || [ -L "$dir/lizard" ]; then
    [ "$(readlink "$dir/lizard")" = "$INSTALL_DIR/lizard" ] || continue
  fi
  if ln -sf "$INSTALL_DIR/lizard" "$dir/lizard" 2>/dev/null; then
    LINK="$dir/lizard"
    break
  fi
done

# The lizard that the caller's shell will actually run.
FOUND="$(command -v lizard 2>/dev/null || true)"
export PATH="$INSTALL_DIR:$PATH"

# `lizard version` is not a command — the flag is the only way to read it.
VERSION="$("$INSTALL_DIR/lizard" --version 2>/dev/null | head -1 || echo "?")"

echo ""
echo -e "${GREEN}✓${RESET} Lizard CLI ${BOLD}v${VERSION}${RESET} installed"
if [ -n "$FOUND" ] && [ "$FOUND" != "$LINK" ] && [ "$FOUND" != "$INSTALL_DIR/lizard" ]; then
  echo -e "  ${RED}Note:${RESET} another lizard comes first on your PATH: $FOUND"
  echo -e "  ${DIM}If it is the npm package, remove it: npm uninstall -g @lizard-build/cli${RESET}"
elif [ -z "$LINK" ]; then
  echo -e "  ${DIM}(if 'lizard' is not found, open a new terminal or run: export PATH=\"\$HOME/.lizard/bin:\$PATH\")${RESET}"
fi
echo ""

# Set the machine up right away: sign in, then whatever the account still
# needs. A person at a terminal gets questions and a browser. A coding agent,
# whose shell captures the output, gets JSON lines that say what to do next,
# and the installer returns at once. LIZARD_NO_ONBOARD=1 skips this, as does CI.
#
# `curl | bash` feeds this script on stdin, so the questions need the terminal
# opened by its own name (/dev/ttys003, /dev/pts/1). /dev/tty does not do: on
# macOS a binary built with Bun shows the prompt but never gets a key press.
# `tty` names the terminal on stdin, so lend it stdout, which $(...) captures.
exec 3>&1
TERMINAL="$(tty <&3 2>/dev/null || true)"
exec 3>&-
if [ -n "$LIZARD_NO_ONBOARD" ] || [ -n "$CI" ]; then
  echo -e "  Run ${CYAN}lizard onboard${RESET} to sign in and get started"
  echo ""
elif [ -t 1 ] && [ -c "$TERMINAL" ] && [ -r "$TERMINAL" ]; then
  "$INSTALL_DIR/lizard" onboard < "$TERMINAL" || true
else
  "$INSTALL_DIR/lizard" onboard --json || true
fi
