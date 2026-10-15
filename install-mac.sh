#!/bin/bash
# Installeert FLINT als achtergronddienst op macOS (start bij inloggen, herstart na crash,
# en houdt de Mac wakker zolang de bot draait via caffeinate).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js niet gevonden. Installeer het eerst: brew install node (of https://nodejs.org)"; exit 1
fi
LABEL="com.flint.pumpbot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cd "$DIR"
npm install --omit=dev
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string><string>$DIR/bot.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/data/out.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/err.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo
echo "FLINT draait nu op de achtergrond."
echo "Dashboard:  http://127.0.0.1:3000"
echo "Logs:       tail -f $DIR/data/out.log"
echo "Stoppen:    ./uninstall-mac.sh"
