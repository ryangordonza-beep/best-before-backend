// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const db = require('./db');
const { signToken, requireAuth, requireAdmin } = require('./auth');
const { syncFromWooCommerce } = require('./sync');
const { parseInventoryExport } = require('./inventoryImport');
const commerceRouter = require('./commerce');
const staffRouter = require('./staff');
const promosRouter = require('./promos');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => res.json({ ok: true, service: 'best-before-api' }));

function generateLoyaltyCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = crypto.randomInt(1000000000, 9999999999).toString();
    const existing = db.prepare('SELECT id FROM users WHERE loyalty_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique loyalty code — try again');
}

function normalisePhone(raw) {
  const digits = (raw || '').replace(/[^\d]/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 11 && digits.startsWith('27')) return '0' + digits.slice(2);
  return null;
}

app.post('/auth/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (/\d/.test(name)) return res.status(400).json({ error: 'Name should not contain numbers' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  const normalisedPhone = normalisePhone(phone);
  if (!normalisedPhone) {
    return res.status(400).json({ error: 'Enter a valid 10-digit South African mobile number, e.g. 0821234567' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(normalisedPhone);
  if (existingPhone) return res.status(409).json({ error: 'An account with that mobile number already exists' });

  const hash = await bcrypt.hash(password, 10);
  const loyaltyCode = generateLoyaltyCode();

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (name, email, phone, password_hash, loyalty_code) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), email.toLowerCase(), normalisedPhone, hash, loyaltyCode);

    db.prepare(
      `INSERT INTO points_ledger (user_id, points, reason) VALUES (?, 10, 'signup_bonus')`
    ).run(info.lastInsertRowid);

    return info.lastInsertRowid;
  });

  const userId = tx();
  const user = { id: userId, name: name.trim(), email: email.toLowerCase() };
  res.status(201).json({ token: signToken(user), user });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const user = { id: row.id, name: row.name, email: row.email };
  res.json({ token: signToken(user), user });
});

app.get('/auth/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, name, email, phone, loyalty_code FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const pointsRow = db
    .prepare('SELECT COALESCE(SUM(points), 0) as balance FROM points_ledger WHERE user_id = ?')
    .get(req.user.id);

  res.json({ user: { ...row, points_balance: pointsRow.balance } });
});

app.get('/products/:barcode', requireAuth, (req, res) => {
  const { barcode } = req.params;

  const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);

  db.prepare('INSERT INTO scan_history (user_id, barcode, found) VALUES (?, ?, ?)').run(
    req.user.id,
    barcode,
    product ? 1 : 0
  );

  if (!product) {
    return res.status(404).json({
      error: 'Product not recognised yet',
      barcode,
      canSubmit: true,
    });
  }

  const competitors = db
    .prepare(
      `SELECT retailer, price, source, verified, updated_at
       FROM competitor_prices
       WHERE barcode = ? AND verified = 1
       ORDER BY price ASC`
    )
    .all(barcode);

  const savings = competitors.map((c) => ({
    ...c,
    saving: +(c.price - product.bb_price).toFixed(2),
    savingPct: +(((c.price - product.bb_price) / c.price) * 100).toFixed(1),
  }));

  const cheapestCompetitor = savings[0] || null;

  res.json({
    product,
    competitors: savings,
    bestSaving: cheapestCompetitor
      ? { retailer: cheapestCompetitor.retailer, saving: cheapestCompetitor.saving, savingPct: cheapestCompetitor.savingPct }
      : null,
    hasCompetitorData: competitors.length > 0,
  });
});

app.post('/products/:barcode/submit-price', requireAuth, (req, res) => {
  const { barcode } = req.params;
  const { retailer, price } = req.body || {};

  const validRetailers = ['Pick n Pay', 'Checkers', 'Woolworths', 'Spar'];
  if (!validRetailers.includes(retailer)) {
    return res.status(400).json({ error: `retailer must be one of ${validRetailers.join(', ')}` });
  }
  if (typeof price !== 'number' || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number' });
  }

  db.prepare(
    `INSERT INTO competitor_prices (barcode, retailer, price, source, verified, submitted_by)
     VALUES (?, ?, ?, 'user_submitted', 0, ?)`
  ).run(barcode, retailer, price, req.user.id);

  res.status(201).json({ ok: true, message: "Thanks! We'll verify this and add it to the comparison shortly." });
});

app.get('/me/scans', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.barcode, s.found, s.scanned_at, p.name, p.image_url, p.bb_price
       FROM scan_history s
       LEFT JOIN products p ON p.barcode = s.barcode
       WHERE s.user_id = ?
       ORDER BY s.scanned_at DESC
       LIMIT 50`
    )
    .all(req.user.id);
  res.json({ scans: rows });
});

app.use(commerceRouter);
app.use(staffRouter);
app.use(promosRouter);

app.post('/admin/competitor-prices/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a CSV file as "file"' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
  }

  const validRetailers = ['Pick n Pay', 'Checkers', 'Woolworths', 'Spar'];
  const upsert = db.prepare(`
    INSERT INTO competitor_prices (barcode, retailer, price, source, verified, updated_at)
    VALUES (?, ?, ?, 'admin', 1, datetime('now'))
  `);
  const clearOld = db.prepare(
    `DELETE FROM competitor_prices WHERE barcode = ? AND retailer = ? AND source = 'admin'`
  );

  let inserted = 0;
  const errors = [];

  const tx = db.transaction((rows) => {
    rows.forEach((row, i) => {
      const barcode = (row.barcode || '').trim();
      const retailer = (row.retailer || '').trim();
      const price = parseFloat(row.price);

      if (!barcode || !validRetailers.includes(retailer) || Number.isNaN(price)) {
        errors.push({ row: i + 2, reason: 'invalid barcode/retailer/price', data: row });
        return;
      }
      clearOld.run(barcode, retailer);
      upsert.run(barcode, retailer, price);
      inserted += 1;
    });
  });
  tx(records);

  res.json({ ok: true, inserted, errorCount: errors.length, errors: errors.slice(0, 20) });
});

app.post('/admin/competitor-prices/:id/approve', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE competitor_prices SET verified = 1 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.get('/admin/competitor-prices/pending', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT cp.*, p.name FROM competitor_prices cp
       LEFT JOIN products p ON p.barcode = cp.barcode
       WHERE cp.verified = 0 ORDER BY cp.updated_at DESC`
    )
    .all();
  res.json({ pending: rows });
});

app.post('/admin/sync-catalogue', requireAdmin, async (req, res) => {
  try {
    const result = await syncFromWooCommerce();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/products/upload-inventory', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the inventory .xlsx file as "file"' });

  let parsed;
  try {
    parsed = parseInventoryExport(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse file: ${err.message}` });
  }

  const upsert = db.prepare(`
    INSERT INTO products (barcode, name, bb_price)
    VALUES (@barcode, @name, @bb_price)
    ON CONFLICT(barcode) DO UPDATE SET
      name = excluded.name, bb_price = excluded.bb_price, updated_at = datetime('now')
  `);

  const tx = db.transaction((products) => {
    products.forEach((p) => upsert.run(p));
  });
  tx(parsed.products);

  res.json({
    ok: true,
    inserted: parsed.products.length,
    skippedCount: parsed.skipped.length,
    skipped: parsed.skipped.slice(0, 30),
  });
});

app.get('/admin/missing-competitor-data', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.barcode, p.name, COUNT(s.id) as times_scanned
       FROM products p
       LEFT JOIN scan_history s ON s.barcode = p.barcode
       WHERE p.barcode NOT IN (SELECT DISTINCT barcode FROM competitor_prices WHERE verified = 1)
       GROUP BY p.barcode
       ORDER BY times_scanned DESC
       LIMIT 100`
    )
    .all();
  res.json({ missing: rows });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Best Before API listening on :${PORT}`));
