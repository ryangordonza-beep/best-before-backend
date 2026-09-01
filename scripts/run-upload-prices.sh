#!/bin/bash
# run-upload-prices.sh
#
# Wrapper invoked by the launchd agent (co.za.bestbefore.upload-prices).
# launchd runs with a bare environment and no shell profile, so this
# script has to put node on PATH itself before calling `npm run
# upload-prices`. All output is appended, with a timestamped header, to
# logs/upload-prices.log.
#
# Manual use:
#   bash scripts/run-upload-prices.sh                # real upload
#   UPLOAD_PRICES_DRY_RUN=1 bash scripts/run-upload-prices.sh   # no POST

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
if ! command -v node >/dev/null 2>&1; then
  # nvm didn't resolve a default — fall back to the newest installed version
  NEWEST_NODE_BIN="$(/bin/ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$NEWEST_NODE_BIN" ] && export PATH="$NEWEST_NODE_BIN:$PATH"
fi
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

ARGS=""
[ "${UPLOAD_PRICES_DRY_RUN:-}" = "1" ] && ARGS="-- --dry-run"

cd "$BACKEND_DIR" || { echo "cannot cd to $BACKEND_DIR" >>"$LOG_FILE"; exit 1; }

{
  echo "===================================================================="
  echo "upload-prices  $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "node: $(command -v node || echo 'NOT FOUND')  $(node -v 2>/dev/null)"
  echo "--------------------------------------------------------------------"

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found on PATH — cannot run upload-prices"
    echo
    exit 127
  fi

  # shellcheck disable=SC2086
  npm run --silent upload-prices $ARGS
  code=$?

  echo "--------------------------------------------------------------------"
  if [ "$code" -eq 0 ]; then
    echo "result: OK"
  else
    echo "result: FAILED (exit $code)"
  fi
  echo
  exit "$code"
} >>"$LOG_FILE" 2>&1
