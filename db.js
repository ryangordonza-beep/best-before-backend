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
  phone         TEXT UNIQUE,       -- normalised to 0XXXXXXXXX; lets staff find a customer without the QR
  password_hash TEXT NOT NULL,
  loyalty_code  TEXT UNIQUE,       -- shown as a QR code at checkout; matched to a real till once POS is connected
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
-- on which products people actually want compared.
CREATE TABLE IF NOT EXISTS scan_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  barcode       TEXT NOT NULL,
  found         INTEGER NOT NULL, -- 1 if we had product data, 0 if unknown barcode
  scanned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- "My Shop" basket. One row per line item. Snapshots the Best Before
-- price at the moment it was added, so the basket total doesn't shift
-- underneath the customer if a price changes while they're shopping.
CREATE TABLE IF NOT EXISTS basket_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  barcode       TEXT NOT NULL,
  name          TEXT NOT NULL,
  unit_price    REAL NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- A confirmed checkout. Until real POS integration exists, "confirmed"
-- actually means "the mock till-confirmation button was tapped" —
-- see commerce.js checkout/confirm. status is kept as a column now so
-- swapping in real POS reconciliation later (status: 'estimated' ->
-- 'confirmed') doesn't require a schema change.
CREATE TABLE IF NOT EXISTS transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  subtotal          REAL NOT NULL,
  savings_estimate  REAL NOT NULL,
  points_awarded    INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transaction_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  INTEGER NOT NULL,
  barcode         TEXT NOT NULL,
  name            TEXT NOT NULL,
  unit_price      REAL NOT NULL,
  qty             INTEGER NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

-- Append-only points ledger — never update or delete a row, only add
-- new ones (positive = earned, negative = redeemed). The user's
-- balance is always SUM(points) for that user, so there's exactly one
-- source of truth and no risk of a stored "balance" column drifting
-- out of sync with history.
CREATE TABLE IF NOT EXISTS points_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  points          INTEGER NOT NULL,
  reason          TEXT NOT NULL, -- 'signup_bonus' | 'purchase' | 'redeemed' | 'manual_adjustment'
  transaction_id  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_points_ledger_user ON points_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_basket_user ON basket_items(user_id);
`);

module.exports = db;
