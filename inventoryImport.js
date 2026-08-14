// inventoryImport.js
const XLSX = require('xlsx');

function parsePrice(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Math.round(raw * 100) / 100;
  const cleaned = String(raw).replace(/[R\s]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : Math.round(num * 100) / 100;
}

function titleCase(desc) {
  return String(desc || '')
    .trim()
    .replace(/\s*-\s*/g, ' - ')
    .split(' ')
    .map((w) => (w === '-' ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function parseInventoryExport(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const products = [];
  const skipped = [];
  const seenBarcodes = new Set();

  rows.forEach((row, i) => {
    const rowNum = i + 2;

    if (row['Inventory Type'] === 'Kit Item') {
      skipped.push({ row: rowNum, reason: 'Kit Item (wholesale case, not a retail unit)' });
      return;
    }

    if (row['Active'] === false || row['Active'] === 'FALSE' || row['Active'] === 0) {
      skipped.push({ row: rowNum, reason: 'Marked inactive' });
      return;
    }

    const upcRaw = row['UPC'];
    const barcode = upcRaw != null ? String(Math.trunc(Number(upcRaw))) : null;
    if (!barcode || !/^\d{8,14}$/.test(barcode)) {
      skipped.push({ row: rowNum, reason: `Invalid/missing barcode (${upcRaw})` });
      return;
    }
    if (seenBarcodes.has(barcode)) {
      skipped.push({ row: rowNum, reason: `Duplicate barcode (${barcode})` });
      return;
    }

    const price = parsePrice(row['Price with Tax']);
    if (price == null || price <= 0) {
      skipped.push({ row: rowNum, reason: `Invalid price (${row['Price with Tax']})` });
      return;
    }

    const desc = row['Desc 1'];
    if (!desc) {
      skipped.push({ row: rowNum, reason: 'Missing description' });
      return;
    }

    const size = row['Item Size'] != null ? String(row['Item Size']).trim() : '';
    const name = size ? `${titleCase(desc)} (${size})` : titleCase(desc);

    seenBarcodes.add(barcode);
    products.push({ barcode, name, bb_price: price });
  });

  return { products, skipped };
}

module.exports = { parseInventoryExport };
