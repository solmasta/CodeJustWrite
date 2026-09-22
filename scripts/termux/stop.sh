#!/data/data/com.termux/files/usr/bin/bash
# Stops the server and lets the phone sleep normally again.
PID_FILE="$HOME/.cjw/server.pid"
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi
termux-wake-unlock
