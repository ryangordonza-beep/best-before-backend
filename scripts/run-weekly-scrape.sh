#!/bin/bash
# run-weekly-scrape.sh
#
# Full Monday price pipeline, invoked by the launchd agent
# co.za.bestbefore.weekly-scrape. Everything is appended, with timestamps,
# to logs/weekly-scrape.log.
#
#   1. Woolworths scraper   ~/Desktop/Scrapers/Woolworths/scrape.js
#   2. PnP scraper          ~/Desktop/Scrapers/PnP Scraper Tool/scrape.js
#      -- gated to PnP's 04:00-08:45 UTC visit window: if this starts
#         before 04:00 UTC it waits; if it's past 08:45 UTC, PnP is skipped
#   3. match-prices.js  +  4. upload-prices.js   (via run-upload-prices.sh)
#
# Steps 1-3 are best-effort — a failure in any one is logged and the
# pipeline continues, so a broken scraper never blocks the upload of the
# retailers that did work.
#
# Manual use:
#   bash scripts/run-weekly-scrape.sh
#   WEEKLY_SCRAPE_DRY_RUN=1 bash scripts/run-weekly-scrape.sh   # skip scrapers, no POST

BACKEND_DIR="$HOME/best-before-backend"
LOG_DIR="$BACKEND_DIR/logs"
LOG_FILE="$LOG_DIR/weekly-scrape.log"
SCRAPERS_DIR="$HOME/Desktop/Scrapers"
WOOLIES_DIR="$SCRAPERS_DIR/Woolworths"
PNP_DIR="$SCRAPERS_DIR/PnP Scraper Tool"
DRY="${WEEKLY_SCRAPE_DRY_RUN:-}"

mkdir -p "$LOG_DIR"

log() { echo "$@" >>"$LOG_FILE"; }
rule() { log "--------------------------------------------------------------------"; }

# --- node on PATH (launchd doesn't load the shell profile) ---
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
if ! command -v node >/dev/null 2>&1; then
  NEWEST_NODE_BIN="$(/bin/ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$NEWEST_NODE_BIN" ] && export PATH="$NEWEST_NODE_BIN:$PATH"
fi

{
  echo "===================================================================="
  echo "weekly price pipeline  $(date '+%Y-%m-%d %H:%M:%S %z')  ($(date -u '+%H:%M UTC'))"
  echo "node: $(command -v node || echo 'NOT FOUND')  $(node -v 2>/dev/null)"
  [ -n "$DRY" ] && echo "MODE: dry-run (scrapers skipped, no POST)"
} >>"$LOG_FILE"

if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node not found on PATH — aborting"
  log ""
  exit 127
fi

# --- 1. Woolworths ---------------------------------------------------
rule
log "[1/4] Woolworths scraper"
wool_code=0
if [ -n "$DRY" ]; then
  log "  (dry-run) would run: node scrape.js  in $WOOLIES_DIR"
elif [ -d "$WOOLIES_DIR" ]; then
  ( cd "$WOOLIES_DIR" && node scrape.js ) >>"$LOG_FILE" 2>&1
  wool_code=$?
  log "  Woolworths scraper exit $wool_code"
else
  log "  SKIP: $WOOLIES_DIR not found"
  wool_code=1
fi

# --- 2. PnP (04:00-08:45 UTC window) --------------------------------
rule
log "[2/4] PnP scraper"
pnp_code=0
pnp_status="ran"
now_min=$(( 10#$(date -u +%H) * 60 + 10#$(date -u +%M) ))
win_start=$(( 4 * 60 ))
win_end=$(( 8 * 60 + 45 ))

if [ -n "$DRY" ]; then
  log "  (dry-run) would run: node scrape.js  in $PNP_DIR  (UTC window permitting)"
  pnp_status="dry-run"
else
  if [ "$now_min" -lt "$win_start" ]; then
    wait_s=$(( (win_start - now_min) * 60 ))
    log "  PnP window opens 04:00 UTC — waiting ${wait_s}s ($(date -u '+%H:%M') UTC now)"
    sleep "$wait_s"
    now_min=$win_start
  fi
  if [ "$now_min" -gt "$win_end" ]; then
    log "  SKIP: past 08:45 UTC ($(date -u '+%H:%M') UTC) — PnP not scraped this week"
    pnp_status="skipped (outside window)"
    pnp_code=0
  elif [ -d "$PNP_DIR" ]; then
    ( cd "$PNP_DIR" && node scrape.js ) >>"$LOG_FILE" 2>&1
    pnp_code=$?
    log "  PnP scraper exit $pnp_code"
  else
    log "  SKIP: $PNP_DIR not found"
    pnp_status="skipped (missing)"
    pnp_code=1
  fi
fi

# --- 3 + 4. match-prices then upload-prices -------------------------
rule
log "[3/4 + 4/4] match-prices -> upload-prices"
sync_env=()
[ -n "$DRY" ] && sync_env=(UPLOAD_PRICES_DRY_RUN=1)
PRICE_SYNC_LOG="$LOG_FILE" env "${sync_env[@]}" bash "$BACKEND_DIR/scripts/run-upload-prices.sh"
sync_code=$?

# --- summary -------------------------------------------------------
rule
log "summary:  woolworths=$wool_code  pnp=$pnp_code ($pnp_status)  price-sync=$sync_code"
log ""
exit "$sync_code"
