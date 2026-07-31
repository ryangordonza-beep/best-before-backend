// seed.js
// Populates a handful of real products (from best-before.co.za's own
// homepage) with made-up-but-plausible competitor prices, so you can run
// the whole app end-to-end before wiring up WooCommerce sync / a real
// competitor price spreadsheet.
//
// Run with: npm run seed

const db = require('./db');

const products = [
  {
    barcode: '5900649080515',
    name: 'Mokate - Cappuccino Choc Hazelnut (10x22g)',
    image_url: 'https://www.best-before.co.za/wp-content/uploads/2023/05/5900649080515-300x300.jpg',
    bb_price: 49.0,
    bb_url: 'https://www.best-before.co.za/product/product-9/',
  },
  {
    barcode: '6009900124117',
    name: 'Sunshine Sugar - Brown (1kg)',
    image_url: 'https://www.best-before.co.za/wp-content/uploads/2023/11/6009900124117-300x300.jpg',
    bb_price: 25.0,
    bb_url: 'https://www.best-before.co.za/product/sunshine-sugar-brown-1kg/',
  },
  {
    barcode: '6009710390153',
    name: 'Flora Margarine (500g)',
    image_url: 'https://www.best-before.co.za/wp-content/uploads/2026/07/6009710390153-300x300.jpg',
    bb_price: 39.0,
    bb_url: 'https://www.best-before.co.za/product/flora-margarine-500g/',
  },
  {
    barcode: '6959183300350',
    name: 'Aloe Toothpaste - Cool Mint (105g)',
    image_url: 'https://www.best-before.co.za/wp-content/uploads/2023/04/6959183300350-300x300.jpg',
    bb_price: 12.0,
    bb_url: 'https://www.best-before.co.za/product/aloe-toothpaste-cool-mint-105g/',
  },
];

const competitorPrices = [
  // Mokate cappuccino
  { barcode: '5900649080515', retailer: 'Pick n Pay', price: 74.99 },
  { barcode: '5900649080515', retailer: 'Checkers', price: 79.99 },
  { barcode: '5900649080515', retailer: 'Woolworths', price: 89.0 },
  { barcode: '5900649080515', retailer: 'Spar', price: 78.5 },

  // Sunshine Sugar
  { barcode: '6009900124117', retailer: 'Pick n Pay', price: 34.99 },
  { barcode: '6009900124117', retailer: 'Checkers', price: 33.99 },
  { barcode: '6009900124117', retailer: 'Spar', price: 36.0 },

  // Flora Margarine
  { barcode: '6009710390153', retailer: 'Pick n Pay', price: 54.99 },
  { barcode: '6009710390153', retailer: 'Checkers', price: 52.99 },
  { barcode: '6009710390153', retailer: 'Woolworths', price: 59.99 },
  { barcode: '6009710390153', retailer: 'Spar', price: 55.5 },

  // Aloe toothpaste
  { barcode: '6959183300350', retailer: 'Pick n Pay', price: 24.99 },
  { barcode: '6959183300350', retailer: 'Checkers', price: 22.99 },
];

const upsertProduct = db.prepare(`
  INSERT INTO products (barcode, name, image_url, bb_price, bb_url)
  VALUES (@barcode, @name, @image_url, @bb_price, @bb_url)
  ON CONFLICT(barcode) DO UPDATE SET
    name=excluded.name, image_url=excluded.image_url,
    bb_price=excluded.bb_price, bb_url=excluded.bb_url, updated_at=datetime('now')
`);

const insertPrice = db.prepare(`
  INSERT INTO competitor_prices (barcode, retailer, price, source, verified)
  VALUES (?, ?, ?, 'admin', 1)
`);

const clearPrices = db.prepare(`DELETE FROM competitor_prices WHERE source = 'admin'`);

const tx = db.transaction(() => {
  products.forEach((p) => upsertProduct.run(p));
  clearPrices.run();
  competitorPrices.forEach((c) => insertPrice.run(c.barcode, c.retailer, c.price));
});
tx();

console.log(`Seeded ${products.length} products and ${competitorPrices.length} competitor prices.`);
console.log('Try scanning/looking up barcode 5900649080515 once the app is running.');
