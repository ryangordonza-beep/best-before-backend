#!/usr/bin/env node
// upload-prices.js
//
// Collects the latest competitor-price CSV from each scraper's output
// folder, normalises them into the `barcode,retailer,price` shape the
// API expects, and POSTs the merged file to
// /admin/competitor-prices/upload using ADMIN_API_KEY.
//
// The scrapers each emit their own layout (Woolworths has a `barcode`
// column, PnP/Checkers don't, Spar's leaflet OCR has `price_ocr_raw`,
// Spar's fuzzy matcher adds `barcode`). This script detects the columns,
// maps retailer names to the four the API accepts, drops rows with no
// barcode (the API keys on barcode) and reports how many it skipped.
//
// Config (via .env or environment):
//   ADMIN_API_KEY          required — the x-admin-key the API checks
//   PRICE_UPLOAD_API_URL   API base URL (default https://best-before-backend.onrender.com)
//   SCRAPERS_DIR           scrapers root (default ~/Desktop/Scrapers)
//
// Usage:
//   node upload-prices.js              upload to the API
//   node upload-prices.js --dry-run    print the merged CSV + summary, don't POST
//   node upload-prices.js --dir /path  override SCRAPERS_DIR for this run

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse } = require('csv-parse/sync');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dirFlagIdx = args.indexOf('--dir');

const API_URL = (process.env.PRICE_UPLOAD_API_URL || process.env.API_URL || 'https://best-before-backend.onrender.com').replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const SCRAPERS_DIR = dirFlagIdx !== -1 && args[dirFlagIdx + 1]
  ? path.resolve(args[dirFlagIdx + 1])
  : process.env.SCRAPERS_DIR || path.join(os.homedir(), 'Desktop', 'Scrapers');

const VALID_RETAILERS = ['Pick n Pay', 'Checkers', 'Woolworths', 'Spar'];

// Map whatever the scrapers write into one of the four accepted names.
const RETAILER_ALIASES = {
  'pick n pay': 'Pick n Pay',
  "pick 'n pay": 'Pick n Pay',
  'picknpay': 'Pick n Pay',
  'pnp': 'Pick n Pay',
  'checkers': 'Checkers',
  'checkers sixty60': 'Checkers',
  'woolworths': 'Woolworths',
  'woolies': 'Woolworths',
  'ww': 'Woolworths',
  'spar': 'Spar',
  'superspar': 'Spar',
  'kwikspar': 'Spar',
};

const BARCODE_COLS = ['barcode', 'ean', 'ean13', 'sku', 'upc', 'gtin'];
const PRICE_COLS = ['price', 'price_incl', 'price_raw', 'price_ocr_raw'];
const RETAILER_COLS = ['retailer', 'store', 'shop'];

function firstCol(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase() === cand);
    if (hit) return hit;
  }
  return null;
}

function normaliseRetailer(raw) {
  const v = String(raw || '').trim();
  if (VALID_RETAILERS.includes(v)) return v;
  return RETAILER_ALIASES[v.toLowerCase()] || null;
}

function parsePrice(raw) {
  if (raw == null) return NaN;
  // "R64.99", "R 1 234,50", "64.99" → 64.99
  const cleaned = String(raw)
    .replace(/[Rr]/g, '')
    .replace(/\s/g, '')
    .replace(/,(\d{2})$/, '.$1') // trailing ",99" → ".99"
    .replace(/,/g, ''); // thousands separators
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Latest *.csv (by mtime) inside a directory, or null.
function latestCsv(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const csvs = entries
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return csvs[0] ? csvs[0].full : null;
}

// One CSV per scraper: the newest file in each `<SCRAPERS_DIR>/*/output/`,
// plus <SCRAPERS_DIR>/output/ and any loose CSVs directly in SCRAPERS_DIR.
function findScraperCsvs() {
  const found = [];
  const seen = new Set();
  const add = (file) => {
    if (file && !seen.has(file)) {
      seen.add(file);
      found.push(file);
    }
  };

  add(latestCsv(path.join(SCRAPERS_DIR, 'output')));
  add(latestCsv(SCRAPERS_DIR));

  let subdirs = [];
  try {
    subdirs = fs
      .readdirSync(SCRAPERS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    console.error(`Cannot read SCRAPERS_DIR: ${SCRAPERS_DIR}\n${err.message}`);
    process.exit(1);
  }

  for (const sub of subdirs) {
    add(latestCsv(path.join(SCRAPERS_DIR, sub, 'output')));
  }

  // Newest source file first, so it wins on (barcode, retailer) conflicts.
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function toCsv(rows) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return ['barcode,retailer,price', ...rows.map((r) => [r.barcode, r.retailer, r.price].map(esc).join(','))].join('\n') + '\n';
}

async function main() {
  if (!ADMIN_API_KEY && !DRY_RUN) {
    console.error('ADMIN_API_KEY is not set (put it in ~/best-before-backend/.env). Aborting.');
    process.exit(1);
  }

  const files = findScraperCsvs();
  if (files.length === 0) {
    console.error(`No CSV files found under ${SCRAPERS_DIR}`);
    process.exit(1);
  }

  console.log(`Scrapers dir: ${SCRAPERS_DIR}`);
  console.log(`Found ${files.length} source CSV(s):`);

  const merged = new Map(); // key: `${barcode}|${retailer}` → { barcode, retailer, price }
  const perRetailer = {};
  const skipped = { noBarcode: {}, badPrice: 0, unknownRetailer: {} };

  for (const file of files) {
    let records;
    try {
      records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      console.log(`  ✗ ${path.relative(SCRAPERS_DIR, file)} — parse error: ${err.message}`);
      continue;
    }
    if (records.length === 0) {
      console.log(`  · ${path.relative(SCRAPERS_DIR, file)} — empty`);
      continue;
    }

    const bCol = firstCol(records[0], BARCODE_COLS);
    const rCol = firstCol(records[0], RETAILER_COLS);
    const pCol = firstCol(records[0], PRICE_COLS);
    let used = 0;

    for (const row of records) {
      const retailer = normaliseRetailer(rCol ? row[rCol] : '');
      if (!retailer) {
        const key = String((rCol && row[rCol]) || 'unknown').trim() || 'unknown';
        skipped.unknownRetailer[key] = (skipped.unknownRetailer[key] || 0) + 1;
        continue;
      }
      const barcode = bCol ? String(row[bCol] || '').trim() : '';
      if (!barcode) {
        skipped.noBarcode[retailer] = (skipped.noBarcode[retailer] || 0) + 1;
        continue;
      }
      const price = parsePrice(pCol ? row[pCol] : undefined);
      if (Number.isNaN(price) || price <= 0) {
        skipped.badPrice += 1;
        continue;
      }

      const key = `${barcode}|${retailer}`;
      if (!merged.has(key)) {
        // files are newest-first, so the first row we see for a key is the freshest
        merged.set(key, { barcode, retailer, price: price.toFixed(2) });
        perRetailer[retailer] = (perRetailer[retailer] || 0) + 1;
        used += 1;
      }
    }

    console.log(
      `  ✓ ${path.relative(SCRAPERS_DIR, file)} — ${records.length} rows` +
        (bCol ? '' : ' (no barcode column)') +
        ` → ${used} used`
    );
  }

  const rows = [...merged.values()];

  console.log('\nMerged rows by retailer:');
  for (const r of VALID_RETAILERS) console.log(`  ${r.padEnd(12)} ${perRetailer[r] || 0}`);

  const noBarcodeTotal = Object.values(skipped.noBarcode).reduce((a, b) => a + b, 0);
  if (noBarcodeTotal) {
    console.log('\nSkipped — no barcode:');
    for (const [r, n] of Object.entries(skipped.noBarcode)) console.log(`  ${r.padEnd(12)} ${n}`);
  }
  if (skipped.badPrice) console.log(`Skipped — unparseable price: ${skipped.badPrice}`);
  const unknownRetailers = Object.entries(skipped.unknownRetailer);
  if (unknownRetailers.length) {
    console.log('Skipped — unrecognised retailer:');
    for (const [r, n] of unknownRetailers) console.log(`  ${r}: ${n}`);
  }

  if (rows.length === 0) {
    console.error('\nNothing to upload (0 valid rows).');
    process.exit(1);
  }

  const csv = toCsv(rows);

  if (DRY_RUN) {
    console.log(`\n--dry-run: not uploading. Merged CSV (${rows.length} rows):\n`);
    console.log(csv);
    return;
  }

  console.log(`\nPOST ${API_URL}/admin/competitor-prices/upload  (${rows.length} rows)`);

  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'competitor-prices.csv');

  const res = await fetch(`${API_URL}/admin/competitor-prices/upload`, {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_API_KEY },
    body: fd,
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    console.error(`\nUpload failed (HTTP ${res.status}):`);
    console.error(body);
    process.exit(1);
  }

  console.log('\nUpload OK:');
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
