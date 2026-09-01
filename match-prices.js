#!/usr/bin/env node
// match-prices.js
//
// The PnP scraper only captures a product NAME and price — no barcode —
// so its CSV can't be uploaded to /admin/competitor-prices/upload as-is
// (that endpoint keys on barcode). This script bridges the gap: it fuzzy-
// matches each PnP product name against the Best Before catalogue in
// Postgres and emits a barcode-keyed CSV that upload-prices.js can pick up.
//
//   in : ~/Desktop/Scrapers/PnP Scraper Tool/output/pnp-prices-*.csv
//        products table (barcode, name, bb_price)
//   out: ~/Desktop/Scrapers/PnP Scraper Tool/output/pnp-matched-<TS>.csv
//        columns: barcode, retailer, price, match_score, bb_product_name, pnp_product_name
//
// Config (.env or environment):
//   DATABASE_URL      Postgres connection string (required unless --catalogue)
//   MATCH_THRESHOLD   minimum score to accept a match (default 0.52)
//   PNP_OUTPUT_DIR    override the PnP scraper output folder
//
// Usage:
//   node match-prices.js
//   node match-prices.js --catalogue path/to/catalogue.csv   # offline, no DB
//   node match-prices.js --dry-run                           # don't write the CSV

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse } = require('csv-parse/sync');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const catFlag = args.indexOf('--catalogue');
const CATALOGUE_CSV = catFlag !== -1 ? args[catFlag + 1] : process.env.MATCH_CATALOGUE_CSV || null;

const RETAILER = 'Pick n Pay';
const THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD || '0.55');
const PNP_OUTPUT_DIR =
  process.env.PNP_OUTPUT_DIR ||
  path.join(os.homedir(), 'Desktop', 'Scrapers', 'PnP Scraper Tool', 'output');

// ---------------------------------------------------------------------
// Name normalisation + fuzzy scoring (dependency-free)
// ---------------------------------------------------------------------

const UNIT_ALIASES = {
  grams: 'g', gram: 'g', gr: 'g', g: 'g',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg',
  mg: 'mg',
  ml: 'ml', milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml',
  cl: 'cl',
  l: 'l', lt: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
};

// Words that add no discriminating signal for product identity. Flavour /
// variant words (original, multigrain, mint…) are deliberately NOT here.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'with', 'for', 'in', 'to', 'ea', 'each',
  'pmp', 'pm', 'per', 'plus', 'net',
]);

const MASS = { mg: 0.001, g: 1, kg: 1000 };
const VOL = { ml: 1, cl: 10, l: 1000 };

function normalise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[®™]/g, ' ')
    .replace(/[^\w\s.]/g, ' ') // keep decimal points
    .replace(/\s+/g, ' ')
    .trim();
}

// "10 x 22 g", "2x1kg", "1.5l", "400 g", "500ml" -> { dim, value } in g or ml
function extractSize(normalisedName) {
  const multi = normalisedName.match(
    /(\d+(?:\.\d+)?)\s*(?:x|\*)\s*(\d+(?:\.\d+)?)\s*(kg|kgs|g|gr|gram|grams|mg|ml|cl|l|lt|ltr|litre|liter|litres|liters|millilitre|milliliter|millilitres|milliliters)\b/
  );
  const single = normalisedName.match(
    /(\d+(?:\.\d+)?)\s*(kg|kgs|g|gr|gram|grams|mg|ml|cl|l|lt|ltr|litre|liter|litres|liters|millilitre|milliliter|millilitres|milliliters)\b/
  );

  let count = 1;
  let qty;
  let unit;
  if (multi) {
    count = parseFloat(multi[1]);
    qty = parseFloat(multi[2]);
    unit = UNIT_ALIASES[multi[3]] || multi[3];
  } else if (single) {
    qty = parseFloat(single[1]);
    unit = UNIT_ALIASES[single[2]] || single[2];
  } else {
    return null;
  }

  if (MASS[unit] != null) return { dim: 'mass', value: count * qty * MASS[unit] };
  if (VOL[unit] != null) return { dim: 'vol', value: count * qty * VOL[unit] };
  return null;
}

function tokenise(normalisedName) {
  return normalisedName
    .split(' ')
    // drop pure pack-size tokens and bare numbers/units
    .filter((tok) => tok && !/^\d/.test(tok) && !UNIT_ALIASES[tok])
    .filter((tok) => !STOPWORDS.has(tok))
    .filter((tok) => tok.length > 1 || /[a-z]/.test(tok));
}

function bigrams(str) {
  const s = str.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let hits = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      hits += 1;
      counts.set(g, c - 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}

function jaccard(tokensA, tokensB) {
  const A = new Set(tokensA);
  const B = new Set(tokensB);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / new Set([...A, ...B]).size;
}

function sizeAgreement(sizeA, sizeB) {
  if (!sizeA || !sizeB) return { factor: 0.9, conflict: false }; // one side unknown
  if (sizeA.dim !== sizeB.dim) return { factor: 0.3, conflict: true };
  const ratio = Math.min(sizeA.value, sizeB.value) / Math.max(sizeA.value, sizeB.value);
  if (ratio >= 0.98) return { factor: 1.15, conflict: false }; // same size
  if (ratio >= 0.9) return { factor: 1.0, conflict: false }; // rounding / labelling slack
  return { factor: 0.3, conflict: true }; // genuinely different pack size => different SKU
}

// 0..1 similarity between a competitor name and a catalogue name.
function scoreMatch(pnpName, bbName) {
  const nP = normalise(pnpName);
  const nB = normalise(bbName);
  const tP = tokenise(nP);
  const tB = tokenise(nB);
  if (!tP.length || !tB.length) return 0;

  const textDice = diceCoefficient(tP.join(' '), tB.join(' '));
  const textJac = jaccard(tP, tB);
  let base = 0.45 * textDice + 0.55 * textJac;

  const size = sizeAgreement(extractSize(nP), extractSize(nB));
  base *= size.factor;

  // brand / lead-word: the catalogue name usually leads with the brand.
  if (tP[0] && tP[0] === tB[0]) {
    base += 0.08; // same lead word
  } else if (!tP.includes(tB[0])) {
    base -= 0.1; // catalogue brand absent from the competitor name entirely
  }
  // every catalogue token present in the competitor name (competitor names
  // are usually longer, not shorter) — strong signal it's the same product
  if (tB.every((t) => tP.includes(t))) base += 0.06;

  return Math.max(0, Math.min(1, base));
}

// ---------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------

function latestCsvMatching(dir, pattern) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(`Cannot read PnP output dir: ${dir} (${err.message})`);
  }
  const candidates = files
    .filter((f) => pattern.test(f))
    .map((f) => ({ full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? candidates[0].full : null;
}

function parsePrice(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[Rr]/g, '').replace(/\s/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

async function loadCatalogue() {
  if (CATALOGUE_CSV) {
    const rows = parse(fs.readFileSync(CATALOGUE_CSV, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
    return rows
      .map((r) => ({ barcode: String(r.barcode || '').trim(), name: r.name || r.bb_product_name || '', bb_price: parseFloat(r.bb_price) }))
      .filter((r) => r.barcode && r.name);
  }

  const { Pool } = require('pg');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (add it to ~/best-before-backend/.env) — or pass --catalogue <csv>');
  }
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  const pool = new Pool({ connectionString, ssl: local ? false : { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query('SELECT barcode, name, bb_price FROM products');
    return rows.filter((r) => r.barcode && r.name);
  } finally {
    await pool.end();
  }
}

function csvEscape(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const pnpCsv = latestCsvMatching(PNP_OUTPUT_DIR, /^pnp-prices-.*\.csv$/i);
  if (!pnpCsv) {
    console.error(`No pnp-prices-*.csv found in ${PNP_OUTPUT_DIR}`);
    process.exit(1);
  }

  const pnpRows = parse(fs.readFileSync(pnpCsv, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
  const catalogue = await loadCatalogue();

  console.log(`PnP CSV      : ${path.basename(pnpCsv)} (${pnpRows.length} rows)`);
  console.log(`Catalogue    : ${catalogue.length} Best Before products`);
  console.log(`Threshold    : ${THRESHOLD}`);
  console.log('');

  // best catalogue match per PnP row
  const best = new Map(); // barcode -> { score, price, bbName, pnpName }
  const unmatched = [];

  for (const row of pnpRows) {
    const pnpName = row.product_name || row.name || '';
    const price = parsePrice(row.price ?? row.price_raw);
    if (!pnpName || Number.isNaN(price) || price <= 0) {
      unmatched.push({ pnpName: pnpName || '(no name)', reason: 'missing name/price', score: 0, bbName: '' });
      continue;
    }

    let top = { score: 0, product: null };
    for (const product of catalogue) {
      const score = scoreMatch(pnpName, product.name);
      if (score > top.score) top = { score, product };
    }

    if (top.product && top.score >= THRESHOLD) {
      const prev = best.get(top.product.barcode);
      if (!prev || top.score > prev.score) {
        best.set(top.product.barcode, {
          score: +top.score.toFixed(3),
          price: +price.toFixed(2),
          bbName: top.product.name,
          pnpName,
        });
      }
    } else {
      unmatched.push({
        pnpName,
        score: +top.score.toFixed(3),
        bbName: top.product ? top.product.name : '',
        reason: 'below threshold',
      });
    }
  }

  const matched = [...best.entries()].map(([barcode, m]) => ({ barcode, ...m }));

  console.log(`Matched   : ${matched.length}`);
  for (const m of matched.sort((a, b) => b.score - a.score)) {
    console.log(`  ✓ ${m.score.toFixed(3)}  "${m.pnpName}"  →  "${m.bbName}"  (${m.barcode}) R${m.price.toFixed(2)}`);
  }

  console.log(`\nUnmatched : ${unmatched.length}`);
  for (const u of unmatched.sort((a, b) => b.score - a.score)) {
    const near = u.bbName ? `  best guess "${u.bbName}" @ ${u.score.toFixed(3)}` : '';
    console.log(`  ✗ "${u.pnpName}"${near}  [${u.reason}]`);
  }

  if (matched.length === 0) {
    console.log('\nNo confident matches — not writing an output CSV.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing the output CSV.');
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(PNP_OUTPUT_DIR, `pnp-matched-${ts}.csv`);
  const header = 'barcode,retailer,price,match_score,bb_product_name,pnp_product_name';
  const lines = matched.map((m) =>
    [m.barcode, RETAILER, m.price.toFixed(2), m.score, m.bbName, m.pnpName].map(csvEscape).join(',')
  );
  fs.writeFileSync(outPath, header + '\n' + lines.join('\n') + '\n', 'utf8');
  console.log(`\nWrote ${matched.length} rows → ${outPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
