// commerce.js
const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

const POINTS_RATE = 0.02;

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function computeBasket(userId) {
  const { rows: items } = await db.query(
    `SELECT bi.id, bi.barcode, bi.name, bi.unit_price, bi.qty, bi.added_at,
            (SELECT MIN(price) FROM competitor_prices
             WHERE barcode = bi.barcode AND verified = 1) as cheapest_competitor_price
     FROM basket_items bi
     WHERE bi.user_id = $1
     ORDER BY bi.added_at ASC`,
    [userId]
  );

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

router.get('/basket', requireAuth, asyncHandler(async (req, res) => {
  res.json(await computeBasket(req.user.id));
}));

router.post('/basket/items', requireAuth, asyncHandler(async (req, res) => {
  const { barcode, qty } = req.body || {};
  const quantity = Number.isInteger(qty) && qty > 0 ? qty : 1;

  if (!barcode) return res.status(400).json({ error: 'barcode is required' });

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE barcode = $1', [barcode]);
  const product = productRows[0];
  if (!product) return res.status(404).json({ error: 'Unknown product — scan a recognised barcode first' });

  const { rows: existingRows } = await db.query(
    'SELECT * FROM basket_items WHERE user_id = $1 AND barcode = $2',
    [req.user.id, barcode]
  );
  const existing = existingRows[0];

  if (existing) {
    await db.query('UPDATE basket_items SET qty = qty + $1 WHERE id = $2', [quantity, existing.id]);
  } else {
    await db.query(
      `INSERT INTO basket_items (user_id, barcode, name, unit_price, qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, barcode, product.name, product.bb_price, quantity]
    );
  }

  res.status(201).json(await computeBasket(req.user.id));
}));

router.patch('/basket/items/:id', requireAuth, asyncHandler(async (req, res) => {
  const { qty } = req.body || {};
  if (!Number.isInteger(qty)) return res.status(400).json({ error: 'qty must be an integer' });

  const { rows } = await db.query(
    'SELECT * FROM basket_items WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'Basket item not found' });

  if (qty <= 0) {
    await db.query('DELETE FROM basket_items WHERE id = $1', [item.id]);
  } else {
    await db.query('UPDATE basket_items SET qty = $1 WHERE id = $2', [qty, item.id]);
  }

  res.json(await computeBasket(req.user.id));
}));

router.delete('/basket/items/:id', requireAuth, asyncHandler(async (req, res) => {
  const result = await db.query(
    'DELETE FROM basket_items WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Basket item not found' });
  res.json(await computeBasket(req.user.id));
}));

router.delete('/basket', requireAuth, asyncHandler(async (req, res) => {
  await db.query('DELETE FROM basket_items WHERE user_id = $1', [req.user.id]);
  res.json(await computeBasket(req.user.id));
}));

router.post('/checkout/start', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT loyalty_code FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  const basket = await computeBasket(req.user.id);

  if (basket.items.length === 0) {
    return res.status(400).json({ error: 'Your basket is empty' });
  }

  res.json({ loyaltyCode: user.loyalty_code, basket });
}));

router.post('/checkout/confirm', requireAuth, asyncHandler(async (req, res) => {
  const basket = await computeBasket(req.user.id);
  if (basket.items.length === 0) {
    return res.status(400).json({ error: 'Your basket is empty' });
  }

  const pointsAwarded = basket.estimatedPoints;

  const client = await db.connect();
  let transactionId;
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `INSERT INTO transactions (user_id, subtotal, savings_estimate, points_awarded, status)
       VALUES ($1, $2, $3, $4, 'confirmed') RETURNING id`,
      [req.user.id, basket.subtotal, basket.savingsEstimate, pointsAwarded]
    );
    transactionId = txResult.rows[0].id;

    for (const item of basket.items) {
      await client.query(
        `INSERT INTO transaction_items (transaction_id, barcode, name, unit_price, qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [transactionId, item.barcode, item.name, item.unitPrice, item.qty]
      );
    }

    await client.query(
      `INSERT INTO points_ledger (user_id, points, reason, transaction_id) VALUES ($1, $2, 'purchase', $3)`,
      [req.user.id, pointsAwarded, transactionId]
    );

    await client.query('DELETE FROM basket_items WHERE user_id = $1', [req.user.id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: pointsRows } = await db.query(
    'SELECT COALESCE(SUM(points), 0)::int as balance FROM points_ledger WHERE user_id = $1',
    [req.user.id]
  );

  res.status(201).json({
    transactionId,
    subtotal: basket.subtotal,
    savings: basket.savingsEstimate,
    pointsAwarded,
    newPointsBalance: pointsRows[0].balance,
  });
}));

router.get('/rewards', requireAuth, asyncHandler(async (req, res) => {
  const { rows: balanceRows } = await db.query(
    'SELECT COALESCE(SUM(points), 0)::int as balance FROM points_ledger WHERE user_id = $1',
    [req.user.id]
  );

  const { rows: history } = await db.query(
    `SELECT points, reason, transaction_id, created_at
     FROM points_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user.id]
  );

  const balance = balanceRows[0].balance;
  const nextMilestone = (Math.floor(balance / 50) + 1) * 50;

  res.json({
    balance,
    randValue: balance,
    nextMilestone,
    pointsToNextMilestone: nextMilestone - balance,
    history,
  });
}));

router.get('/me/transactions', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, subtotal, savings_estimate, points_awarded, status, created_at
     FROM transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  res.json({ transactions: rows });
}));

module.exports = router;
module.exports.computeBasket = computeBasket;
module.exports.POINTS_RATE = POINTS_RATE;
