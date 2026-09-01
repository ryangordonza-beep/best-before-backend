// staff.js
const express = require('express');
const db = require('./db');
const { requireStaff } = require('./auth');
const { computeBasket, POINTS_RATE } = require('./commerce');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function findCustomer({ phone, loyaltyCode }) {
  if (loyaltyCode) {
    const { rows } = await db.query(
      'SELECT id, name, phone, loyalty_code FROM users WHERE loyalty_code = $1',
      [loyaltyCode]
    );
    return rows[0] || null;
  }
  if (phone) {
    const digits = phone.replace(/[^\d]/g, '');
    let normalised = digits;
    if (digits.length === 11 && digits.startsWith('27')) normalised = '0' + digits.slice(2);
    const { rows } = await db.query(
      'SELECT id, name, phone, loyalty_code FROM users WHERE phone = $1',
      [normalised]
    );
    return rows[0] || null;
  }
  return null;
}

router.post('/staff/lookup', requireStaff, asyncHandler(async (req, res) => {
  const { phone, loyaltyCode } = req.body || {};
  if (!phone && !loyaltyCode) {
    return res.status(400).json({ error: 'Provide phone or loyaltyCode' });
  }

  const customer = await findCustomer({ phone, loyaltyCode });
  if (!customer) return res.status(404).json({ error: 'No customer found with that phone number or code' });

  const basket = await computeBasket(customer.id);

  res.json({
    userId: customer.id,
    name: customer.name,
    phone: customer.phone,
    loyaltyCode: customer.loyalty_code,
    basket,
  });
}));

router.post('/staff/confirm', requireStaff, asyncHandler(async (req, res) => {
  const { userId, subtotal } = req.body || {};

  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId is required' });
  if (typeof subtotal !== 'number' || subtotal <= 0) {
    return res.status(400).json({ error: 'subtotal must be a positive number (the real till total)' });
  }

  const { rows: customerRows } = await db.query('SELECT id, name FROM users WHERE id = $1', [userId]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const basket = await computeBasket(userId);
  const pointsAwarded = Math.round(subtotal * POINTS_RATE);

  const client = await db.connect();
  let transactionId;
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `INSERT INTO transactions (user_id, subtotal, savings_estimate, points_awarded, status)
       VALUES ($1, $2, $3, $4, 'confirmed') RETURNING id`,
      [userId, subtotal, basket.savingsEstimate, pointsAwarded]
    );
    transactionId = txResult.rows[0].id;

    if (basket.items.length > 0) {
      for (const item of basket.items) {
        await client.query(
          `INSERT INTO transaction_items (transaction_id, barcode, name, unit_price, qty)
           VALUES ($1, $2, $3, $4, $5)`,
          [transactionId, item.barcode, item.name, item.unitPrice, item.qty]
        );
      }
    }

    await client.query(
      `INSERT INTO points_ledger (user_id, points, reason, transaction_id) VALUES ($1, $2, 'purchase', $3)`,
      [userId, pointsAwarded, transactionId]
    );

    await client.query('DELETE FROM basket_items WHERE user_id = $1', [userId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: pointsRows } = await db.query(
    'SELECT COALESCE(SUM(points), 0)::int as balance FROM points_ledger WHERE user_id = $1',
    [userId]
  );

  res.status(201).json({
    transactionId,
    customerName: customer.name,
    subtotal,
    savingsEstimate: basket.savingsEstimate,
    pointsAwarded,
    newPointsBalance: pointsRows[0].balance,
  });
}));

module.exports = router;
