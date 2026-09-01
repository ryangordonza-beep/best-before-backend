// sync.js
const fetch = require('node-fetch');
const db = require('./db');

async function syncFromWooCommerce() {
  const base = process.env.WC_STORE_URL;
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;

  if (!base || !key || !secret) {
    throw new Error(
      'Missing WC_STORE_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET in .env — see .env.example'
    );
  }

  let page = 1;
  let total = 0;
  let skippedNoBarcode = 0;

  while (true) {
    const url =
      `${base.replace(/\/$/, '')}/wp-json/wc/v3/products` +
      `?per_page=100&page=${page}&consumer_key=${key}&consumer_secret=${secret}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`WooCommerce API error ${resp.status}: ${await resp.text()}`);
    }
    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) break;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const p of items) {
        const barcode = (p.sku || '').trim();
        if (!/^\d{8,14}$/.test(barcode)) {
          skippedNoBarcode += 1;
          continue;
        }

        await client.query(
          `INSERT INTO products (barcode, name, image_url, bb_price, bb_url, in_stock, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (barcode) DO UPDATE SET
             name = EXCLUDED.name,
             image_url = EXCLUDED.image_url,
             bb_price = EXCLUDED.bb_price,
             bb_url = EXCLUDED.bb_url,
             in_stock = EXCLUDED.in_stock,
             updated_at = NOW()`,
          [
            barcode,
            p.name,
            p.images && p.images[0] ? p.images[0].src : null,
            parseFloat(p.price || p.regular_price || '0'),
            p.permalink,
            p.stock_status === 'instock' ? 1 : 0,
          ]
        );
        total += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    page += 1;
  }

  return { productsSynced: total, skippedNoBarcode };
}

module.exports = { syncFromWooCommerce };
