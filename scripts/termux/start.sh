#!/data/data/com.termux/files/usr/bin/bash
# The one-tap shortcut: start the server if it isn't already running, then open the app.
# Pass --no-open to only start it (used at boot).
set -u
CONF_DIR="$HOME/.cjw"
. "$CONF_DIR/env"
URL="http://localhost:${PORT:-8787}"
LOG="$CONF_DIR/server.log"

healthy() { curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1; }

# Without a wake lock, Android freezes Termux (and the server with it) soon after you switch to
# the browser.
termux-wake-lock

if ! healthy; then
  [ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
  cd "$HOME/CodeJustWrite/apps/server"
  setsid nohup node --max-old-space-size=1024 dist/index.js >"$LOG" 2>&1 </dev/null &
  echo $! >"$CONF_DIR/server.pid"
  for _ in $(seq 1 60); do
    healthy && break
    sleep 0.5
  done
fi

if [ "${1:-}" != "--no-open" ]; then
  # The token rides in the URL fragment (never sent over the network); the app saves it and
  # strips it from the address bar, so there's no sign-in screen.
  termux-open-url "$URL/#token=$CJW_AUTH_TOKEN"
fi
