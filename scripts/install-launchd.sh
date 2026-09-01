#!/bin/bash
# install-launchd.sh — (re)install the weekly upload-prices launchd agent.
#
#   bash scripts/install-launchd.sh          install / reload
#   bash scripts/install-launchd.sh --remove uninstall
#
# Schedule: Mondays at 06:00 (edit the .plist's StartCalendarInterval to change).

set -euo pipefail

LABEL="co.za.bestbefore.upload-prices"
BACKEND_DIR="$HOME/best-before-backend"
SRC="$BACKEND_DIR/scripts/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$DEST"
  echo "Removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$BACKEND_DIR/logs"
chmod +x "$BACKEND_DIR/scripts/run-upload-prices.sh"
cp "$SRC" "$DEST"

# Replace any previously loaded copy, then load the fresh one.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl enable "$DOMAIN/$LABEL"

echo "Installed $LABEL — runs Mondays 06:00"
echo "  status:   launchctl print $DOMAIN/$LABEL | grep -E 'state|program'"
echo "  run now:  launchctl kickstart -k $DOMAIN/$LABEL"
echo "  logs:     tail -f $BACKEND_DIR/logs/upload-prices.log"
