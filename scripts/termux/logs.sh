#!/data/data/com.termux/files/usr/bin/bash
# Shows the server's output live — useful when something isn't working. Close with Ctrl+C.
tail -n 100 -f "$HOME/.cjw/server.log"
