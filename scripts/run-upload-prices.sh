#!/bin/bash
# run-upload-prices.sh
#
# Weekly price sync — invoked by the launchd agent
# (co.za.bestbefore.upload-prices). launchd runs with a bare environment
# and no shell profile, so this script puts node on PATH itself, then:
#
#   1. match-prices.js  — fuzzy-matches the latest PnP scrape against the
#                         catalogue and writes pnp-matched-<TS>.csv
#   2. upload-prices.js — merges the newest CSV from every scraper's
#                         output/ folder and POSTs it to the API
#
# Step 1 is best-effort: if it fails (e.g. DB unreachable) the upload
# still runs with the other retailers' data. All output is appended, with
# a timestamped header, to logs/upload-prices.log.
#
# Manual use:
#   bash scripts/run-upload-prices.sh                            # real run
#   UPLOAD_PRICES_DRY_RUN=1 bash scripts/run-upload-prices.sh    # no writes / no POST

BACKEND_DIR="$HOME/best-before-backend"
LOG_DIR="$BACKEND_DIR/logs"
LOG_FILE="$LOG_DIR/upload-prices.log"

mkdir -p "$LOG_DIR"

# --- put node/npm on PATH (launchd doesn't load the shell profile) ---
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
# common install locations as a fallback, after anything nvm put on PATH
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
if ! command -v node >/dev/null 2>&1; then
  # last resort — newest nvm-installed version
  NEWEST_NODE_BIN="$(/bin/ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$NEWEST_NODE_BIN" ] && export PATH="$NEWEST_NODE_BIN:$PATH"
fi

DRY_ARGS=""
[ "${UPLOAD_PRICES_DRY_RUN:-}" = "1" ] && DRY_ARGS="-- --dry-run"

cd "$BACKEND_DIR" || { echo "cannot cd to $BACKEND_DIR" >>"$LOG_FILE"; exit 1; }

{
  echo "===================================================================="
  echo "weekly price sync  $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "node: $(command -v node || echo 'NOT FOUND')  $(node -v 2>/dev/null)"
  echo "--------------------------------------------------------------------"

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found on PATH — aborting"
    echo
    exit 127
  fi

  echo "[1/2] match-prices (PnP name → barcode)"
  # shellcheck disable=SC2086
  npm run --silent match-prices $DRY_ARGS
  match_code=$?
  [ "$match_code" -eq 0 ] || echo "  (match-prices exited $match_code — continuing with upload anyway)"
  echo ""

  echo "[2/2] upload-prices (merge + POST)"
  # shellcheck disable=SC2086
  npm run --silent upload-prices $DRY_ARGS
  code=$?

  echo "--------------------------------------------------------------------"
  if [ "$code" -eq 0 ]; then
    echo "result: OK (match-prices exit $match_code, upload-prices exit 0)"
  else
    echo "result: FAILED (match-prices exit $match_code, upload-prices exit $code)"
  fi
  echo
  exit "$code"
} >>"$LOG_FILE" 2>&1
