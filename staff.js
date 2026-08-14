// staff.js
const express = require('express');
const db = require('./db');
const { requireStaff } = require('./auth');
const { computeBasket, POINTS_RATE } = require('./commerce');

const router = express.Router();

function findCustomer({ phone, loyaltyCode }) {
  if (loyaltyCode) {
    return db.prepare('SELECT id, name, phone, loyalty_code FROM users WHERE loyalty_code = ?').get(loyaltyCode);
  }
  if (phone) {
    const digits = phone.replace(/[^\d]/g, '');
    let normalised = digits;
    if (digits.length === 11 && digits.startsWith('27')) normalised = '0' + digits.slice(2);
    return db.prepare('SELECT id, name, phone, loyalty_code FROM users WHERE phone = ?').get(normalised);
  }
  return null;
}

router.post('/staff/lookup', requireStaff, (req, res) => {
  const { phone, loyaltyCode } = req.body || {};
  if (!phone && !loyaltyCode) {
    return res.status(400).json({ error: 'Provide phone or loyaltyCode' });
  }

  const customer = findCustomer({ phone, loyaltyCode });
  if (!customer) return res.status(404).json({ error: 'No customer found with that phone number or code' });

  const basket = computeBasket(customer.id);

  res.json({
    userId: customer.id,
    name: customer.name,
    phone: customer.phone,
    loyaltyCode: customer.loyalty_code,
    basket,
  });
});

router.post('/staff/confirm', requireStaff, (req, res) => {
  const { userId, subtotal } = req.body || {};

  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId is required' });
  if (typeof subtotal !== 'number' || subtotal <= 0) {
    return res.status(400).json({ error: 'subtotal must be a positive number (the real till total)' });
  }

  const customer = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const basket = computeBasket(userId);
  const pointsAwarded = Math.round(subtotal * POINTS_RATE);

  const tx = db.transaction(() => {
    const txInfo = db
      .prepare(
        `INSERT INTO transactions (user_id, subtotal, savings_estimate, points_awarded, status)
         VALUES (?, ?, ?, ?, 'confirmed')`
      )
      .run(userId, subtotal, basket.savingsEstimate, pointsAwarded);

    const transactionId = txInfo.lastInsertRowid;

    if (basket.items.length > 0) {
      const insertItem = db.prepare(
        `INSERT INTO transaction_items (transaction_id, barcode, name, unit_price, qty)
         VALUES (?, ?, ?, ?, ?)`
      );
      basket.items.forEach((item) => {
        insertItem.run(transactionId, item.barcode, item.name, item.unitPrice, item.qty);
      });
    }

    db.prepare(
      `INSERT INTO points_ledger (user_id, points, reason, transaction_id) VALUES (?, ?, 'purchase', ?)`
    ).run(userId, pointsAwarded, transactionId);

    db.prepare('DELETE FROM basket_items WHERE user_id = ?').run(userId);

    return transactionId;
  });

  const transactionId = tx();
  const pointsRow = db
    .prepare('SELECT COALESCE(SUM(points), 0) as balance FROM points_ledger WHERE user_id = ?')
    .get(userId);

  res.status(201).json({
    transactionId,
    customerName: customer.name,
    subtotal,
    savingsEstimate: basket.savingsEstimate,
    pointsAwarded,
    newPointsBalance: pointsRow.balance,
  });
});

module.exports = router;
