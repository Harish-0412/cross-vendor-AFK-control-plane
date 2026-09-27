#!/bin/sh
# Odysseus installer for macOS and Linux.
#
#   curl -fsSL https://cross-vendor-afk-control-plane.vercel.app/install.sh | sh
#
# Installs the Odysseus gateway (the `odysseus` command) for the current user.
# No sudo, GitHub account or access token is needed.
#
# Optional environment variables:
#   ODYSSEUS_PACKAGE_URL   install from this package instead of the latest release
#   ODYSSEUS_PREFIX        install into this folder instead of npm's global folder
#   ODYSSEUS_NO_PROMPT=1   never ask questions (for scripted installs)

set -u

WEB_URL="https://cross-vendor-afk-control-plane.vercel.app"
PACKAGE_URL="${ODYSSEUS_PACKAGE_URL:-https://github.com/Harish-0412/cross-vendor-AFK-control-plane/releases/latest/download/odysseus-gateway.tgz}"
MIN_NODE_MAJOR=20
USER_PREFIX="$HOME/.odysseus/npm"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  MAGENTA="$(printf '\033[35m')"; BLUE="$(printf '\033[34m')"; CYAN="$(printf '\033[36m')"
  GREEN="$(printf '\033[32m')"; RED="$(printf '\033[31m')"; DIM="$(printf '\033[2m')"
  BOLD="$(printf '\033[1m')"; RESET="$(printf '\033[0m')"
else
  MAGENTA=""; BLUE=""; CYAN=""; GREEN=""; RED=""; DIM=""; BOLD=""; RESET=""
fi

banner() {
  printf '\n'
  printf '%s' "$MAGENTA"
  cat <<'ART'
     ___  ____  __   __ ____  ____  _____ _   _ ____
    / _ \|  _ \ \ \ / // ___|/ ___|| ____| | | / ___|
ART
  printf '%s' "$BLUE"
  cat <<'ART'
   | | | | | | | \ V / \___ \\___ \|  _| | | | \___ \
ART
  printf '%s' "$CYAN"
  cat <<'ART'
   | |_| | |_| |  | |   ___) |___) | |___| |_| |___) |
    \___/|____/   |_|  |____/|____/|_____|\___/|____/
ART
  printf '%s\n' "$RESET"
  printf '   %sGo AFK. Your AI agents keep working.%s\n' "$BOLD" "$RESET"
  printf '   %sInstalling the Odysseus gateway%s\n\n' "$DIM" "$RESET"
}

step() { printf '  %s>%s %s\n' "$MAGENTA" "$RESET" "$1"; }
ok() { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
problem() {
  printf '\n  %sx %s%s\n' "$RED" "$1" "$RESET"
  shift
  for line in "$@"; do printf '    %s\n' "$line"; done
  printf '\n'
}

# A piped script has no stdin of its own, so questions are read from the terminal.
ask() {
  [ -n "${ODYSSEUS_NO_PROMPT:-}" ] && return 1
  [ -r /dev/tty ] || return 1
  printf '  %s?%s %s [Y/n] ' "$CYAN" "$RESET" "$1"
  read -r answer </dev/tty || return 1
  case "$answer" in "" | y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

banner

# ------------------------------------------------------------------ Node.js
step "Checking for Node.js"
major="$(node_major)"
if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
  if [ "$major" -gt 0 ]; then
    note "Node.js $major is installed, but Odysseus needs version $MIN_NODE_MAJOR or newer."
  else
    note "Node.js is not installed. Odysseus needs it to run."
  fi
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1 && ask "Install Node.js now with Homebrew?"; then
    step "Installing Node.js (this can take a minute)"
    brew install node >/dev/null && major="$(node_major)"
  fi
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    problem "Node.js $MIN_NODE_MAJOR or newer is required" \
      "Install the LTS version from https://nodejs.org (or with your package manager)," \
      "then run this installer again."
    exit 1
  fi
fi
ok "Node.js $major found"

if ! command -v npm >/dev/null 2>&1; then
  problem "npm was not found" \
    "npm normally comes with Node.js. Reinstall Node.js from https://nodejs.org," \
    "then run this installer again."
  exit 1
fi

# ------------------------------------------------------------------ package
step "Downloading and installing the Odysseus gateway"
prefix="${ODYSSEUS_PREFIX:-}"
log="$(mktemp 2>/dev/null || echo "/tmp/odysseus-install.$$")"

install_to() {
  if [ -n "$1" ]; then
    npm install --global --prefix "$1" "$PACKAGE_URL" --no-fund --no-audit --loglevel=error >"$log" 2>&1
  else
    npm install --global "$PACKAGE_URL" --no-fund --no-audit --loglevel=error >"$log" 2>&1
  fi
}

if ! install_to "$prefix"; then
  # npm's global folder is often owned by root on Linux. Rather than asking
  # for sudo, install into the user's own folder instead.
  if [ -z "$prefix" ] && grep -q 'EACCES' "$log"; then
    prefix="$USER_PREFIX"
    note "npm's global folder needs admin rights; installing into $prefix instead."
    install_to "$prefix" || true
  fi
fi

if [ -n "$prefix" ]; then bin_dir="$prefix/bin"; else bin_dir="$(npm prefix --global)/bin"; fi

if [ ! -x "$bin_dir/odysseus" ]; then
  hint="Check your internet connection and run this installer again."
  if grep -qE 'ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN' "$log"; then
    hint="Could not reach GitHub to download the package. Check your internet connection, VPN or proxy."
  fi
  problem "The gateway could not be installed" "$hint" "" "Details from npm:"
  tail -n 8 "$log" | sed 's/^/    /'
  rm -f "$log"
  exit 1
fi
rm -f "$log"
ok "Odysseus gateway $("$bin_dir/odysseus" --version) installed"

# ------------------------------------------------------------------ command
case ":$PATH:" in
  *":$bin_dir:"*) on_path=1 ;;
  *) on_path=0 ;;
esac
if [ "$on_path" -eq 0 ] && [ -n "${ODYSSEUS_PREFIX:-}" ]; then
  note "Add $bin_dir to your PATH to run odysseus from any terminal."
elif [ "$on_path" -eq 0 ]; then
  line="export PATH=\"$bin_dir:\$PATH\""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] && ! grep -qF "$bin_dir" "$rc"; then
      printf '\n# Odysseus\n%s\n' "$line" >>"$rc"
    fi
  done
  PATH="$bin_dir:$PATH"
  export PATH
  ok "Added the odysseus command to your PATH"
  note "Open a new terminal for it to take effect everywhere."
fi

# ------------------------------------------------------------------ next
printf '\n  %sOdysseus is installed.%s\n\n' "$GREEN$BOLD" "$RESET"
printf '  %sNext steps%s\n' "$BOLD" "$RESET"
printf '    1. Sign in at %s%s%s\n' "$CYAN" "$WEB_URL" "$RESET"
printf '    2. Pair this computer:  %sodysseus pair%s\n' "$MAGENTA" "$RESET"
printf '    3. In your project:     %sodysseus gateway%s\n\n' "$MAGENTA" "$RESET"

if ask "Pair this computer with your Odysseus account now?"; then
  printf '\n'
  "$bin_dir/odysseus" pair </dev/tty
  printf '\n  Now open a terminal in your project folder and run %sodysseus gateway%s\n\n' "$MAGENTA" "$RESET"
fi
