// ── Source Atlantic — Data Import Script ──
// Reads 4 CSV files and pushes to Firebase (2025–2026 records only)
// Run: node import-data.js

const fs   = require('fs');
const path = require('path');
const https = require('https');

const FB_DB   = 'source-atlantic-sr-default-rtdb.firebaseio.com';
const SR_PATH = 'shipping_receiving';
const DIR     = __dirname;

// ── CSV PARSER (handles quoted fields with commas inside) ──
function parseCSV(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM

  const rows = [];
  let currentRow = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      if (inQuotes && raw[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      currentRow.push(cell.trim()); cell = '';
    } else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && raw[i + 1] === '\n') i++;
      currentRow.push(cell.trim()); cell = '';
      if (currentRow.some(x => x !== '')) rows.push(currentRow);
      currentRow = [];
    } else {
      cell += c;
    }
  }
  if (cell || currentRow.length) { currentRow.push(cell.trim()); if (currentRow.some(x => x !== '')) rows.push(currentRow); }

  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
    return obj;
  });
}

// ── DATE CONVERTER: M/D/YYYY → YYYY-MM-DD ──
function toISODate(d) {
  if (!d) return '';
  const p = d.split('/');
  if (p.length !== 3) return '';
  return p[2].padStart(4,'0') + '-' + p[0].padStart(2,'0') + '-' + p[1].padStart(2,'0');
}

// Accept all valid dates
function inRange(dateISO) {
  return !!dateISO;
}

// Parse money string "$1,532.95" → 1532.95
function parseMoney(s) {
  return parseFloat((s || '').replace(/[$,\s]/g, '')) || 0;
}

// Generate unique import key
let _seq = 0;
function newKey() {
  return '-imp-' + Date.now() + '-' + (++_seq).toString().padStart(5, '0');
}

// ── AREA MAPPING ──
const AREA_MAP = {
  'WELDING':'Welding','ELECTRICAL':'Electrical','MECHANICAL':'Mechanical',
  'AIR COMPRESSOR':'Air Compressor','COMPRESSOR AIR':'Air Compressor',
  'GENERATOR':'Generator','GENERATOR SERVICE':'Generator',
  'COMPRESSOR':'Air Compressor'
};
function mapArea(s) { return AREA_MAP[(s||'').toUpperCase()] || s || ''; }

// ── BIN LOCATION MAPPING ──
function mapBin(bin) {
  const b = (bin || '').toUpperCase().trim();
  if (!b || b === 'NOBIN' || b === 'NO BIN') return { binLocation: '', binStock: '' };
  if (b === 'WIP')   return { binLocation: 'WIP',   binStock: '' };
  return { binLocation: 'Stock', binStock: bin };
}

// ── SERVICE TYPE MAPPING ──
const SVC_MAP = {
  'SALES ORDER':'Sales Order','SERVICE ORDER':'Work Order',
  'WORK ORDER':'Work Order','FOR STOCK':'','':''
};
function mapSvc(s) { return SVC_MAP[(s||'').toUpperCase()] !== undefined ? SVC_MAP[(s||'').toUpperCase()] : (s||''); }

// ═══════════════════════════════════════════════
// 1. EPS Incoming Form → shipping_receiving/incoming
// ═══════════════════════════════════════════════
function parseIncoming() {
  const rows = parseCSV(path.join(DIR, 'EPS Incoming Form.csv'));
  const result = {};
  let skip = 0;

  rows.forEach(r => {
    const date = toISODate(r['Incoming Date']);
    if (!inRange(date)) { skip++; return; }

    const key = newKey();
    result[key] = {
      formNum:             r['Incoming Number']     || '',
      customer:            r['Customer']             || '',
      wo:                  r['Work Order #']         || '',
      prevWo:              r['Previous Work Order #']|| '',
      date,
      equipment:           r['Basic Description']   || '',
      area:                mapArea(r['Department']),
      manufacturer:        r['Manufacturer']         || '',
      modelNumber:         r['Model Number']         || '',
      serialNumber:        r['Serial Number']        || '',
      typeSize:            r['Type/Size']            || '',
      hp:                  r['HP']                   || '',
      rpm:                 r['RPM']                  || '',
      frame:               r['Frame']               || '',
      kw:                  r['KW']                   || '',
      customerStockNumber: r['Customer Stock #']     || '',
      designatedLocation:  r['Designated Location']  || '',
      deliveryBy:          r['Delivered by']         || '',
      receivedBy:          r['Received by']          || '',
      whatToDo:            r['Kind of Job']          || '',
      notes:               r['Comments']             || '',
      _imported: true
    };
  });

  console.log(`  Incoming Forms : ${Object.keys(result).length} records (${skip} skipped (no date))`);
  return result;
}

// ═══════════════════════════════════════════════
// 2. Incoming Items → shipping_receiving/items
//    (group rows by Receipt # into one document)
// ═══════════════════════════════════════════════
function parseItems() {
  const rows = parseCSV(path.join(DIR, 'Incoming Items.csv'));
  const groups = {}; // receipt# → document
  let skip = 0;

  rows.forEach(r => {
    const date = toISODate(r['Receipt']);
    if (!inRange(date)) { skip++; return; }

    const docNum = r['Receipt #'];
    if (!docNum) return;

    if (!groups[docNum]) {
      groups[docNum] = {
        date,
        docNum,
        poNum:       r['PO Number']       || '',
        transferNum: r['Transfer Number'] || '',
        supplier:    r['Supply Name']     || '',
        lineItems:   [],
        _imported: true
      };
    }

    const { binLocation, binStock } = mapBin(r['BIN Location']);

    groups[docNum].lineItems.push({
      material:       r['Short Item Description'] || '',
      pc:             r['Qty Rec']                || '',
      lb:             '',
      rl:             '',
      weightLb:       '',
      weightKg:       '',
      binLocation,
      binStock,
      applicationType: mapSvc(r['Type of Service']),
      salesOrderNum:   r['Sales Order #']         || '',
      workOrderNum:    r['Work Order #']           || '',
      area:            mapArea(r['Area Work Order']),
      customer:        r['Customer Work Order']   || ''
    });
  });

  const result = {};
  Object.values(groups).forEach(doc => { result[newKey()] = doc; });

  console.log(`  Incoming Items : ${Object.keys(result).length} documents (${skip} rows skipped (no date))`);
  return result;
}

// ═══════════════════════════════════════════════
// 3. Daily Cash → shipping_receiving/payments
// ═══════════════════════════════════════════════
function parsePayments() {
  const rows = parseCSV(path.join(DIR, 'Daily Cash.csv'));
  const result = {};
  let skip = 0;

  rows.forEach(r => {
    const date = toISODate(r['Prepared date']);
    if (!date || !inRange(date)) { skip++; return; }

    const methods = [
      { key: 'Cash',       col: 'Cash'       },
      { key: 'Cheque',     col: 'Cheque'     },
      { key: 'Visa',       col: 'Visa'       },
      { key: 'Mastercard', col: 'Mastercard' },
      { key: 'Debit',      col: 'Debit'      }
    ];

    methods.forEach(m => {
      const amt = parseMoney(r[m.col]);
      if (amt <= 0) return;
      result[newKey()] = {
        date,
        method:    m.key,
        amount:    amt.toFixed(2),
        orderType: r['SO/WO ?']               || '',
        orderNum:  r['SO/Work Order Number']   || '',
        chequeNum: m.key === 'Cheque' ? (r['Cheque Number'] || '') : '',
        customer:  '',
        notes:     '',
        _imported: true
      };
    });
  });

  console.log(`  Payments       : ${Object.keys(result).length} records (${skip} rows skipped (no date))`);
  return result;
}

// ═══════════════════════════════════════════════
// 4. Shipment Freight → shipping_receiving/shipping
// ═══════════════════════════════════════════════
function parseShipping() {
  const rows = parseCSV(path.join(DIR, 'Shipment Freight.csv'));
  const result = {};
  let skip = 0;

  rows.forEach(r => {
    const date = toISODate(r['Date']);
    if (!date || !inRange(date)) { skip++; return; }

    const pick = k => (r[k] || '').trim();

    const workOrders  = ['Work Order #','Work Order #2','Work Order #3','Work Order #4','Work Order #5'].map(pick).filter(Boolean);
    const salesOrders = ['Sales Order #','Sales Order #2','Sales Order #3','Sales Order #4','Sales Order #5'].map(pick).filter(Boolean);
    const transferNums = ['Transfer #','Transfer #2'].map(pick).filter(Boolean);

    result[newKey()] = {
      date,
      outgoing:    pick('Outgoing Form'),
      city:        pick('City'),
      province:    pick('Province'),
      postalCode:  pick('Postal Code'),
      country:     pick('Country'),
      pc:          pick('Pieces'),
      lb:          pick('Weight'),
      material:    pick('Description'),
      freightType: pick('Services'),
      workOrders,
      salesOrders,
      transferNums,
      carrier:     pick('Transportation Name'),
      carrierOther:'',
      trackingNum: pick('Airbill Number'),
      notes:       pick('Comments'),
      customer:    pick('Consignee'),
      _imported: true
    };
  });

  console.log(`  Shipping       : ${Object.keys(result).length} records (${skip} rows skipped (no date))`);
  return result;
}

// ═══════════════════════════════════════════════
// PUSH TO FIREBASE (REST API — PATCH)
// ═══════════════════════════════════════════════
function patchFirebase(subPath, data) {
  return new Promise((resolve, reject) => {
    // Split into chunks of 200 keys to avoid huge payloads
    const keys   = Object.keys(data);
    const chunks = [];
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = {};
      keys.slice(i, i + 200).forEach(k => { chunk[k] = data[k]; });
      chunks.push(chunk);
    }

    let idx = 0;
    function next() {
      if (idx >= chunks.length) { resolve(); return; }
      const body = JSON.stringify(chunks[idx++]);
      const opts = {
        hostname: FB_DB,
        path:     `/${SR_PATH}/${subPath}.json`,
        method:   'PATCH',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = https.request(opts, res => {
        let out = '';
        res.on('data', d => out += d);
        res.on('end', () => {
          if (res.statusCode === 200) next();
          else reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0,200)}`));
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    }
    next();
  });
}

// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════
async function main() {
  console.log('\n── Source Atlantic Data Import ──\n');
  console.log('Parsing CSV files...');

  const incoming = parseIncoming();
  const items    = parseItems();
  const payments = parsePayments();
  const shipping = parseShipping();

  const total = Object.keys(incoming).length + Object.keys(items).length +
                Object.keys(payments).length + Object.keys(shipping).length;
  console.log(`\nTotal records to import: ${total}`);
  console.log('\nPushing to Firebase...');

  try {
    process.stdout.write('  Incoming Forms ... ');
    await patchFirebase('incoming', incoming);
    console.log('✓');

    process.stdout.write('  Incoming Items ... ');
    await patchFirebase('items', items);
    console.log('✓');

    process.stdout.write('  Payments       ... ');
    await patchFirebase('payments', payments);
    console.log('✓');

    process.stdout.write('  Shipping       ... ');
    await patchFirebase('shipping', shipping);
    console.log('✓');

    console.log('\n✅  Import complete! All records are now in the app.\n');
  } catch (e) {
    console.error('\n❌  Error:', e.message);
    console.error('   Check that Firebase Database Rules allow public writes,');
    console.error('   or contact support.\n');
  }
}

main();
