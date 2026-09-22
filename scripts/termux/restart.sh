#!/data/data/com.termux/files/usr/bin/bash
# Restarts the server (e.g. after editing ~/.cjw/env) and opens the app.
S="$(dirname "$(readlink -f "$0")")"
"$S/stop.sh"
sleep 1
exec "$S/start.sh" "$@"
