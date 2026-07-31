// db.js
// Lightweight SQLite database for the MVP. Swap for Postgres later by
// changing this file only — every other file talks to `db.prepare(...)`.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bestbefore.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per product Best Before sells, keyed by barcode (EAN/UPC).
-- Populated by syncing Best Before's WooCommerce catalog (see sync.js).
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode       TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  image_url     TEXT,
  bb_price      REAL NOT NULL,       -- Best Before's price (rands)
  bb_url        TEXT,                -- link to the product on best-before.co.za
  in_stock      INTEGER DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Competitor prices for the same barcode. Multiple rows per product
-- (one per retailer). Populated by (a) admin CSV import, or
-- (b) user-submitted price sightings once verified.
CREATE TABLE IF NOT EXISTS competitor_prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode       TEXT NOT NULL,
  retailer      TEXT NOT NULL CHECK (retailer IN ('Pick n Pay','Checkers','Woolworths','Spar')),
  price         REAL NOT NULL,
  source        TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'user_submitted'
  verified      INTEGER NOT NULL DEFAULT 1,    -- user_submitted rows start at 0
  submitted_by  INTEGER,                        -- user id, if source = user_submitted
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (submitted_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_competitor_barcode ON competitor_prices(barcode);

-- Every barcode a user scans, for "recently scanned" + basic analytics
-- on which products people actually want compared (useful for prioritising
-- which competitor prices to capture first).
CREATE TABLE IF NOT EXISTS scan_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  barcode       TEXT NOT NULL,
  found         INTEGER NOT NULL, -- 1 if we had product data, 0 if unknown barcode
  scanned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

module.exports = db;
