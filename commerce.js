// commerce.js
const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

const POINTS_RATE = 0.02;

function computeBasket(userId) {
  const items = db
    .prepare(
      `SELECT bi.id, bi.barcode, bi.name, bi.unit_price, bi.qty, bi.added_at,
              (SELECT MIN(price) FROM competitor_prices
               WHERE barcode = bi.barcode AND verified = 1) as cheapest_competitor_price
       FROM basket_items bi
       WHERE bi.user_id = ?
       ORDER BY bi.added_at ASC`
    )
    .all(userId);

  let subtotal = 0;
  let savingsEstimate = 0;

  const lineItems = items.map((item) => {
    const lineTotal = +(item.unit_price * item.qty).toFixed(2);
    subtotal += lineTotal;

    let lineSaving = 0;
    if (item.cheapest_competitor_price != null) {
      lineSaving = +((item.cheapest_competitor_price - item.unit_price) * item.qty).toFixed(2);
      savingsEstimate += lineSaving;
    }

    return {
      id: item.id,
      barcode: item.barcode,
      name: item.name,
      unitPrice: item.unit_price,
      qty: item.qty,
      lineTotal,
      lineSaving: item.cheapest_competitor_price != null ? lineSaving : null,
    };
  });

  subtotal = +subtotal.toFixed(2);
  savingsEstimate = +savingsEstimate.toFixed(2);
  const estimatedPoints = Math.round(subtotal * POINTS_RATE);

  return { items: lineItems, subtotal, savingsEstimate, estimatedPoints };
}

router.get('/basket', requireAuth, (req, res) => {
  res.json(computeBasket(req.user.id));
});

router.post('/basket/items', requireAuth, (req, res) => {
  const { barcode, qty } = req.body || {};
  const quantity = Number.isInteger(qty) && qty > 0 ? qty : 1;

  if (!barcode) return res.status(400).json({ error: 'barcode is required' });

  const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
  if (!product) return res.status(404).json({ error: 'Unknown product — scan a recognised barcode first' });

  const existing = db
    .prepare('SELECT * FROM basket_items WHERE user_id = ? AND barcode = ?')
    .get(req.user.id, barcode);

  if (existing) {
    db.prepare('UPDATE basket_items SET qty = qty + ? WHERE id = ?').run(quantity, existing.id);
  } else {
    db.prepare(
      `INSERT INTO basket_items (user_id, barcode, name, unit_price, qty)
       VALUES (?, ?, ?, ?, ?)`
    ).run(req.user.id, barcode, product.name, product.bb_price, quantity);
  }

  res.status(201).json(computeBasket(req.user.id));
});

router.patch('/basket/items/:id', requireAuth, (req, res) => {
  const { qty } = req.body || {};
  if (!Number.isInteger(qty)) return res.status(400).json({ error: 'qty must be an integer' });

  const item = db
    .prepare('SELECT * FROM basket_items WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Basket item not found' });

  if (qty <= 0) {
    db.prepare('DELETE FROM basket_items WHERE id = ?').run(item.id);
  } else {
    db.prepare('UPDATE basket_items SET qty = ? WHERE id = ?').run(qty, item.id);
  }

  res.json(computeBasket(req.user.id));
});

router.delete('/basket/items/:id', requireAuth, (req, res) => {
  const info = db
    .prepare('DELETE FROM basket_items WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Basket item not found' });
  res.json(computeBasket(req.user.id));
});

router.delete('/basket', requireAuth, (req, res) => {
  db.prepare('DELETE FROM basket_items WHERE user_id = ?').run(req.user.id);
  res.json(computeBasket(req.user.id));
});

router.post('/checkout/start', requireAuth, (req, res) => {
  const user = db.prepare('SELECT loyalty_code FROM users WHERE id = ?').get(req.user.id);
  const basket = computeBasket(req.user.id);

  if (basket.items.length === 0) {
    return res.status(400).json({ error: 'Your basket is empty' });
  }

  res.json({ loyaltyCode: user.loyalty_code, basket });
});

router.post('/checkout/confirm', requireAuth, (req, res) => {
  const basket = computeBasket(req.user.id);
  if (basket.items.length === 0) {
    return res.status(400).json({ error: 'Your basket is empty' });
  }

  const pointsAwarded = basket.estimatedPoints;

  const tx = db.transaction(() => {
    const txInfo = db
      .prepare(
        `INSERT INTO transactions (user_id, subtotal, savings_estimate, points_awarded, status)
         VALUES (?, ?, ?, ?, 'confirmed')`
      )
      .run(req.user.id, basket.subtotal, basket.savingsEstimate, pointsAwarded);

    const transactionId = txInfo.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO transaction_items (transaction_id, barcode, name, unit_price, qty)
       VALUES (?, ?, ?, ?, ?)`
    );
    basket.items.forEach((item) => {
      insertItem.run(transactionId, item.barcode, item.name, item.unitPrice, item.qty);
    });

    db.prepare(
      `INSERT INTO points_ledger (user_id, points, reason, transaction_id) VALUES (?, ?, 'purchase', ?)`
    ).run(req.user.id, pointsAwarded, transactionId);

    db.prepare('DELETE FROM basket_items WHERE user_id = ?').run(req.user.id);

    return transactionId;
  });

  const transactionId = tx();
  const pointsRow = db
    .prepare('SELECT COALESCE(SUM(points), 0) as balance FROM points_ledger WHERE user_id = ?')
    .get(req.user.id);

  res.status(201).json({
    transactionId,
    subtotal: basket.subtotal,
    savings: basket.savingsEstimate,
    pointsAwarded,
    newPointsBalance: pointsRow.balance,
  });
});

router.get('/rewards', requireAuth, (req, res) => {
  const balanceRow = db
    .prepare('SELECT COALESCE(SUM(points), 0) as balance FROM points_ledger WHERE user_id = ?')
    .get(req.user.id);

  const history = db
    .prepare(
      `SELECT points, reason, transaction_id, created_at
       FROM points_ledger
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(req.user.id);

  const balance = balanceRow.balance;
  const nextMilestone = (Math.floor(balance / 50) + 1) * 50;

  res.json({
    balance,
    randValue: balance,
    nextMilestone,
    pointsToNextMilestone: nextMilestone - balance,
    history,
  });
});

router.get('/me/transactions', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, subtotal, savings_estimate, points_awarded, status, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(req.user.id);
  res.json({ transactions: rows });
});

module.exports = router;
module.exports.computeBasket = computeBasket;
module.exports.POINTS_RATE = POINTS_RATE;
