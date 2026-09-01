#!/bin/bash
# install-launchd.sh — (re)install the weekly price-pipeline launchd agent.
#
#   bash scripts/install-launchd.sh          install / reload
#   bash scripts/install-launchd.sh --remove uninstall
#
# Installs  co.za.bestbefore.weekly-scrape  (Woolworths scrape -> PnP scrape
# -> match-prices -> upload-prices), Mondays at 07:00 local = 04:00 UTC =
# 06:00 South Africa time. Edit the .plist's StartCalendarInterval /
# Hour to change it.
#
# Also removes the older co.za.bestbefore.upload-prices agent, which the
# weekly-scrape pipeline supersedes (run-upload-prices.sh stays for manual
# match+upload runs).

set -euo pipefail

LABEL="co.za.bestbefore.weekly-scrape"
OLD_LABEL="co.za.bestbefore.upload-prices"
BACKEND_DIR="$HOME/best-before-backend"
SRC="$BACKEND_DIR/scripts/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Always retire the superseded agent.
launchctl bootout "$DOMAIN/$OLD_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$DEST"
  echo "Removed $LABEL (and $OLD_LABEL)"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$BACKEND_DIR/logs"
chmod +x "$BACKEND_DIR"/scripts/run-weekly-scrape.sh "$BACKEND_DIR"/scripts/run-upload-prices.sh
cp "$SRC" "$DEST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl enable "$DOMAIN/$LABEL"

echo "Installed $LABEL — runs Mondays 07:00 local (04:00 UTC / 06:00 SAST)"
echo "  status:   launchctl print $DOMAIN/$LABEL | grep -E 'state|Weekday|Hour'"
echo "  run now:  launchctl kickstart -k $DOMAIN/$LABEL"
echo "  logs:     tail -f $BACKEND_DIR/logs/weekly-scrape.log"
