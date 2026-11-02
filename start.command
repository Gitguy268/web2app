#!/bin/bash
# Double-click to start web2app and open it in the browser. Close this window to stop it.
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT=7417
URL="http://localhost:$PORT"

if ! command -v node >/dev/null; then
  echo "Node.js is needed. Install it from https://nodejs.org and double-click this file again."
  read -r -p "Press Return to close."; exit 1
fi
[ -d node_modules/pake-cli ] || npm install || { read -r -p "npm install failed. Press Return to close."; exit 1; }
sh scripts/link-tauri.sh # lets builds skip a network install, so they work offline

if curl -s -o /dev/null "$URL/api/info"; then
  echo "web2app is already running."
  open -a "Brave Browser" "$URL" 2>/dev/null || open "$URL"
  exit 0
fi

(sleep 1 && { open -a "Brave Browser" "$URL" 2>/dev/null || open "$URL"; }) &
exec node server.js
