const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        phone         TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        loyalty_code  TEXT UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id            SERIAL PRIMARY KEY,
        barcode       TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        image_url     TEXT,
        bb_price      REAL NOT NULL,
        bb_url        TEXT,
        in_stock      INTEGER DEFAULT 1,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS competitor_prices (
        id            SERIAL PRIMARY KEY,
        barcode       TEXT NOT NULL,
        retailer      TEXT NOT NULL,
        price         REAL NOT NULL,
        source        TEXT NOT NULL DEFAULT 'admin',
        verified      INTEGER NOT NULL DEFAULT 1,
        submitted_by  INTEGER,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_competitor_barcode ON competitor_prices(barcode);
      CREATE TABLE IF NOT EXISTS scan_history (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        barcode       TEXT NOT NULL,
        found         INTEGER NOT NULL,
        scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS basket_items (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        barcode       TEXT NOT NULL,
        name          TEXT NOT NULL,
        unit_price    REAL NOT NULL,
        qty           INTEGER NOT NULL DEFAULT 1,
        added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL,
        subtotal          REAL NOT NULL,
        savings_estimate  REAL NOT NULL,
        points_awarded    INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'confirmed',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS transaction_items (
        id              SERIAL PRIMARY KEY,
        transaction_id  INTEGER NOT NULL,
        barcode         TEXT NOT NULL,
        name            TEXT NOT NULL,
        unit_price      REAL NOT NULL,
        qty             INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS points_ledger (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        points          INTEGER NOT NULL,
        reason          TEXT NOT NULL,
        transaction_id  INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_points_ledger_user ON points_ledger(user_id);
      CREATE INDEX IF NOT EXISTS idx_basket_user ON basket_items(user_id);
      CREATE TABLE IF NOT EXISTS promos (
        id          SERIAL PRIMARY KEY,
        title       TEXT NOT NULL,
        caption     TEXT,
        image_data  BYTEA NOT NULL,
        image_mime  TEXT NOT NULL DEFAULT 'image/png',
        expires_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('Database initialised');
  } finally {
    client.release();
  }
}

// Consumers that issue queries at module load or process start (seed.js,
// server.js) must `await pool.ready` first — pg's connection/init is async,
// unlike better-sqlite3's synchronous exec, so there's no implicit ordering
// guarantee that the schema exists before the first query runs.
pool.ready = initDb().catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});

module.exports = pool;