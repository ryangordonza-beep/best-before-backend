// db.js
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bestbefore.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  loyalty_code  TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode       TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  image_url     TEXT,
  bb_price      REAL NOT NULL,
  bb_url        TEXT,
  in_stock      INTEGER DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS competitor_prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode       TEXT NOT NULL,
  retailer      TEXT NOT NULL CHECK (retailer IN ('Pick n Pay','Checkers','Woolworths','Spar')),
  price         REAL NOT NULL,
  source        TEXT NOT NULL DEFAULT 'admin',
  verified      INTEGER NOT NULL DEFAULT 1,
  submitted_by  INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (submitted_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_competitor_barcode ON competitor_prices(barcode);

CREATE TABLE IF NOT EXISTS scan_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  barcode       TEXT NOT NULL,
  found         INTEGER NOT NULL,
  scanned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

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

CREATE TABLE IF NOT EXISTS points_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  points          INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  transaction_id  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_points_ledger_user ON points_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_basket_user ON basket_items(user_id);

CREATE TABLE IF NOT EXISTS promos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  caption     TEXT,
  image_data  BLOB NOT NULL,
  image_mime  TEXT NOT NULL DEFAULT 'image/png',
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
