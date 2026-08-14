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

  const upsert = db.prepare(`
    INSERT INTO products (barcode, name, image_url, bb_price, bb_url, in_stock, updated_at)
    VALUES (@barcode, @name, @image_url, @bb_price, @bb_url, @in_stock, datetime('now'))
    ON CONFLICT(barcode) DO UPDATE SET
      name = excluded.name,
      image_url = excluded.image_url,
      bb_price = excluded.bb_price,
      bb_url = excluded.bb_url,
      in_stock = excluded.in_stock,
      updated_at = datetime('now')
  `);

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

    const tx = db.transaction((products) => {
      for (const p of products) {
        const barcode = (p.sku || '').trim();
        if (!/^\d{8,14}$/.test(barcode)) {
          skippedNoBarcode += 1;
          continue;
        }

        upsert.run({
          barcode,
          name: p.name,
          image_url: p.images && p.images[0] ? p.images[0].src : null,
          bb_price: parseFloat(p.price || p.regular_price || '0'),
          bb_url: p.permalink,
          in_stock: p.stock_status === 'instock' ? 1 : 0,
        });
        total += 1;
      }
    });
    tx(items);

    page += 1;
  }

  return { productsSynced: total, skippedNoBarcode };
}

module.exports = { syncFromWooCommerce };
