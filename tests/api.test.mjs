// Automated API test suite — run with:  npm test   (from inventory-backend)
//
// Starts the API on a spare port (NODE_ENV=production) against the database in .env.
// Every record it creates is tagged (__QA__ titles / Material IDs, QAZ… currency codes) and
// removed before and after the run. Existing records are only read, never changed.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..');
process.chdir(backendDir);
require('dotenv').config({ path: path.join(backendDir, '.env'), quiet: true });
const db = require('../config/db');
const serverPricing = require('../utils/pricing');
const front = await import(pathToFileURL(path.resolve(backendDir, '../inventory-frontend/src/utils/templateData.js')).href);

const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN_OK = 'http://localhost:5173';
let server;

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
};

const cleanup = async () => {
  await db.query("DELETE FROM templates WHERE template_title LIKE '\\_\\_QA\\_\\_%'");
  // Any template in a test currency, whatever its title (e.g. a rejected-title test that slipped through)
  await db.query("DELETE t FROM templates t JOIN currencies c ON c.currency_id = t.currency_id WHERE c.currency_code LIKE 'QAZ%'");
  await db.query("DELETE FROM materials WHERE material_id LIKE '\\_\\_QA\\_\\_%'");
  await db.query("DELETE FROM supplier_details WHERE company_name LIKE '\\_\\_QA\\_\\_%'");
  // Sheet imports keep their own supplier IDs (QA uses 99xxxx); put the next automatic ID back
  // to max+1 so test IDs never leave a gap in real numbering
  await db.query('ALTER TABLE supplier_details AUTO_INCREMENT = 1');
  await db.query("DELETE FROM currencies WHERE currency_code LIKE 'QAZ%'");
};

// Shared fixtures created in before()
const fx = {};

before(async () => {
  await cleanup();
  server = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/')).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Two test currencies and one item in each (same Material ID + Item Code)
  const c1 = await api('POST', '/api/currencies', { currency_code: 'QAZA', currency_name: 'QA Alpha', symbol: 'α', decimal_places: 2 });
  const c2 = await api('POST', '/api/currencies', { currency_code: 'QAZB', currency_name: 'QA Beta', decimal_places: 0 });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  fx.curA = c1.body.currency_id;
  fx.curB = c2.body.currency_id;
  const m1 = await api('POST', '/api/materials', { material_id: '__QA__M1', item_code: 'QA-1', currency_id: fx.curA, product_name: 'QA Drill A', max_retail_price: 100, purchase_discount: 10 });
  const m2 = await api('POST', '/api/materials', { material_id: '__QA__M1', item_code: 'QA-1', currency_id: fx.curB, product_name: 'QA Drill B', max_retail_price: 5000, purchase_discount: 0 });
  assert.equal(m1.status, 201, JSON.stringify(m1.body));
  assert.equal(m2.status, 201, JSON.stringify(m2.body));
  fx.matA = m1.body.id;
  fx.matB = m2.body.id;
});

after(async () => {
  await cleanup();
  server?.kill();
  await db.end();
});

const baseTemplate = (overrides = {}) => ({
  template_title: '__QA__ template',
  currency_id: fx.curA,
  sections: [{ section_name: 'S1', items: [{ material_id: fx.matA, product_name: 'QA Drill A', quantity: 2, unit_price: 90 }] }],
  ...overrides
});

// ---------------------------------------------------------------------------------------------
describe('HTTP hardening', () => {
  test('unknown route returns JSON 404', async () => {
    const r = await api('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.success, false);
  });
  test('malformed JSON returns 400, not 500', async () => {
    const r = await api('POST', '/api/templates', '{bad json');
    assert.equal(r.status, 400);
  });
  test('oversized body returns 413', async () => {
    const r = await api('POST', '/api/materials/import', { items: [{ x: 'a'.repeat(6 * 1024 * 1024) }] });
    assert.equal(r.status, 413);
  });
  test('security headers present, framework header hidden', async () => {
    const r = await api('GET', '/api/currencies');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  test('API responses are not cached (pricing data)', async () => {
    const r = await api('GET', '/api/templates');
    assert.match(r.headers.get('cache-control') || '', /no-store/);
  });
  test('CORS allows the frontend origin only', async () => {
    const ok = await api('GET', '/api/currencies', undefined, { Origin: ORIGIN_OK });
    const bad = await api('GET', '/api/currencies', undefined, { Origin: 'https://evil.example' });
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN_OK);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
  test('non-numeric / injection-like ids are rejected with 400', async () => {
    for (const id of ['abc', '1%20OR%201=1', '-5', '0', '1.5']) {
      assert.equal((await api('GET', `/api/templates/${id}`)).status, 400, id);
      assert.equal((await api('GET', `/api/materials/${id}`)).status, 400, id);
    }
  });
  test('production responses never include database error details', async () => {
    const r = await api('POST', '/api/templates', baseTemplate({ sections: 'x' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, undefined);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Currencies', () => {
  test('lower-case code is stored upper-case; duplicate code is 409', async () => {
    const r = await api('POST', '/api/currencies', { currency_code: 'qazc', currency_name: 'QA Gamma' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const dup = await api('POST', '/api/currencies', { currency_code: 'QAZC', currency_name: 'again' });
    assert.equal(dup.status, 409);
  });
  test('invalid code, name and decimals are rejected', async () => {
    const r = await api('POST', '/api/currencies', { currency_code: 'Q1', currency_name: '', decimal_places: 5 });
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.length >= 3);
  });
  test('update needs the current version; a stale version is refused', async () => {
    const c = await api('POST', '/api/currencies', { currency_code: 'QAZD', currency_name: 'QA Delta' });
    const ok = await api('PUT', `/api/currencies/${c.body.currency_id}`, { currency_code: 'QAZD', currency_name: 'QA Delta 2', version: 1 });
    assert.equal(ok.status, 200);
    const stale = await api('PUT', `/api/currencies/${c.body.currency_id}`, { currency_code: 'QAZD', currency_name: 'QA Delta 3', version: 1 });
    assert.equal(stale.status, 409);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Items (materials)', () => {
  test('currency is required and must exist', async () => {
    assert.equal((await api('POST', '/api/materials', { material_id: '__QA__X1', product_name: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/materials', { material_id: '__QA__X1', product_name: 'x', currency_id: 999999 })).status, 400);
  });
  test('new items cannot use an inactive currency', async () => {
    const c = await api('POST', '/api/currencies', { currency_code: 'QAZE', currency_name: 'QA Off', is_active: false });
    const r = await api('POST', '/api/materials', { material_id: '__QA__X2', product_name: 'x', currency_id: c.body.currency_id });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
  test('same Material ID allowed once per currency', async () => {
    const dup = await api('POST', '/api/materials', { material_id: '__QA__M1', currency_id: fx.curA, product_name: 'dup' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.message, /QAZA/);
  });
  test('numbers must be plain decimals (no hex, booleans, arrays, negatives, overflow)', async () => {
    for (const bad of ['0x10', true, [5], -1, 123456789012, '1,000']) {
      const r = await api('POST', '/api/materials', { material_id: '__QA__N', product_name: 'n', currency_id: fx.curA, max_retail_price: bad });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
    }
  });
  test('text limits enforced', async () => {
    const r = await api('POST', '/api/materials', { material_id: '__QA__' + 'x'.repeat(60), product_name: 'y'.repeat(151), currency_id: fx.curA });
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.length >= 2);
  });
  test('script / SQL text is stored literally and changes nothing else', async () => {
    const before = (await db.query('SELECT COUNT(*) n FROM materials'))[0][0].n;
    const evil = "<img src=x onerror=alert(1)>'; DROP TABLE materials; --";
    const r = await api('POST', '/api/materials', { material_id: '__QA__XSS', product_name: evil, currency_id: fx.curA });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const read = await api('GET', `/api/materials/${r.body.id}`);
    assert.equal(read.body.data.product_name, evil);
    assert.equal((await db.query('SELECT COUNT(*) n FROM materials'))[0][0].n, before + 1);
  });
  test('update needs the current version; a stale version is refused', async () => {
    const m = await api('POST', '/api/materials', { material_id: '__QA__V', product_name: 'v', currency_id: fx.curA });
    const item = (await api('GET', `/api/materials/${m.body.id}`)).body.data;
    assert.equal((await api('PUT', `/api/materials/${m.body.id}`, { ...item, product_name: 'v2' })).status, 200);
    assert.equal((await api('PUT', `/api/materials/${m.body.id}`, { ...item, product_name: 'v3' })).status, 409);
  });
  test("an item used in templates can't move to another currency", async () => {
    const m = await api('POST', '/api/materials', { material_id: '__QA__U', product_name: 'used', currency_id: fx.curA });
    const t = await api('POST', '/api/templates', baseTemplate({ template_title: '__QA__ uses item', sections: [{ items: [{ material_id: m.body.id, quantity: 1, unit_price: 1 }] }] }));
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const item = (await api('GET', `/api/materials/${m.body.id}`)).body.data;
    const r = await api('PUT', `/api/materials/${m.body.id}`, { ...item, currency_id: fx.curB });
    assert.equal(r.status, 409, JSON.stringify(r.body));
  });
  test('bulk edit: locked fields ignored, invalid row means nothing saved, stale row refused', async () => {
    const m = await api('POST', '/api/materials', { material_id: '__QA__B', item_code: 'B', product_name: 'bulk', currency_id: fx.curA });
    const item = (await api('GET', `/api/materials/${m.body.id}`)).body.data;
    const bad = await api('PUT', '/api/materials/bulk', { items: [{ ...item, product_name: 'ok' }, { id: fx.matA, version: 1, product_name: '' }] });
    assert.equal(bad.status, 400);
    assert.equal((await api('GET', `/api/materials/${m.body.id}`)).body.data.product_name, 'bulk', 'nothing should be saved');
    const ok = await api('PUT', '/api/materials/bulk', { items: [{ ...item, material_id: 'HACK', item_code: 'HACK', currency_id: fx.curB, product_name: 'bulk2' }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = (await api('GET', `/api/materials/${m.body.id}`)).body.data;
    assert.deepEqual([after.material_id, after.item_code, after.currency_id, after.product_name], ['__QA__B', 'B', fx.curA, 'bulk2']);
    const stale = await api('PUT', '/api/materials/bulk', { items: [{ ...item, product_name: 'bulk3' }] });
    assert.equal(stale.status, 409);
  });
  test('import: by currency code, per-currency duplicates, in-file repeats, unknown currency', async () => {
    const r = await api('POST', '/api/materials/import', { items: [
      { row: 2, material_id: '__QA__I1', currency_code: 'qaza', product_name: 'i1' },
      { row: 3, material_id: '__QA__I1', currency_code: 'QAZA', product_name: 'repeat' },
      { row: 4, material_id: '__QA__M1', currency_code: 'QAZA', product_name: 'exists' },
      { row: 5, material_id: '__QA__I2', currency_code: 'NOPE', product_name: 'x' }
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.inserted.map((i) => i.material_id), ['__QA__I1']);
    assert.equal(r.body.duplicates.length, 1);
    assert.deepEqual(r.body.errors.map((e) => e.row).sort(), [3, 5]);
  });
  test('import row cap', async () => {
    const items = Array.from({ length: 2001 }, (_, i) => ({ material_id: `__QA__C${i}`, currency_code: 'QAZA', product_name: 'c' }));
    assert.equal((await api('POST', '/api/materials/import', { items })).status, 400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Suppliers', () => {
  test('create: blank status means Active; the database assigns the ID', async () => {
    const r = await api('POST', '/api/suppliers', { company_name: '__QA__ Supplier One', email: 'a@b.co', lead_time_days: 0 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const s = (await api('GET', '/api/suppliers')).body.data.find((x) => x.supplier_id === r.body.supplier_id);
    assert.equal(s.status, 'Active');
    assert.equal(Number(s.lead_time_days), 0);
    assert.equal(Number(s.item_count), 0);
  });
  test('invalid name, email, lead time and status are rejected', async () => {
    const r = await api('POST', '/api/suppliers', { company_name: '', email: 'not-an-email', lead_time_days: -3, status: 'Maybe' });
    assert.equal(r.status, 400);
    assert.equal(r.body.errors.length, 4, JSON.stringify(r.body.errors));
  });
  test('update needs the current version; stale is 409, missing is 400, unknown id is 404', async () => {
    const c = await api('POST', '/api/suppliers', { company_name: '__QA__ Supplier V' });
    const id = c.body.supplier_id;
    assert.equal((await api('PUT', `/api/suppliers/${id}`, { company_name: '__QA__ Supplier V2', status: 'Inactive', version: 1 })).status, 200);
    assert.equal((await api('PUT', `/api/suppliers/${id}`, { company_name: '__QA__ Supplier V3', version: 1 })).status, 409);
    assert.equal((await api('PUT', `/api/suppliers/${id}`, { company_name: '__QA__ Supplier V3' })).status, 400);
    assert.equal((await api('PUT', '/api/suppliers/99999999', { company_name: '__QA__ none', version: 1 })).status, 404);
    const s = (await api('GET', '/api/suppliers')).body.data.find((x) => x.supplier_id === id);
    assert.deepEqual([s.company_name, s.status, s.version], ['__QA__ Supplier V2', 'Inactive', 2]);
  });
  test('a supplier created in the Suppliers tab is usable for a new item straight away', async () => {
    const s = await api('POST', '/api/suppliers', { company_name: '__QA__ Supplier Tab' });
    const dropdown = (await api('GET', '/api/materials/suppliers')).body.data;
    assert.ok(dropdown.some((x) => x.supplier_id === s.body.supplier_id), 'new supplier missing from item dropdown list');
    const m = await api('POST', '/api/materials', { material_id: '__QA__ST1', product_name: 'tab', currency_id: fx.curA, supplier_id: s.body.supplier_id });
    assert.equal(m.status, 201, JSON.stringify(m.body));
  });
});

// ---------------------------------------------------------------------------------------------
// The sample workbook's Currencies / Suppliers sheets: new rows are created, then the Items
// sheet can use them in the same import.
describe('Excel import with Currencies and Suppliers sheets', () => {
  const sheet = () => ({
    currencies: [{ row: 5, currency_code: 'qazs', currency_name: 'QA Sheet Money', symbol: 'Ş', decimal_places: 0, status: 'Active' }],
    suppliers: [{ row: 7, supplier_id: 990001, company_name: '__QA__ Sheet Supplier', email: 'x@y.co', lead_time_days: 14, status: '' }],
    items: [
      { row: 2, material_id: '__QA__SH1', currency_code: 'QAZS', supplier_id: 990001, product_name: 'sheet item', max_retail_price: 1000, purchase_discount: 10 },
      { row: 3, material_id: '__QA__SH2', currency_code: 'QAZA', supplier_id: '990001', product_name: 'existing currency, new supplier' }
    ]
  });

  test('new currency + new supplier (with its sheet ID) + items using them, in one import', async () => {
    const r = await api('POST', '/api/materials/import', sheet());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.currencies.map((c) => [c.currency_code, c.result]), [['QAZS', 'created']]);
    assert.deepEqual(r.body.suppliers.map((s) => [s.supplier_id, s.result]), [[990001, 'created']]);
    assert.deepEqual(r.body.inserted.map((i) => i.material_id), ['__QA__SH1', '__QA__SH2'], JSON.stringify(r.body.errors));

    const cur = (await api('GET', '/api/currencies')).body.data.find((c) => c.currency_code === 'QAZS');
    assert.ok(cur, 'new currency not listed');
    assert.equal(Number(cur.is_active), 1);
    const sup = (await api('GET', '/api/suppliers')).body.data.find((s) => s.supplier_id === 990001);
    assert.deepEqual([sup.company_name, sup.status, Number(sup.item_count)], ['__QA__ Sheet Supplier', 'Active', 2]);

    const [[item]] = await db.query("SELECT supplier_id, currency_id, max_retail_price, purchase_discount FROM materials WHERE material_id = '__QA__SH1'");
    assert.deepEqual([item.supplier_id, item.currency_id, Number(item.max_retail_price), Number(item.purchase_discount)], [990001, cur.currency_id, 1000, 10]);

    // Both are now offered when adding an item by hand
    assert.ok((await api('GET', '/api/materials/suppliers')).body.data.some((s) => s.supplier_id === 990001));
    const manual = await api('POST', '/api/materials', { material_id: '__QA__SH3', product_name: 'manual', currency_id: cur.currency_id, supplier_id: 990001 });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
  });

  test('importing the same workbook again changes nothing (existing rows left as they are)', async () => {
    const r = await api('POST', '/api/materials/import', sheet());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.currencies.map((c) => c.result), ['existing']);
    assert.deepEqual(r.body.suppliers.map((s) => s.result), ['existing']);
    assert.equal(r.body.inserted.length, 0);
    assert.equal(r.body.duplicates.length, 2);
  });

  test('a supplier ID already used by another company is refused, and items pointing at it fail', async () => {
    const r = await api('POST', '/api/materials/import', {
      suppliers: [{ row: 2, supplier_id: 990001, company_name: '__QA__ Someone Else' }],
      items: [{ row: 2, material_id: '__QA__SH4', currency_code: 'QAZA', supplier_id: 990009, product_name: 'unknown supplier' }]
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.suppliers[0].result, 'error');
    assert.match(r.body.suppliers[0].messages[0], /already used by "__QA__ Sheet Supplier"/);
    assert.equal(r.body.inserted.length, 0);
    assert.equal(r.body.errors.length, 1);
  });

  test('sheet Status is kept: Inactive supplier / currency are created inactive; bad values refused', async () => {
    const r = await api('POST', '/api/materials/import', {
      currencies: [
        { row: 2, currency_code: 'QAZT', currency_name: 'QA Off', status: 'inactive' },
        { row: 3, currency_code: 'QAZU', currency_name: 'QA Bad', status: 'sometimes' }
      ],
      suppliers: [
        { row: 2, supplier_id: 990002, company_name: '__QA__ Retired', status: 'Inactive' },
        { row: 3, supplier_id: 990003, company_name: '__QA__ Bad Status', status: 'paused' }
      ],
      items: [{ row: 2, material_id: '__QA__SH5', currency_code: 'QAZT', product_name: 'inactive currency' }]
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.currencies.map((c) => c.result), ['created', 'error']);
    assert.deepEqual(r.body.suppliers.map((s) => s.result), ['created', 'error']);
    assert.equal(r.body.errors.length, 1, 'new items must not use an inactive currency');
    const sup = (await api('GET', '/api/suppliers')).body.data.find((s) => s.supplier_id === 990002);
    assert.equal(sup.status, 'Inactive');
    const cur = (await api('GET', '/api/currencies')).body.data.find((c) => c.currency_code === 'QAZT');
    assert.equal(Number(cur.is_active), 0);
  });

  test('supplier IDs out of range are row errors, not server errors', async () => {
    const r = await api('POST', '/api/materials/import', {
      suppliers: [
        { row: 2, supplier_id: 3000000000, company_name: '__QA__ Huge' },
        { row: 3, supplier_id: 'abc', company_name: '__QA__ Text' },
        { row: 4, supplier_id: 0, company_name: '__QA__ Zero' }
      ]
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.suppliers.map((s) => s.result), ['error', 'error', 'error']);
  });

  test('sheet lists must be lists, and have a row cap', async () => {
    assert.equal((await api('POST', '/api/materials/import', { suppliers: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/materials/import', {})).status, 400);
    const many = Array.from({ length: 1001 }, (_, i) => ({ currency_code: 'QAZ' + i, currency_name: 'n' }));
    assert.equal((await api('POST', '/api/materials/import', { currencies: many })).status, 400);
  });

  test('database refuses an item whose supplier does not exist (foreign key, migration 008)', async () => {
    await assert.rejects(
      db.query("INSERT INTO materials (material_id, product_name, currency_id, supplier_id) VALUES ('__QA__FK', 'fk', ?, 99999999)", [fx.curA]),
      /foreign key/i
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('Templates', () => {
  test('full save round-trip with every section', async () => {
    const r = await api('POST', '/api/templates', baseTemplate({
      description: 'notes',
      spec_lines: [{ line_title: 'Panels', line_details: '4 × 620W' }, { line_title: 'Warranty', line_details: '' }],
      additional_costs: [{ cost_name: 'Commission', calc_mode: 'percent', percentage: 1 }, { cost_name: 'Discount', calc_mode: 'amount', amount: -1 }],
      section2_additions: [{ addition_name: 'GP', percentage: 15, include_in_cash_price: true }, { addition_name: 'RM', percentage: 5, include_in_cash_price: false }],
      solution_price_override: 250
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = (await api('GET', `/api/templates/${r.body.template_id}`)).body.data;
    assert.equal(d.currency_code, 'QAZA');
    assert.equal(d.spec_lines.length, 2);
    assert.equal(d.additional_costs.length, 2);
    assert.equal(d.section2_additions.length, 2);
    // 180 + 1.80 - 1 = 180.80 ; ×1.15 = 207.92 ; ×1.05 = 218.32 ; cash = 207.92 ; quote 250
    assert.equal(Number(d.grand_total), 250);
    assert.equal(Number(d.cash_price), 207.92);
    assert.equal(Number(d.section2_additions[1].amount), 10.4);
  });
  test('client-sent totals are ignored; the server recalculates', async () => {
    const r = await api('POST', '/api/templates', baseTemplate({ grand_total: 1, cash_price: 1, section2_additions: [{ addition_name: 'GP', percentage: 10 }] }));
    const d = (await api('GET', `/api/templates/${r.body.template_id}`)).body.data;
    assert.equal(Number(d.grand_total), 198);
  });
  test('currency must match every inventory line', async () => {
    const r = await api('POST', '/api/templates', baseTemplate({ currency_id: fx.curB }));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /not in QAZB/);
  });
  test('missing currency / missing item / no sections are refused', async () => {
    assert.equal((await api('POST', '/api/templates', baseTemplate({ currency_id: null }))).status, 400);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ sections: [{ items: [{ material_id: 99999999, quantity: 1, unit_price: 1 }] }] }))).status, 400);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ sections: [] }))).status, 400);
  });
  test('row caps: sections, Section 1, Section 2, spec lines', async () => {
    const many = (n, f) => Array.from({ length: n }, f);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ sections: many(101, () => ({ items: [] })) }))).status, 400);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ additional_costs: many(21, () => ({ cost_name: 'c', percentage: 1 })) }))).status, 400);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ section2_additions: many(11, () => ({ addition_name: 'r', percentage: 1 })) }))).status, 400);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ spec_lines: many(21, () => ({ line_title: 't' })) }))).status, 400);
  });
  test('negative totals are refused', async () => {
    assert.equal((await api('POST', '/api/templates', baseTemplate({ additional_costs: [{ cost_name: 'd', calc_mode: 'amount', amount: -1000 }] }))).status, 400);
    assert.equal((await api('POST', '/api/templates', baseTemplate({ section2_additions: [{ addition_name: 'd', calc_mode: 'amount', amount: -1000 }] }))).status, 400);
  });
  test('"In cash" flag only accepts real booleans (string "false" is not true)', async () => {
    const r = await api('POST', '/api/templates', baseTemplate({ section2_additions: [{ addition_name: 'RM', percentage: 10, include_in_cash_price: 'false' }] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = (await api('GET', `/api/templates/${r.body.template_id}`)).body.data;
    assert.equal(Number(d.section2_additions[0].include_in_cash_price), 0);
    assert.equal(Number(d.cash_price), 180);
  });
  test('numbers must be plain decimals in templates too', async () => {
    for (const bad of ['0x10', true, [3]]) {
      const r = await api('POST', '/api/templates', baseTemplate({ sections: [{ items: [{ material_id: fx.matA, quantity: bad, unit_price: 1 }] }] }));
      assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
    }
  });
  test('object values in text fields are rejected', async () => {
    const r = await api('POST', '/api/templates', baseTemplate({ template_title: { a: 1 } }));
    assert.equal(r.status, 400);
  });
  test('a section total too large for its column is a 400, not a 500', async () => {
    const items = Array.from({ length: 5 }, () => ({ quantity: 99999999, unit_price: 99.99 }));
    const r = await api('POST', '/api/templates', baseTemplate({ sections: [{ items }] }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
  test('versioning: stale update refused; two simultaneous saves -> exactly one wins', async () => {
    const t = await api('POST', '/api/templates', baseTemplate({ template_title: '__QA__ race' }));
    const id = t.body.template_id;
    const body = baseTemplate({ template_title: '__QA__ race', version: 1 });
    const results = await Promise.all([api('PUT', `/api/templates/${id}`, body), api('PUT', `/api/templates/${id}`, body)]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
    assert.equal((await api('PUT', `/api/templates/${id}`, body)).status, 409);
  });
  test('a refused update leaves the template unchanged', async () => {
    const t = await api('POST', '/api/templates', baseTemplate({ template_title: '__QA__ atomic', spec_lines: [{ line_title: 'Keep', line_details: 'me' }] }));
    const id = t.body.template_id;
    await api('PUT', `/api/templates/${id}`, baseTemplate({ template_title: '__QA__ atomic CHANGED', version: 1, sections: [{ items: [{ material_id: fx.matB, quantity: 1, unit_price: 1 }] }] }));
    const d = (await api('GET', `/api/templates/${id}`)).body.data;
    assert.equal(d.template_title, '__QA__ atomic');
    assert.equal(d.spec_lines.length, 1);
    assert.equal(d.version, 1);
  });
  test('template list includes currency code and decimals', async () => {
    const list = (await api('GET', '/api/templates')).body.data;
    const mine = list.find((t) => t.template_title === '__QA__ template');
    assert.ok(mine);
    assert.equal(mine.currency, 'QAZA');
    assert.equal(Number(mine.currency_decimals), 2);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Pricing: screen and server agree', () => {
  test('2,000 random templates give identical figures', () => {
    const rnd = (a, b, d = 2) => Math.round((Math.random() * (b - a) + a) * 10 ** d) / 10 ** d;
    for (let i = 0; i < 2000; i++) {
      const sections = [{ items: Array.from({ length: 1 + (i % 6) }, () => ({ quantity: rnd(0, 40), unit_price: rnd(0, 3000000) })) }];
      const costs = Array.from({ length: i % 3 }, (_, k) => (k % 2 ? { mode: 'amount', amount: rnd(-9000, 90000) } : { mode: 'percent', percentage: rnd(-5, 10, 4) }));
      const s2 = Array.from({ length: i % 5 }, (_, k) => ({ mode: k % 3 === 2 ? 'amount' : 'percent', percentage: rnd(-20, 60, 4), amount: rnd(-5000, 400000), includeInCashPrice: Math.random() > 0.4 }));
      const f = front.calculateTotals(sections, { additionalCosts: costs, section2Additions: s2 });
      const s = serverPricing.calculatePricing({
        sections,
        additionalCosts: costs.map((c) => ({ calc_mode: c.mode, percentage: c.percentage, amount: c.amount })),
        section2Additions: s2.map((r) => ({ calc_mode: r.mode, percentage: r.percentage, amount: r.amount, include_in_cash_price: r.includeInCashPrice })),
        solutionPriceOverride: null,
        cashPriceOverride: null
      });
      assert.equal(f.totalCost, s.totalCost);
      assert.equal(f.solutionPriceCalculated, s.solutionPriceCalculated);
      assert.equal(f.cashPriceCalculated, s.cashPriceCalculated);
    }
  });
  test('company sheet example', () => {
    const t = front.calculateTotals([{ items: [{ quantity: 1, unit_price: 11356105.25 }] }], {
      additionalCosts: [{ mode: 'percent', percentage: 1 }],
      section2Additions: [{ mode: 'percent', percentage: 15, includeInCashPrice: true }, { mode: 'percent', percentage: 5, includeInCashPrice: false }]
    });
    assert.equal(t.totalCost, 11469666.3);
    assert.equal(t.cashPriceCalculated, 13190116.25);
    assert.equal(t.solutionPriceCalculated, 13849622.06);
  });
});

// ---------------------------------------------------------------------------------------------
// Last on purpose: after the limit is hit, writes from this client are throttled for a minute.
describe('Rate limiting', () => {
  test('write requests are rate limited', async () => {
    // 200 rapid invalid writes from one client must eventually be throttled (429)
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) {
      const r = await api('POST', '/api/currencies', { currency_code: '1' });
      if (r.status === 429) limited = true;
    }
    assert.ok(limited, 'expected a 429 Too Many Requests');
  });
});
