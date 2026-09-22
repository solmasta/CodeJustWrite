#!/data/data/com.termux/files/usr/bin/bash
# One-time setup (safe to re-run — it updates in place) for running CodeJustWrite entirely on an
# Android phone inside Termux. Run it with:
#
#   curl -fsSL https://raw.githubusercontent.com/solmasta/CodeJustWrite/main/scripts/termux/install.sh | bash
#
# It installs Node/git/python, downloads and builds the app, asks for your API keys once, and puts
# a "CodeJustWrite" shortcut in Termux:Widget that starts the server and opens the app in one tap.
set -euo pipefail

# Everything is inside main() so bash reads the whole file before running any of it — "CJW Update"
# runs this very file while the git step below replaces it on disk.
main() {
BRANCH="${CJW_BRANCH:-main}"
REPO_URL="https://github.com/solmasta/CodeJustWrite.git"
APP_DIR="$HOME/CodeJustWrite"
CONF_DIR="$HOME/.cjw"
ENV_FILE="$CONF_DIR/env"

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ]; then
  echo "This script is meant to run inside the Termux app on Android." >&2
  exit 1
fi

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$1"; }

# `curl ... | bash` makes the script itself stdin, so questions have to read from the terminal.
ask() {
  local prompt="$1" var
  read -r -p "$prompt" var </dev/tty || true
  printf '%s' "$var"
}

step "Installing packages (Node.js, git, Python)"
pkg update -y -o Dpkg::Options::=--force-confnew
pkg install -y -o Dpkg::Options::=--force-confnew nodejs-lts git python curl

step "Downloading CodeJustWrite ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  # This copy only ever runs the app — any local edits in it are discarded on update.
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

step "Building (a few minutes the first time)"
cd "$APP_DIR"
# Headless Chrome isn't available on Android, so don't let Playwright try to download it.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund
npm run build:core
npm run build:server
npm run build:web

step "Settings"
mkdir -p "$CONF_DIR" "$CONF_DIR/workspaces"
chmod 700 "$CONF_DIR"
# Keep whatever an earlier run already saved; only ask for what's missing.
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
if [ -z "${OPENROUTER_KEY:-}" ] && [ -z "${DEEPINFRA_KEY:-}" ]; then
  echo "An AI provider key is required. OpenRouter has free models: https://openrouter.ai/keys"
  OPENROUTER_KEY="$(ask 'OpenRouter API key: ')"
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "A GitHub token lets the AI push branches and open/merge PRs (Enter to skip for now)."
  GITHUB_TOKEN="$(ask 'GitHub token: ')"
fi
if [ -z "${CJW_AUTH_TOKEN:-}" ]; then
  CJW_AUTH_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
fi

umask 077
cat >"$ENV_FILE" <<ENV
# CodeJustWrite settings — edit and then tap "CJW Restart" to apply.
export OPENROUTER_KEY='${OPENROUTER_KEY:-}'
export DEEPINFRA_KEY='${DEEPINFRA_KEY:-}'
export GITHUB_TOKEN='${GITHUB_TOKEN:-}'
export CJW_AUTH_TOKEN='${CJW_AUTH_TOKEN}'
export CJW_DEFAULT_PROVIDER='${CJW_DEFAULT_PROVIDER:-openrouter}'
export CJW_DEFAULT_MODEL='${CJW_DEFAULT_MODEL:-cohere/north-mini-code:free}'
export CJW_HOST='127.0.0.1'
export PORT='${PORT:-8787}'
export CJW_WORKSPACES_DIR='$CONF_DIR/workspaces'
ENV

step "Creating home-screen shortcuts"
S="$APP_DIR/scripts/termux"
chmod 700 "$S"/*.sh
mkdir -p "$HOME/.shortcuts/tasks"
chmod 700 "$HOME/.shortcuts" "$HOME/.shortcuts/tasks"
# Small wrapper files rather than symlinks — Termux:Widget is happiest with plain scripts.
shortcut() {
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec "%s" "$@"\n' "$2" >"$1"
  chmod 700 "$1"
}
# tasks/ = runs silently in the background, no terminal window.
shortcut "$HOME/.shortcuts/tasks/CodeJustWrite" "$S/start.sh"
shortcut "$HOME/.shortcuts/tasks/CJW Stop" "$S/stop.sh"
shortcut "$HOME/.shortcuts/tasks/CJW Restart" "$S/restart.sh"
# These show a terminal so you can watch them.
shortcut "$HOME/.shortcuts/CJW Update" "$S/install.sh"
shortcut "$HOME/.shortcuts/CJW Logs" "$S/logs.sh"
# Starts the server when the phone boots, if the Termux:Boot add-on is installed.
mkdir -p "$HOME/.termux/boot"
shortcut "$HOME/.termux/boot/codejustwrite" "$S/boot.sh"

step "Starting"
"$S/restart.sh"

cat <<DONE

All set. From now on, just tap the "CodeJustWrite" shortcut on your home screen
(Termux:Widget) — it starts the server if needed and opens the app.

Other shortcuts: "CJW Stop", "CJW Restart", "CJW Update" (get the latest version), "CJW Logs".
DONE
}

main "$@"
