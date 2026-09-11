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
const { sendSms } = require('./bulksms');
const { syncFromWooCommerce } = require('./sync');
const { parseInventoryExport } = require('./inventoryImport');
const { categorise } = require('./categorise');
const commerceRouter = require('./commerce');
const staffRouter = require('./staff');
const promosRouter = require('./promos');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/', (req, res) => res.json({ ok: true, service: 'best-before-api' }));

async function generateLoyaltyCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = crypto.randomInt(1000000000, 9999999999).toString();
    const { rows } = await db.query('SELECT id FROM users WHERE loyalty_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('Could not generate a unique loyalty code — try again');
}

function normalisePhone(raw) {
  const digits = (raw || '').replace(/[^\d]/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 11 && digits.startsWith('27')) return '0' + digits.slice(2);
  return null;
}

// --- Phone OTP verification (BulkSMS) ---
const OTP_EXPIRY_MINUTES = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;

function generateOtpCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function hashOtpCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// Generates a code, stores its hash (5 min expiry) and sends it by SMS.
// Throws if BulkSMS fails — callers decide whether that should fail the
// request or just be logged (see /auth/register vs /auth/send-otp).
async function issueOtp(userId, phone) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.query(
    'INSERT INTO phone_otps (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashOtpCode(code), expiresAt]
  );

  await sendSms(phone, `Your Best Before verification code is: ${code}. Valid for ${OTP_EXPIRY_MINUTES} minutes.`);
}

app.post('/auth/register', asyncHandler(async (req, res) => {
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

  const { rows: existingRows } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existingRows[0]) return res.status(409).json({ error: 'An account with that email already exists' });

  const { rows: existingPhoneRows } = await db.query('SELECT id FROM users WHERE phone = $1', [normalisedPhone]);
  if (existingPhoneRows[0]) return res.status(409).json({ error: 'An account with that mobile number already exists' });

  const hash = await bcrypt.hash(password, 10);
  const loyaltyCode = await generateLoyaltyCode();

  const client = await db.connect();
  let userId;
  try {
    await client.query('BEGIN');

    const insertResult = await client.query(
      'INSERT INTO users (name, email, phone, password_hash, loyalty_code) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name.trim(), email.toLowerCase(), normalisedPhone, hash, loyaltyCode]
    );
    userId = insertResult.rows[0].id;

    await client.query(
      `INSERT INTO points_ledger (user_id, points, reason) VALUES ($1, 10, 'signup_bonus')`,
      [userId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Best-effort: a flaky SMS provider shouldn't fail registration. The
  // frontend can retry via POST /auth/send-otp if this didn't land.
  let otpSent = true;
  try {
    await issueOtp(userId, normalisedPhone);
  } catch (err) {
    otpSent = false;
    console.error(`Could not send registration OTP to user ${userId}:`, err.message);
  }

  const user = { id: userId, name: name.trim(), email: email.toLowerCase(), phone_verified: false };
  res.status(201).json({ token: signToken(user), user, otpSent });
}));

app.post('/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const row = rows[0];
  if (!row) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const user = { id: row.id, name: row.name, email: row.email, phone_verified: row.phone_verified };
  res.json({ token: signToken(user), user });
}));

app.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, email, phone, phone_verified, loyalty_code FROM users WHERE id = $1',
    [req.user.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'User not found' });

  const { rows: pointsRows } = await db.query(
    'SELECT COALESCE(SUM(points), 0)::int as balance FROM points_ledger WHERE user_id = $1',
    [req.user.id]
  );

  res.json({ user: { ...row, points_balance: pointsRows[0].balance } });
}));

app.post('/auth/send-otp', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT phone, phone_verified FROM users WHERE id = $1', [req.user.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (!row.phone) return res.status(400).json({ error: 'No phone number on file for this account' });
  if (row.phone_verified) return res.json({ ok: true, alreadyVerified: true });

  const { rows: recentRows } = await db.query(
    'SELECT created_at FROM phone_otps WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.user.id]
  );
  if (recentRows[0]) {
    const secondsSinceLast = (Date.now() - new Date(recentRows[0].created_at).getTime()) / 1000;
    if (secondsSinceLast < OTP_RESEND_COOLDOWN_SECONDS) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLast)}s before requesting another code`,
      });
    }
  }

  try {
    await issueOtp(req.user.id, row.phone);
  } catch (err) {
    return res.status(502).json({ error: 'Could not send verification SMS. Please try again shortly.' });
  }

  res.json({ ok: true, expiresInMinutes: OTP_EXPIRY_MINUTES });
}));

app.post('/auth/verify-otp', requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  if (!code || !/^\d{6}$/.test(String(code))) {
    return res.status(400).json({ error: 'Enter the 6-digit code sent to your phone' });
  }

  const { rows } = await db.query(
    `SELECT * FROM phone_otps
     WHERE user_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id]
  );
  const otp = rows[0];
  if (!otp) return res.status(400).json({ error: 'No verification code found. Request a new one.' });

  if (new Date(otp.expires_at).getTime() < Date.now()) {
    await db.query('UPDATE phone_otps SET consumed_at = NOW() WHERE id = $1', [otp.id]);
    return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  }

  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await db.query('UPDATE phone_otps SET consumed_at = NOW() WHERE id = $1', [otp.id]);
    return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
  }

  if (hashOtpCode(String(code)) !== otp.code_hash) {
    await db.query('UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }

  await db.query('UPDATE phone_otps SET consumed_at = NOW() WHERE id = $1', [otp.id]);
  await db.query('UPDATE users SET phone_verified = true WHERE id = $1', [req.user.id]);

  res.json({ ok: true, phoneVerified: true });
}));

// Full catalogue for the Shop screen — every product with its single
// cheapest verified competitor price joined in, plus a derived category.
// NOTE: must be declared before '/products/:barcode' or ":barcode" swallows "all".
app.get('/products/all', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.barcode, p.name, p.image_url, p.bb_price, p.bb_url,
            c.retailer AS cheapest_retailer,
            c.price    AS cheapest_price
     FROM products p
     LEFT JOIN LATERAL (
       SELECT retailer, price
       FROM competitor_prices
       WHERE barcode = p.barcode AND verified = 1
       ORDER BY price ASC
       LIMIT 1
     ) c ON true
     ORDER BY p.name ASC`
  );

  const products = rows.map((r) => {
    const hasComp = r.cheapest_price != null;
    const saving = hasComp ? +(r.cheapest_price - r.bb_price).toFixed(2) : null;
    const savingPct =
      hasComp && r.cheapest_price > 0
        ? +(((r.cheapest_price - r.bb_price) / r.cheapest_price) * 100).toFixed(1)
        : null;
    return {
      barcode: r.barcode,
      name: r.name,
      image_url: r.image_url,
      bb_price: r.bb_price,
      bb_url: r.bb_url,
      category: categorise(r.name),
      cheapestCompetitor: hasComp ? { retailer: r.cheapest_retailer, price: r.cheapest_price } : null,
      saving,
      savingPct,
    };
  });

  res.json({ count: products.length, products });
}));

app.get('/products/:barcode', requireAuth, asyncHandler(async (req, res) => {
  const { barcode } = req.params;

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE barcode = $1', [barcode]);
  const product = productRows[0];

  await db.query(
    'INSERT INTO scan_history (user_id, barcode, found) VALUES ($1, $2, $3)',
    [req.user.id, barcode, product ? 1 : 0]
  );

  if (!product) {
    return res.status(404).json({
      error: 'Product not recognised yet',
      barcode,
      canSubmit: true,
    });
  }

  const { rows: competitors } = await db.query(
    `SELECT retailer, price, source, verified, updated_at
     FROM competitor_prices
     WHERE barcode = $1 AND verified = 1
     ORDER BY price ASC`,
    [barcode]
  );

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
}));

app.post('/products/:barcode/submit-price', requireAuth, asyncHandler(async (req, res) => {
  const { barcode } = req.params;
  const { retailer, price } = req.body || {};

  const validRetailers = ['Pick n Pay', 'Checkers', 'Woolworths', 'Spar', 'Makro'];
  if (!validRetailers.includes(retailer)) {
    return res.status(400).json({ error: `retailer must be one of ${validRetailers.join(', ')}` });
  }
  if (typeof price !== 'number' || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number' });
  }

  await db.query(
    `INSERT INTO competitor_prices (barcode, retailer, price, source, verified, submitted_by)
     VALUES ($1, $2, $3, 'user_submitted', 0, $4)`,
    [barcode, retailer, price, req.user.id]
  );

  res.status(201).json({ ok: true, message: "Thanks! We'll verify this and add it to the comparison shortly." });
}));

app.get('/me/scans', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.barcode, s.found, s.scanned_at, p.name, p.image_url, p.bb_price
     FROM scan_history s
     LEFT JOIN products p ON p.barcode = s.barcode
     WHERE s.user_id = $1
     ORDER BY s.scanned_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  res.json({ scans: rows });
}));

app.use(commerceRouter);
app.use(staffRouter);
app.use(promosRouter);

app.post('/admin/competitor-prices/upload', requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a CSV file as "file"' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
  }

  const validRetailers = ['Pick n Pay', 'Checkers', 'Woolworths', 'Spar', 'Makro'];
  let inserted = 0;
  let updated = 0;
  const errors = [];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const [i, row] of records.entries()) {
      const barcode = (row.barcode || '').trim();
      const retailer = (row.retailer || '').trim();
      const price = parseFloat(row.price);

      if (!barcode || !validRetailers.includes(retailer) || Number.isNaN(price)) {
        errors.push({ row: i + 2, reason: 'invalid barcode/retailer/price', data: row });
        continue;
      }

      // Upsert on the (barcode, retailer) partial unique index for admin rows.
      // created_at is preserved on conflict so we keep the first-seen date;
      // updated_at tracks the latest price change. xmax = 0 ⇒ this was a fresh
      // insert, otherwise it replaced an existing row.
      const result = await client.query(
        `INSERT INTO competitor_prices (barcode, retailer, price, source, verified, created_at, updated_at)
         VALUES ($1, $2, $3, 'admin', 1, NOW(), NOW())
         ON CONFLICT (barcode, retailer) WHERE source = 'admin'
         DO UPDATE SET price = EXCLUDED.price, verified = 1, updated_at = NOW()
         RETURNING (xmax = 0) AS was_insert`,
        [barcode, retailer, price]
      );
      if (result.rows[0].was_insert) inserted += 1;
      else updated += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({
    ok: true,
    upserted: inserted + updated,
    inserted,
    updated,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}));

app.post('/admin/competitor-prices/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
  const result = await db.query('UPDATE competitor_prices SET verified = 1 WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

app.get('/admin/competitor-prices/pending', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT cp.*, p.name FROM competitor_prices cp
     LEFT JOIN products p ON p.barcode = cp.barcode
     WHERE cp.verified = 0 ORDER BY cp.updated_at DESC`
  );
  res.json({ pending: rows });
}));

app.post('/admin/sync-catalogue', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await syncFromWooCommerce();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.post('/admin/products/upload-inventory', requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the inventory .xlsx file as "file"' });

  let parsed;
  try {
    parsed = parseInventoryExport(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse file: ${err.message}` });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const p of parsed.products) {
      await client.query(
        `INSERT INTO products (barcode, name, bb_price)
         VALUES ($1, $2, $3)
         ON CONFLICT (barcode) DO UPDATE SET
           name = EXCLUDED.name, bb_price = EXCLUDED.bb_price, updated_at = NOW()`,
        [p.barcode, p.name, p.bb_price]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({
    ok: true,
    inserted: parsed.products.length,
    skippedCount: parsed.skipped.length,
    skipped: parsed.skipped.slice(0, 30),
  });
}));

app.get('/admin/missing-competitor-data', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.barcode, p.name, COUNT(s.id)::int as times_scanned
     FROM products p
     LEFT JOIN scan_history s ON s.barcode = p.barcode
     WHERE p.barcode NOT IN (SELECT DISTINCT barcode FROM competitor_prices WHERE verified = 1)
     GROUP BY p.barcode, p.name
     ORDER BY times_scanned DESC
     LIMIT 100`
  );
  res.json({ missing: rows });
}));

// Central error handler — required because Express 4 does not catch
// rejected promises from async route handlers on its own; asyncHandler()
// forwards them here via next(err).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

db.ready
  .then(() => {
    app.listen(PORT, () => console.log(`Best Before API listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start server — database not ready:', err);
    process.exit(1);
  });
