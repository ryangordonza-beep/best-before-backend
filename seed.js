// seed.js
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
  { barcode: '5900649080515', retailer: 'Pick n Pay', price: 74.99 },
  { barcode: '5900649080515', retailer: 'Checkers', price: 79.99 },
  { barcode: '5900649080515', retailer: 'Woolworths', price: 89.0 },
  { barcode: '5900649080515', retailer: 'Spar', price: 78.5 },

  { barcode: '6009900124117', retailer: 'Pick n Pay', price: 34.99 },
  { barcode: '6009900124117', retailer: 'Checkers', price: 33.99 },
  { barcode: '6009900124117', retailer: 'Spar', price: 36.0 },

  { barcode: '6009710390153', retailer: 'Pick n Pay', price: 54.99 },
  { barcode: '6009710390153', retailer: 'Checkers', price: 52.99 },
  { barcode: '6009710390153', retailer: 'Woolworths', price: 59.99 },
  { barcode: '6009710390153', retailer: 'Spar', price: 55.5 },

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

// Real Best Before catalogue — 60 single-unit retail products, parsed
// from an actual inventory export (Mark_Item_List_Examples_with_Barcodes.xlsx).
// Wholesale case/"Kit Item" SKUs were deliberately excluded. Most of
// these are Best Before's own import/clearance brands — genuine
// business advantage, but it also means most won't exist under the
// same barcode at Pick n Pay/Checkers/Woolworths/Spar to compare
// against. Horlicks and Corn Thins are the realistic exceptions.
const realCatalogue = [
  { barcode: '9555555300439', name: 'Bon Chef - Panko Bread Crumbs (1KG)', bb_price: 89.0 },
  { barcode: '8002720003028', name: 'Bonomi - Bihappy Ladyfinger Bis (200G)', bb_price: 44.0 },
  { barcode: '6009710171127', name: 'Bounty - Coarse Sea Salt Grinde (100G)', bb_price: 17.0 },
  { barcode: '8032993730352', name: 'Bravo Chef - Black Beans (400G)', bb_price: 19.0 },
  { barcode: '8032993730741', name: 'Bravo Chef - Chopped Tomatoes (400G)', bb_price: 22.0 },
  { barcode: '8032993731083', name: 'Bravo Chef - Lentils (400G)', bb_price: 16.0 },
  { barcode: '8032993730017', name: 'Bravo Chef - Whole Peeled Toma (400G)', bb_price: 12.0 },
  { barcode: '6009704913917', name: 'Chef Professional - Easy Cook S (300ML)', bb_price: 42.0 },
  { barcode: '6009704913924', name: 'Chef Professional - Easy Cook S (500ML)', bb_price: 59.0 },
  { barcode: '9322969000978', name: 'Corn Thins - Sour Cream (125G)', bb_price: 29.0 },
  { barcode: '9322969000039', name: 'Corn Thins Multigrain (150G)', bb_price: 29.0 },
  { barcode: '9322969000022', name: 'Corn Thins - Soy Linseed Chia (150G)', bb_price: 29.0 },
  { barcode: '9322969000961', name: 'Corn Thins - Tasty Cheese (150G)', bb_price: 29.0 },
  { barcode: '6009712410361', name: 'Daily Fix Choc Delight Granola (700G)', bb_price: 65.0 },
  { barcode: '6009712410347', name: 'Daily Fix Trop Crunch Granola (700G)', bb_price: 65.0 },
  { barcode: '3563490012627', name: 'Dijona - Strong Dijon (370G)', bb_price: 49.0 },
  { barcode: '3563490012634', name: 'Dijona - Wholgrain Mustard (350G)', bb_price: 49.0 },
  { barcode: '6004976004615', name: 'Everyday - Apricot Jam (520G)', bb_price: 28.0 },
  { barcode: '6004976002321', name: 'Everyday - Mixed Vegetables (410G)', bb_price: 17.0 },
  { barcode: '6004976002383', name: 'Everyday - Tomato & Onion Mix (410G)', bb_price: 16.0 },
  { barcode: '9310155610506', name: 'Fantastic - Beef Cup Noodles (70G)', bb_price: 21.0 },
  { barcode: '9310155630504', name: 'Fantastic - Chicken Corn Cup No (70G)', bb_price: 21.0 },
  { barcode: '9310155620505', name: 'Fantastic - Chicken Cup Noodles (70G)', bb_price: 21.0 },
  { barcode: '9310155680509', name: 'Fantastic - Oriental Cup Noodle (70G)', bb_price: 21.0 },
  { barcode: '9310155755702', name: 'Fantico Rice Crack - Smokey Bbq (100G)', bb_price: 29.0 },
  { barcode: '9310155510103', name: 'Fantico Rice Crackers - Bbq (100G)', bb_price: 29.0 },
  { barcode: '9310155520102', name: 'Fantico Rice Crackers - Cheese (100G)', bb_price: 29.0 },
  { barcode: '9310155530101', name: 'Fantico Rice Crackers - Origina (100G)', bb_price: 29.0 },
  { barcode: '9310155754064', name: 'Fantico Rice Crackers - Salt Vi (100G)', bb_price: 29.0 },
  { barcode: '9310155754057', name: 'Fantico Rice Crackers - Wood Ov (100G)', bb_price: 29.0 },
  { barcode: '9310155008372', name: 'Fantico - Sweet Chili Sour Crea (100G)', bb_price: 29.0 },
  { barcode: '658325349252', name: 'Farmhouse Pantry - Rolled Oats (2X1KG)', bb_price: 69.0 },
  { barcode: '6001651461398', name: 'Figado Livers - Creamy Curry (425G)', bb_price: 39.0 },
  { barcode: '6001651292541', name: 'Figado Livers - Spicy Peri Per (425G)', bb_price: 39.0 },
  { barcode: '8012169001301', name: 'Giglio - Canneloni (250G)', bb_price: 35.0 },
  { barcode: '8886467072642', name: 'Horlicks - Malt Drink (400G)', bb_price: 99.0 },
  { barcode: '6009684165245', name: 'Liberty Fruit Nut Muesli (1KG)', bb_price: 59.0 },
  { barcode: '6009684163364', name: 'Liberty Select - Artichoke Quar (390G)', bb_price: 49.0 },
  { barcode: '6009684163340', name: 'Liberty Select - Artichoke Whol (240G)', bb_price: 49.0 },
  { barcode: '6009704914495', name: 'Liberty Select - Baked Beans (410G)', bb_price: 13.0 },
  { barcode: '6009704990550', name: 'Liberty Select - Bulgar Wheat (500G)', bb_price: 25.0 },
  { barcode: '6009684162275', name: 'Liberty Select - Butter Beans (400G)', bb_price: 20.0 },
  { barcode: '6009684162077', name: 'Liberty Select - Castor Sugar (1KG)', bb_price: 37.0 },
  { barcode: '6009684160301', name: 'Liberty Select - Coconut Milk (400ML)', bb_price: 24.0 },
  { barcode: '6009704914693', name: 'Liberty Select - Figs (425G)', bb_price: 32.0 },
  { barcode: '6009710171356', name: 'Liberty Select - Golden Syrup (500G)', bb_price: 39.0 },
  { barcode: '6009684163173', name: 'Liberty Select - Guava Halves (410G)', bb_price: 39.0 },
  { barcode: '6009684160455', name: 'Liberty Select - Heavy Foil 440 (70M)', bb_price: 199.0 },
  { barcode: '6009684162152', name: 'Liberty Select - Icing Sugar (1KG)', bb_price: 37.0 },
  { barcode: '6009684160479', name: 'Liberty Select - Light Foil 440 (70M)', bb_price: 169.0 },
  { barcode: '6009684160486', name: 'Liberty Select - Lychees In Syr (565G)', bb_price: 55.0 },
  { barcode: '6009710171363', name: 'Liberty Select - Maple Syrup (500G)', bb_price: 34.0 },
  { barcode: '6009704914518', name: 'Liberty Select - Mixed Vegetabl (400G)', bb_price: 17.0 },
  { barcode: '6009684165252', name: 'Liberty Select - Original Muesl (1KG)', bb_price: 59.0 },
  { barcode: '6009704914204', name: 'Liberty Select - Plain Poppadum (100G)', bb_price: 22.0 },
  { barcode: '6009684164200', name: 'Liberty Select - Pure Honey (500G)', bb_price: 69.0 },
  { barcode: '6009710170298', name: 'Liberty Select - Pure Honey (1KG)', bb_price: 139.0 },
  { barcode: '6009684161766', name: 'Liberty Select - Quick Oats (1KG)', bb_price: 32.0 },
  { barcode: '6009684163821', name: 'Liberty Select - Red Kidney Bea (400G)', bb_price: 20.0 },
  { barcode: '6009684160387', name: 'Liberty Select - Rolled Oats (1KG)', bb_price: 32.0 },
];

const upsertReal = db.prepare(`
  INSERT INTO products (barcode, name, bb_price)
  VALUES (@barcode, @name, @bb_price)
  ON CONFLICT(barcode) DO UPDATE SET
    name=excluded.name, bb_price=excluded.bb_price, updated_at=datetime('now')
`);
const txReal = db.transaction(() => {
  realCatalogue.forEach((p) => upsertReal.run(p));
});
txReal();
console.log(`Seeded ${realCatalogue.length} real Best Before products from Mark's inventory export.`);

console.log(`Seeded ${products.length} products and ${competitorPrices.length} competitor prices.`);
console.log('Try scanning/looking up barcode 5900649080515 once the app is running.');
