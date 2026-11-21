// ═══════════════════════════════════════════════════════════════
//  Google Sheet → Orders sync (used by api/admin.js, not a function itself:
//  the leading underscore keeps Vercel from counting it as one).
//
//  Sheet layout (no header needed): A Name · B Item · C Qty · D Amount ·
//  E Delivery fee (e.g. 50/-) · F Phone · G Area · H Notes.
//  One tab per delivery day, named dd-mm-yyyy. All rows for one phone on a
//  tab become ONE order (id WA-yyyymmdd-<phone>). A header row is detected
//  and honoured if the sheet has one.
// ═══════════════════════════════════════════════════════════════
const XLSX = require('xlsx');

function pad(n) { return String(n).padStart(2, '0'); }
function istToday() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function money(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; }
function cleanPhone(v) { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function sheetDate(name) {
  const m = String(name).match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
}

// "500gms" → {kg:.5}, "1Kg" → {kg:1}, "12pack" → {count:12}, "Set" → {}
function parseQty(q) {
  q = String(q || '').toLowerCase().replace(/\s+/g, '');
  let m = q.match(/(\d+(?:\.\d+)?)(kg|kgs)/);
  if (m) return { kg: parseFloat(m[1]) };
  m = q.match(/(\d+(?:\.\d+)?)(gms|gm|gram|grams|g)/);
  if (m) return { kg: parseFloat(m[1]) / 1000 };
  m = q.match(/(\d+)/);
  if (m) return { count: parseInt(m[1], 10) };
  return {};
}

// Price from the website catalog when the sheet has no amount.
// catalog rows: {name, price, unit}. Returns 0 if it can't be worked out.
function estimatePrice(item, qty, catalog) {
  const it = String(item || '').toLowerCase();
  const find = (re) => (catalog || []).find((p) => re.test(String(p.name).toLowerCase()));
  let prod =
    /kheema|keema/.test(it) ? find(/kheema/) :
    /boneless/.test(it) ? find(/boneless/) :
    /head/.test(it) ? find(/head/) :
    /leg/.test(it) ? find(/legs?/) :
    /liver/.test(it) ? find(/liver/) :
    /boti/.test(it) ? find(/boti/) :
    /brain|bain/.test(it) ? find(/bain|brain/) :
    /egg/.test(it) ? find(/egg/) :
    /chicken|kodi/.test(it) ? find(/chicken/) :
    /mutton|seena|goat|nalli/.test(it) ? find(/mutton|pottel/) : null;
  if (!prod) return 0;
  const q = parseQty(qty);
  const unit = String(prod.unit || '').toLowerCase();
  const price = Number(prod.price) || 0;
  if (unit === 'kg') return q.kg ? Math.round(price * q.kg) : 0;
  if (unit === 'egg') return q.count ? price * q.count : 0;
  return Math.round(price * (q.count || 1));
}

function columnMap(headerRow) {
  const h = (headerRow || []).map((c) => String(c || '').toLowerCase());
  const idx = (re) => h.findIndex((c) => re.test(c));
  const map = { name: idx(/name|customer/), item: idx(/item|product|order|meat/), qty: idx(/qty|quantity|weight/),
    amount: idx(/amount|total|price|bill|rs/), fee: idx(/delivery|fee|charge/), phone: idx(/phone|mobile|number|contact|whatsapp/),
    area: idx(/area|location|address/), notes: idx(/note|remark|comment/) };
  return map;
}
const DEFAULT_MAP = { name: 0, item: 1, qty: 2, amount: 3, fee: 4, phone: 5, area: 6, notes: 7 };
function looksLikeHeader(r) { return /name|phone|mobile|item|amount|total/i.test((r || []).join(' ')); }

function parseSheet(grid, date, catalog, today) {
  let map = DEFAULT_MAP, start = 0;
  if (grid.length && looksLikeHeader(grid[0])) { map = Object.assign({}, DEFAULT_MAP, ...Object.entries(columnMap(grid[0])).filter(([, v]) => v >= 0).map(([k, v]) => ({ [k]: v }))); start = 1; }
  const groups = {}, order = [];
  const stats = { noPhone: 0, website: 0, priced: 0, noAmount: 0 };
  for (let i = start; i < grid.length; i++) {
    const r = grid[i] || [];
    const cell = (k) => (r[map[k]] == null ? '' : r[map[k]]);
    const name = String(cell('name')).trim(), item = String(cell('item')).trim(), qty = String(cell('qty')).trim();
    if (!name && !item && !cell('phone')) continue;                 // blank spacer row
    const phone = cleanPhone(cell('phone'));
    if (!phone) { stats.noPhone++; continue; }
    const note = String(cell('notes')).trim();
    if (/website/i.test(note)) { stats.website++; continue; }       // already saved from the website
    let amt = money(cell('amount'));
    if (!amt) {
      const est = estimatePrice(item, qty, catalog);
      if (est) { amt = est; stats.priced++; } else stats.noAmount++;
    }
    const fee = money(cell('fee'));
    let g = groups[phone];
    if (!g) { g = groups[phone] = { name, phone, area: String(cell('area')).trim(), notes: [], items: [], subtotal: 0, fee: 0 }; order.push(phone); }
    if (!g.name && name) g.name = name;
    if (note && !g.notes.includes(note)) g.notes.push(note);
    g.items.push({ name: (item + (qty ? ' · ' + qty : '')).trim() || 'Item', qty: 1, price: amt });
    g.subtotal += amt;
    if (fee) g.fee = Math.max(g.fee, fee);
  }
  const orders = order.map((ph) => {
    const g = groups[ph];
    return {
      order_id: `WA-${date.replace(/-/g, '')}-${ph}`,
      customer: { name: g.name || 'Customer', phone: ph, address: { area: g.area }, area: g.area, notes: g.notes.join('; '), delivery_date: date, slot: '', source: 'whatsapp' },
      items: g.items, subtotal: g.subtotal, delivery: g.fee, discount: 0, total: g.subtotal + g.fee,
      payment: 'cod', payment_id: null,
      status: date < today ? 'delivered' : 'confirmed',
      placed_at: `${date}T08:00:00+05:30`,
    };
  });
  return { orders, stats };
}

function parseWorkbook(buf, catalog) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const today = istToday();
  const out = { orders: [], tabs: [], skippedTabs: [], stats: { noPhone: 0, website: 0, priced: 0, noAmount: 0 } };
  for (const sn of wb.SheetNames) {
    const date = sheetDate(sn);
    if (!date) { out.skippedTabs.push(sn); continue; }              // tab not named like a date
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: false });
    const res = parseSheet(grid, date, catalog, today);
    out.orders.push(...res.orders);
    out.tabs.push(`${sn}: ${res.orders.length}`);
    for (const k of Object.keys(out.stats)) out.stats[k] += res.stats[k];
  }
  return out;
}

function sheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function downloadSheet(url) {
  const id = sheetIdFromUrl(url);
  if (!id) throw new Error('That does not look like a Google Sheets link (it should contain /spreadsheets/d/…).');
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || buf.slice(0, 2).toString() !== 'PK') {
    throw new Error('Could not read the sheet. Open it in Google Sheets → Share → General access → "Anyone with the link" → Viewer, then try again.');
  }
  return buf;
}

// rest(env, path, init) is the service-role PostgREST helper from api/admin.js.
async function syncFromSheet(env, rest, url) {
  const catR = await rest(env, 'products?select=name,price,unit');
  const catalog = catR.ok ? await catR.json() : [];
  const parsed = parseWorkbook(await downloadSheet(url), catalog);

  const exR = await rest(env, 'orders?select=order_id,status,total,items&order_id=like.WA-*&limit=5000');
  const existing = new Map((exR.ok ? await exR.json() : []).map((o) => [o.order_id, o]));

  const fresh = [], changed = [];
  for (const o of parsed.orders) {
    const ex = existing.get(o.order_id);
    if (!ex) { fresh.push(o); continue; }
    // Re-sync edits only while the order hasn't moved on in the app.
    if (ex.status === 'confirmed' && (Number(ex.total) !== o.total || JSON.stringify(ex.items) !== JSON.stringify(o.items))) changed.push(o);
  }
  let inserted = 0, updated = 0;
  for (let i = 0; i < fresh.length; i += 50) {
    const r = await rest(env, 'orders', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(fresh.slice(i, i + 50)) });
    if (!r.ok) throw new Error('Saving orders failed: ' + (await r.text()).slice(0, 200));
    inserted += Math.min(50, fresh.length - i);
  }
  for (const o of changed) {
    const r = await rest(env, `orders?order_id=eq.${encodeURIComponent(o.order_id)}&status=eq.confirmed`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ customer: o.customer, items: o.items, subtotal: o.subtotal, delivery: o.delivery, total: o.total }),
    });
    if (r.ok) updated++;
  }
  return {
    ok: true, tabs: parsed.tabs, skippedTabs: parsed.skippedTabs,
    inserted, updated, unchanged: parsed.orders.length - inserted - updated,
    skippedNoPhone: parsed.stats.noPhone, skippedWebsite: parsed.stats.website,
    pricedFromWebsite: parsed.stats.priced, noAmount: parsed.stats.noAmount,
  };
}

module.exports = { parseWorkbook, parseSheet, estimatePrice, syncFromSheet, sheetIdFromUrl, istToday };
