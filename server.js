/* Blue Wave B2B Ordering App — HPMP Manufacturers Pvt Ltd
 * Node.js + Express + SQLite. Run: npm install && npm start
 */
const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
/* Where the database lives. Free hosting plans wipe the app folder on every
 * restart, so if a persistent disk is mounted (Render's usual /var/data, or a
 * Railway volume at /data) the database is kept there instead. */
function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  for (const p of ['/var/data', '/data']) {
    try { fs.accessSync(p, fs.constants.W_OK); return p; } catch (e) { /* not mounted */ }
  }
  return path.join(__dirname, 'data');
}
const DATA_DIR = pickDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
console.log('Database file: ' + path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT UNIQUE COLLATE NOCASE,
  pass_hash TEXT, salt TEXT, company TEXT, gstin TEXT UNIQUE, type TEXT,
  addr TEXT, city TEXT, state TEXT, status TEXT DEFAULT 'pending',
  note TEXT DEFAULT '', created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id TEXT, role TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY, name TEXT, cat TEXT, emoji TEXT,
  mrp REAL, dealer REAL, moq INTEGER DEFAULT 50, active INTEGER DEFAULT 1, sort INTEGER
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, user_id TEXT, contact_json TEXT, addr TEXT, notes TEXT,
  items_json TEXT, total REAL, tier TEXT, status TEXT DEFAULT 'awaiting_payment',
  pay_ref TEXT DEFAULT '', created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS transports(id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE);
`);
try { db.exec("ALTER TABLE orders ADD COLUMN transport TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN lr_number TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN dispatch_transport TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN dispatched_at TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN dispatch_mode TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN vehicle_no TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN driver_name TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN driver_phone TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN terms TEXT DEFAULT 'advance'"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN credit_days INTEGER DEFAULT 0"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE products ADD COLUMN image TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE products ADD COLUMN descr TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE products ADD COLUMN packing TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE products ADD COLUMN options TEXT DEFAULT ''"); } catch (e) { /* column exists */ }

/* Default descriptions, master packing details and options per product line */
/* A bracket named by its frame size — 500x500, 550x550, 600x600 — rather than
 * by load rating. Matched on the dimensions themselves so a new size needs no
 * code change. */
const SIZE_CODED = /(\d{3,4})\s*[x×*]\s*(\d{3,4})/i;

function productMeta(name) {
  const n = name.toLowerCase();

  /* Checked BEFORE the load-rated XEON rule below, which would otherwise claim
     these by the word "xeon" alone and hand them the 15-per-bag / 12-per-box
     figures of the smaller brackets — wrong on the dispatch slip in a way
     nobody would spot until a consignment was short. */
  const dims = SIZE_CODED.exec(name);
  if (n.includes('xeon') && dims) {
    const size = dims[1] + ' x ' + dims[2];
    return {
      descr: `XEON ${size} mm AC wall mounting bracket set for split AC outdoor units — fits all major brands. High-grade steel with 7-tank powder coating for rust-free life even in humid climates. Sold as a set of 2 arms with complete mounting hardware.`,
      packing: `Each set: 2 powder-coated arms + nut-bolt hardware kit, strapped together.\nMaster packing: 6 sets per master box, 5-ply corrugated.`,
      /* One way only, so there is nothing for the dealer to choose and nothing
         extra to pay — the carton is simply how this size ships. */
      options: JSON.stringify({ packs: [
        { id: 'box', label: 'Box packing', master: '6 pcs per master box', add: 0 }
      ]})
    };
  }

  /* Mobile Stand — a small accessory, so a master carton holds fifty. */
  if (n.includes('mobile stand')) {
    return {
      descr: 'Mobile Stand — powder-coated steel stand for mobile handsets and small devices. Stable weighted base, scratch-free contact pads, finished to the same 7-tank standard as the rest of the range.',
      packing: 'Each stand packed in an individual printed carton.\nMaster packing: 50 pcs per master carton.',
      options: JSON.stringify({ packs: [
        { id: 'carton', label: 'Carton packing', master: '50 pcs per master carton', add: 0 }
      ]})
    };
  }

  if (n.includes('xeon')) {
    const w = n.includes('2.7') ? '2.7' : n.includes('3.5') ? '3.5' : '3';
    return {
      descr: `XEON ${w} kg-class AC wall mounting bracket set for split AC outdoor units — fits all major brands. High-grade steel with 7-tank powder coating for rust-free life even in humid climates. Sold as a set of 2 arms with complete mounting hardware.`,
      packing: `Each set: 2 powder-coated arms + nut-bolt hardware kit, strapped together.\nGunny bag packing: 15 sets per master bag (approx. ${(15 * parseFloat(w)).toFixed(1)} kg per bag).\nBox packing: 12 sets per master carton, 5-ply corrugated (approx. ${(12 * parseFloat(w)).toFixed(1)} kg per box) — extra protection for finish, +₹4 per set.`,
      options: JSON.stringify({ packs: [
        { id: 'gunny', label: 'Gunny bag packing', master: '15 pcs per master bag', add: 0 },
        { id: 'box', label: 'Box packing', master: '12 pcs per master box', add: 4 }
      ]})
    };
  }
  if (n.includes('titanic')) {
    return {
      descr: 'TITANIC 5 kg heavy-duty AC wall mounting bracket set for large outdoor units (2 ton and above). Extra-thick high-grade steel with 7-tank powder coating; engineered for maximum load bearing. Sold as a set of 2 arms with complete mounting hardware.',
      packing: 'Each set: 2 heavy-duty arms + nut-bolt hardware kit, strapped together.\nGunny bag packing: 8 sets per master bag (approx. 40 kg per bag).\nBox packing: 8 sets per master carton, 5-ply corrugated — extra protection for finish, +₹6 per set.',
      options: JSON.stringify({ packs: [
        { id: 'gunny', label: 'Gunny bag packing', master: '8 pcs per master bag', add: 0 },
        { id: 'box', label: 'Box packing', master: '8 pcs per master box', add: 6 }
      ]})
    };
  }
  /* Trolleys ship in bundles, not bags or cartons. There is no choice to make —
     one bundle size per product — but the count still has to be structured
     data, not just a sentence, or the dispatch slip cannot work out how many
     bundles are going on the vehicle. */
  const bundle = qty => JSON.stringify({ packs: [
    { id: 'bundle', label: 'Bundle packing', master: qty + ' pcs per bundle', add: 0 }
  ]});
  if (n.includes('xuv')) {
    const per = n.includes('300') ? 10 : 6;
    return {
      descr: `${name} — height and width adjustable appliance trolley for washing machines and refrigerators. Smooth-rolling wheels with brake locks, high-grade steel frame, 7-tank powder coating. Adjustable to fit all standard appliance sizes.`,
      packing: `Each trolley packed knocked-down in an individual printed carton with assembly hardware.\nMaster packing: ${per} pcs per bundle.`,
      options: bundle(per)
    };
  }
  if (n.includes('angle')) {
    return {
      descr: 'Angle Trolly — fixed-frame appliance trolley with smooth-rolling wheels. Sturdy angle-steel construction with 7-tank powder coating, ideal for washing machines, coolers and refrigerators. Available in multiple sizes.',
      packing: 'Each trolley packed in an individual carton with wheels pre-fitted.\nMaster packing: 6 pcs per bundle.',
      options: JSON.stringify({ sizes: ['19 x 24 inch', '22 x 22 inch', '22 x 24 inch', '23 x 24 inch', '24 x 24 inch'],
        packs: JSON.parse(bundle(6)).packs })
    };
  }
  if (n.includes('front load')) {
    return {
      descr: 'Front Load Trolly — fixed-frame trolley designed for front-load washing machines. Wide stable base, vibration-friendly design, smooth-rolling wheels with brake locks, 7-tank powder coated steel. Available in multiple sizes.',
      packing: 'Each trolley packed in an individual carton with wheels pre-fitted.\nMaster packing: 6 pcs per bundle.',
      options: JSON.stringify({ sizes: ['Ultra 6 kg', 'Ultra 7 kg', 'Ultra 8 kg'],
        packs: JSON.parse(bundle(6)).packs })
    };
  }
  return { descr: '', packing: '', options: '' };
}
/* backfill meta for products that don't have it yet (runs again after seeding) */
function backfillMeta() {
  db.prepare('SELECT id,name,descr FROM products').all().forEach(p => {
    if (!p.descr) {
      const m = productMeta(p.name);
      db.prepare('UPDATE products SET descr=?, packing=?, options=? WHERE id=?').run(m.descr, m.packing, m.options, p.id);
    }
  });
}
backfillMeta();
/* one-time migration: refresh trolly sizes/packing if the old defaults are still stored */
db.prepare('SELECT id,name,options,packing FROM products').all().forEach(p => {
  const old = (p.options || '').includes('24 × 24 inch') || (p.options || '').includes('Fits 6–7 kg');
  if ((p.name === 'Angle Trolly' || p.name === 'Front Load Trolly') && (old || (p.packing || '').includes('8 pcs per bundle'))) {
    const m = productMeta(p.name);
    db.prepare('UPDATE products SET options=?, packing=? WHERE id=?').run(m.options, m.packing, p.id);
  }
  if (p.name === 'XUV 300 Adjustable Trolley' && (p.packing || '').includes('6 cartons per bundle')) {
    const m = productMeta(p.name);
    db.prepare('UPDATE products SET packing=? WHERE id=?').run(m.packing, p.id);
  }
});

/* Orders placed without an account used to be readable by anyone who could
 * guess the number — and the numbers run in sequence, so guessing was counting.
 * A guest order now carries a secret handed only to the person who placed it. */
try { db.exec("ALTER TABLE orders ADD COLUMN guest_token TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN rzp_order_id TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN subtotal REAL DEFAULT 0"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN gst REAL DEFAULT 0"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN credit_due TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN credit_settled INTEGER DEFAULT 0"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN pincode TEXT DEFAULT ''"); } catch (e) { /* column exists */ }

/* ---------- multi-zone / multi-currency ----------
 * Existing dealers were all Indian, so country defaults to IN and their GSTIN
 * stays exactly where it was — the gstin column now holds whatever tax number
 * the dealer's country uses. Nothing is rewritten or moved.
 */
try { db.exec("ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'IN'"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN licence_no TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("UPDATE users SET country='IN' WHERE country IS NULL OR country=''"); } catch (e) { /* no rows */ }

/* An order remembers the currency, rate and tax it was placed at, so an old
 * order never changes value when the admin updates today's exchange rate. */
try { db.exec("ALTER TABLE orders ADD COLUMN country TEXT DEFAULT 'IN'"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN currency TEXT DEFAULT 'INR'"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN fx_rate REAL DEFAULT 1"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN tax_percent REAL DEFAULT -1"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE orders ADD COLUMN tax_label TEXT DEFAULT 'GST'"); } catch (e) { /* column exists */ }

/* Per-zone exchange rate and tax rate, editable by the admin. */
db.exec(`CREATE TABLE IF NOT EXISTS zones(
  code TEXT PRIMARY KEY, fx REAL, tax_percent REAL, enabled INTEGER DEFAULT 1, updated_at TEXT)`);
try { db.exec("ALTER TABLE users ADD COLUMN whatsapp TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
/* in-app notifications: user_id 'admin' means the admin panel */
db.exec(`CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, title TEXT, body TEXT,
  order_id TEXT DEFAULT '', created_at TEXT, read_at TEXT DEFAULT '')`);
db.exec('CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at)');

/* codes issued to numbers that have not registered yet */
db.exec(`CREATE TABLE IF NOT EXISTS otp_codes(
  mobile TEXT PRIMARY KEY, code TEXT, created_at TEXT, tries INTEGER DEFAULT 0)`);

/* browsers/phones signed up for push (one row per device) */
db.exec(`CREATE TABLE IF NOT EXISTS push_subs(
  id TEXT PRIMARY KEY, user_id TEXT, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, created_at TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id)');

/* festive offers — a percentage off dealer prices for a date range */
db.exec(`CREATE TABLE IF NOT EXISTS offers(
  id TEXT PRIMARY KEY, name TEXT, percent REAL, starts TEXT, ends TEXT,
  active INTEGER DEFAULT 1, created_at TEXT)`);

/* extra discount granted to an individual dealer, % off their dealer price */
try { db.exec('ALTER TABLE users ADD COLUMN discount REAL DEFAULT 0'); } catch (e) { /* column exists */ }
/* mobile + email verification */
try { db.exec("ALTER TABLE users ADD COLUMN mobile_code TEXT DEFAULT ''"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN email_code TEXT DEFAULT ''"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN mobile_ok INTEGER DEFAULT 0'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN email_ok INTEGER DEFAULT 0'); } catch (e) { /* exists */ }
/* email verification was dropped — only the WhatsApp number is verified now */
try { db.exec('UPDATE users SET email_ok=1 WHERE email_ok=0'); } catch (e) { /* nothing to do */ }
/* password reset by code */
try { db.exec("ALTER TABLE users ADD COLUMN reset_code TEXT DEFAULT ''"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN reset_at TEXT DEFAULT ''"); } catch (e) { /* exists */ }
/* one-time code for signing in with a mobile number */
try { db.exec("ALTER TABLE users ADD COLUMN login_code TEXT DEFAULT ''"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN login_at TEXT DEFAULT ''"); } catch (e) { /* exists */ }
/* A blank tax number has to be NULL, never ''. The column is UNIQUE, and SQLite
 * treats every '' as the same value while allowing any number of NULLs — so one
 * stored '' is enough to lock every later dealer out of registering without one. */
try { db.exec("UPDATE users SET gstin=NULL WHERE gstin=''"); } catch (e) { /* nothing to tidy */ }

/* Wrong guesses against a live code. Without these a six-digit code is only a
 * million tries away from anyone's account, and nothing was counting. */
try { db.exec('ALTER TABLE users ADD COLUMN login_tries INTEGER DEFAULT 0'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN reset_tries INTEGER DEFAULT 0'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN verify_tries INTEGER DEFAULT 0'); } catch (e) { /* exists */ }

/* Rate limits live in the database, not in a Map: free hosting restarts the
 * process constantly, and an in-memory counter resets with it — which is the
 * same as having no limit at all. */
db.exec(`CREATE TABLE IF NOT EXISTS rate_limits(
  bucket TEXT PRIMARY KEY, hits INTEGER DEFAULT 0, first_at INTEGER, until INTEGER DEFAULT 0)`);

/* per-dealer custom price list (blank row = dealer uses the standard dealer price) */
db.exec(`CREATE TABLE IF NOT EXISTS dealer_prices(
  user_id TEXT, product_id TEXT, price REAL, PRIMARY KEY(user_id, product_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS reminders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, kind TEXT, channel TEXT,
  phone TEXT, message TEXT, status TEXT, sent_at TEXT)`);

/* ---------- helpers ---------- */
const uid = p => p + crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString();
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
/* Compares two hex digests without leaking, through timing, how far along they
 * first differed. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
const checkPw = (pw, salt, hash) => !!salt && !!hash && safeEqual(hashPw(String(pw || ''), salt), hash);
/* One-time codes are credentials, so they come from the CSPRNG. Math.random()
 * is seeded predictably and its internal state can be recovered from a handful
 * of outputs — fine for picking a placeholder, not for guarding an account. */
const otpCode = () => String(crypto.randomInt(100000, 1000000));

/* ---------- rate limiting ----------
 * One shared counter, keyed by whatever makes sense for the route (an account
 * id, a phone number, a client address). Returns null when the call may go
 * ahead, or the number of seconds left to wait. */
function rateLimit(bucket, max, windowMs, blockMs) {
  const t = Date.now();
  const row = db.prepare('SELECT * FROM rate_limits WHERE bucket=?').get(bucket);
  if (row && row.until > t) return Math.ceil((row.until - t) / 1000);
  if (!row || (t - row.first_at) > windowMs || row.until) {
    db.prepare(`INSERT INTO rate_limits(bucket,hits,first_at,until) VALUES(?,1,?,0)
      ON CONFLICT(bucket) DO UPDATE SET hits=1, first_at=excluded.first_at, until=0`).run(bucket, t);
    return null;
  }
  const hits = row.hits + 1;
  if (hits > max) {
    db.prepare('UPDATE rate_limits SET hits=?, until=? WHERE bucket=?').run(hits, t + blockMs, bucket);
    return Math.ceil(blockMs / 1000);
  }
  db.prepare('UPDATE rate_limits SET hits=? WHERE bucket=?').run(hits, bucket);
  return null;
}
const clearLimit = bucket => db.prepare('DELETE FROM rate_limits WHERE bucket=?').run(bucket);
/* Behind Railway/Render the socket address is the proxy's, so the forwarded
 * header is what identifies the caller. Only the first hop is trusted. */
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket.remoteAddress || 'unknown';
const waitMsg = secs => 'Too many attempts. Please wait ' +
  (secs > 90 ? Math.ceil(secs / 60) + ' minutes' : secs + ' seconds') + ' and try again.';

/* How long a signed-in session stays valid. A token that never expires is a
 * permanent key to the account if a phone is lost or a backup is extracted. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const newSession = (userId, role) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(token, userId, role, now());
  return token;
};
function purgeSessions() {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM rate_limits WHERE until < ? AND first_at < ?')
    .run(Date.now(), Date.now() - 24 * 60 * 60 * 1000);
  db.prepare("DELETE FROM otp_codes WHERE created_at < ?")
    .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const gstPercent = () => { const v = parseFloat(getSetting('gstPercent')); return isFinite(v) && v >= 0 ? v : 18; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

/* ==========================================================================
   ZONES — one definition per country we sell into.
   This is the single source of truth for the registration form, the tax shown
   on an order, and the currency prices are quoted in. The same table is sent
   to the browser by /api/zones, so the form and the server can never disagree
   about what a valid tax number looks like.

   fx        starting rate: how much of the local currency 1 INR buys.
             Product prices are held in INR and converted with this. The admin
             sets the real rate in Admin -> Zones; these are only seeds.
   taxPercent  what HPMP charges the buyer on the invoice.

             India is 18% GST, charged and collected here.

             Everywhere else is 0. Goods leaving India are exported zero-rated:
             HPMP does not charge the buyer's VAT or sales tax, and the importer
             settles it with their own customs authority on arrival. Quoting a
             Gulf dealer a price "inclusive of VAT" therefore described a tax
             that was never being collected, and a dealer could reasonably have
             read it as meaning nothing further fell due at their end.

             Because prices here are tax-inclusive (total = the listed price,
             tax is the portion within it), this rate never changes what anyone
             pays — only what the order declares. An admin who does become
             registered in a Gulf state can set the real rate in Admin -> Zones
             and it starts appearing again.

   Licence formats are deliberately lenient — turning away a real dealer over
   a format guess is worse than the admin eyeballing the number at approval.
   ========================================================================== */
const ZONES = {
  IN: {
    code: 'IN', country: 'India', dial: '91', phoneLen: 10,
    currency: 'INR', symbol: '₹', locale: 'en-IN', decimals: 2, fx: 1,
    taxLabel: 'GST', taxPercent: 18,
    taxId: { label: 'GSTIN', short: 'GSTIN', placeholder: '36ABCDE1234F1Z5', hint: '15 characters, e.g. 36ABCDE1234F1Z5',
             re: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', upper: true, required: true },
    licence: null,
    regionLabel: 'State',
    postcode: { label: 'Pincode', re: '^[1-9][0-9]{5}$', hint: '6-digit pincode', required: true }
  },
  AE: {
    code: 'AE', country: 'United Arab Emirates', dial: '971', phoneLen: 9,
    altCurrency: 'USD',   // Gulf currencies are pegged to the dollar; much of the trade is invoiced in it
    currency: 'AED', symbol: 'AED', locale: 'en-AE', decimals: 2, fx: 0.0384,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'VAT TRN', short: 'VAT', placeholder: '100123456700003', hint: '15-digit Tax Registration Number — leave blank if you are not VAT registered',
             re: '^[0-9]{15}$', upper: false, required: false },
    licence: { label: 'Trade licence number', placeholder: 'e.g. CN-1234567', hint: 'as printed on your DED trade licence',
               re: '^[A-Za-z0-9][A-Za-z0-9\\-\\/ ]{2,29}$', upper: true, required: true },
    regionLabel: 'Emirate',
    postcode: null
  },
  SA: {
    code: 'SA', country: 'Saudi Arabia', dial: '966', phoneLen: 9,
    altCurrency: 'USD',   // Gulf currencies are pegged to the dollar; much of the trade is invoiced in it
    currency: 'SAR', symbol: 'SAR', locale: 'en-SA', decimals: 2, fx: 0.0392,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'VAT registration number', short: 'VAT', placeholder: '300123456700003', hint: '15 digits, starts and ends with 3 — leave blank if you are not VAT registered',
             re: '^3[0-9]{13}3$', upper: false, required: false },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '1010123456', hint: '10-digit CR number',
               re: '^[0-9]{10}$', upper: false, required: true },
    regionLabel: 'Region',
    postcode: { label: 'Postal code', re: '^[0-9]{5}$', hint: '5-digit postal code', required: false }
  },
  OM: {
    code: 'OM', country: 'Oman', dial: '968', phoneLen: 8,
    altCurrency: 'USD',   // Gulf currencies are pegged to the dollar; much of the trade is invoiced in it
    currency: 'OMR', symbol: 'OMR', locale: 'en-OM', decimals: 3, fx: 0.00402,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'VAT identification number', short: 'VAT', placeholder: 'OM1100000000', hint: 'OM followed by 10 digits — leave blank if you are not VAT registered',
             re: '^OM[0-9]{10}$', upper: true, required: false },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '1234567', hint: '7 to 10 digits',
               re: '^[0-9]{7,10}$', upper: false, required: true },
    regionLabel: 'Governorate',
    postcode: { label: 'Postal code', re: '^[0-9]{3}$', hint: '3-digit postal code', required: false }
  },
  QA: {
    code: 'QA', country: 'Qatar', dial: '974', phoneLen: 8,
    altCurrency: 'USD',   // Gulf currencies are pegged to the dollar; much of the trade is invoiced in it
    currency: 'QAR', symbol: 'QAR', locale: 'en-QA', decimals: 2, fx: 0.0380,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'Tax Identification Number (TIN)', short: 'TIN', placeholder: '5012345678', hint: 'your Dhareeba TIN — leave blank if not registered',
             re: '^[0-9]{8,12}$', upper: false, required: false },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '123456', hint: '6 to 10 digits',
               re: '^[0-9]{6,10}$', upper: false, required: true },
    regionLabel: 'Municipality',
    postcode: null
  },
  KW: {
    code: 'KW', country: 'Kuwait', dial: '965', phoneLen: 8,
    altCurrency: 'USD',   // Gulf currencies are pegged to the dollar; much of the trade is invoiced in it
    currency: 'KWD', symbol: 'KWD', locale: 'en-KW', decimals: 3, fx: 0.00320,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'Tax card number', short: 'Tax card', placeholder: 'optional', hint: 'Kuwait has no VAT yet — leave blank if you have no tax card',
             re: '^[A-Za-z0-9\\-\\/]{4,20}$', upper: true, required: false },
    licence: { label: 'Commercial Licence number', placeholder: '123456', hint: '4 to 12 digits',
               re: '^[0-9]{4,12}$', upper: false, required: true },
    regionLabel: 'Governorate',
    postcode: null
  },
  BH: {
    code: 'BH', country: 'Bahrain', dial: '973', phoneLen: 8,
    altCurrency: 'USD',   // Gulf currencies are pegged to the dollar; much of the trade is invoiced in it
    currency: 'BHD', symbol: 'BHD', locale: 'en-BH', decimals: 3, fx: 0.00393,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'VAT account number', short: 'VAT', placeholder: '200012345600002', hint: '15-digit VAT account number — leave blank if you are not VAT registered',
             re: '^[0-9]{15}$', upper: false, required: false },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '12345-1', hint: 'CR number as issued by MOIC',
               re: '^[0-9]{4,8}(-[0-9]{1,3})?$', upper: false, required: true },
    regionLabel: 'Governorate',
    postcode: null
  },
  US: {
    code: 'US', country: 'United States', dial: '1', phoneLen: 10,
    currency: 'USD', symbol: '$', locale: 'en-US', decimals: 2, fx: 0.01048,
    /* There is no federal sales tax. It is charged by state and county, on the
     * destination, and a manufacturer exporting from India generally has no
     * nexus obliging it to collect — the importer settles duty and use tax at
     * their end. So this sits at 0, like Qatar and Kuwait, and the admin can
     * switch it on for a state if that ever changes. */
    taxLabel: 'Sales tax', taxPercent: 0,
    taxId: { label: 'Federal EIN', short: 'EIN', placeholder: '12-3456789', hint: '9-digit EIN, e.g. 12-3456789 — leave blank if you trade as a sole proprietor',
             re: '^[0-9]{2}-?[0-9]{7}$', upper: false, required: false },
    /* Business registration is a state matter and the formats vary wildly, so
     * this is checked loosely and read properly by the admin at approval —
     * turning away a real distributor over a format guess costs more than a
     * minute of checking. */
    licence: { label: 'Resale certificate / State tax ID', placeholder: 'e.g. TX-12345678', hint: 'the reseller permit or state tax registration for your business',
               re: '^[A-Za-z0-9][A-Za-z0-9\\-\\/ ]{2,29}$', upper: true, required: true },
    regionLabel: 'State',
    postcode: { label: 'ZIP code', re: '^[0-9]{5}(-[0-9]{4})?$', hint: '5-digit ZIP, e.g. 75201', required: true }
  }
};
const DEFAULT_ZONE = 'IN';
const zoneOf = c => ZONES[String(c || '').toUpperCase()] || null;

/* Seed the editable half of each zone once, then leave it to the admin. */
for (const z of Object.values(ZONES)) {
  db.prepare('INSERT OR IGNORE INTO zones(code,fx,tax_percent,enabled,updated_at) VALUES(?,?,?,1,?)')
    .run(z.code, z.fx, z.taxPercent, now());
}
/* One-time correction for databases seeded before export sales were made
 * zero-rated. Only a zone still sitting on the exact rate it was seeded with is
 * touched: if the admin has since set their own figure, that is a deliberate
 * choice and it stands. No price moves either way — these prices are
 * tax-inclusive, so the rate governs only the tax line an order declares. */
if (!getSetting('exportZeroRated')) {
  const SEEDED = { AE: 5, SA: 15, OM: 5, BH: 10 };
  for (const [code, was] of Object.entries(SEEDED)) {
    try { db.prepare('UPDATE zones SET tax_percent=0, updated_at=? WHERE code=? AND tax_percent=?')
      .run(new Date().toISOString(), code, was); } catch (e) { /* zone row not there yet */ }
  }
  setSetting('exportZeroRated', '1');
}

/* One-time: give the trolleys their bundle quantity as structured data.
 *
 * The count was only ever a sentence in the packing note, so the dispatch slip
 * had nothing to count with and printed a dash where the bundle figure should
 * be — a loader had to work it out from the piece count and the prose. Sizes
 * and pack lists are generated, not admin-edited, so regenerating them is safe;
 * the packing note is only rewritten where it still matches what the app wrote,
 * so an admin's own wording is never overwritten. */
if (!getSetting('trolleyBundles')) {
  db.prepare('SELECT id,name,options,packing FROM products').all().forEach(p => {
    const m = productMeta(p.name);
    if (!m.options) return;
    let want; try { want = JSON.parse(m.options); } catch (e) { return; }
    if (!want.packs) return;                       // brackets already had packs
    let have = {}; try { have = JSON.parse(p.options || '{}'); } catch (e) { have = {}; }
    if (Array.isArray(have.packs) && have.packs.length) return;   // already done
    const merged = { ...have, ...want };           // keep sizes, add packs
    const gen = productMeta(p.name).packing;
    const untouched = !p.packing || /cartons per bundle|pcs per bundle/.test(p.packing);
    db.prepare('UPDATE products SET options=?' + (untouched ? ', packing=?' : '') + ' WHERE id=?')
      .run(...(untouched ? [JSON.stringify(merged), gen, p.id] : [JSON.stringify(merged), p.id]));
  });
  setSetting('trolleyBundles', '1');
}

/* One-time: correct any size-coded XEON bracket or Mobile Stand already in the
 * catalogue.
 *
 * Before the rules above existed, a bracket named by frame size matched on the
 * word "xeon" alone and inherited the 15-per-bag / 12-per-box figures of the
 * load-rated brackets, and a Mobile Stand matched nothing and carried no master
 * packing at all. Either way the dispatch slip counted wrongly. Only products
 * whose stored packing disagrees with the rule are touched. */
if (!getSetting('masterPackSizeCoded')) {
  db.prepare('SELECT id,name,options,packing FROM products').all().forEach(p => {
    const n = String(p.name || '').toLowerCase();
    const affected = (n.includes('xeon') && SIZE_CODED.test(p.name)) || n.includes('mobile stand');
    if (!affected) return;
    const m = productMeta(p.name);
    if (!m.options || p.options === m.options) return;
    /* the note is only rewritten where it still matches something the app
       generated, so an admin's own wording survives */
    const generated = !p.packing || /master (bag|box|carton|bundle)|pcs per|sets per/i.test(p.packing);
    db.prepare('UPDATE products SET options=?' + (generated ? ', packing=?' : '') + ' WHERE id=?')
      .run(...(generated ? [m.options, m.packing, p.id] : [m.options, p.id]));
    console.log('Master packing corrected for ' + p.name + ' → ' + JSON.parse(m.options).packs[0].master);
  });
  setSetting('masterPackSizeCoded', '1');
}

/* Whether this zone follows the daily live rate, the raw mid-market rate it
 * came from, and where it came from — kept apart from `fx` so the admin can
 * always see what was quoted versus what the market was doing. */
try { db.exec('ALTER TABLE zones ADD COLUMN fx_auto INTEGER DEFAULT 1'); } catch (e) { /* column exists */ }
try { db.exec('ALTER TABLE zones ADD COLUMN fx_base REAL'); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE zones ADD COLUMN fx_source TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
try { db.exec("ALTER TABLE zones ADD COLUMN fx_checked_at TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
/* Every rate change, automatic or by hand. The rupee moves daily and prices
 * move with it, so "why was this order priced at that rate" needs an answer. */
db.exec(`CREATE TABLE IF NOT EXISTS fx_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, base REAL, rate REAL,
  previous REAL, source TEXT, note TEXT DEFAULT '', at TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_fx_hist ON fx_history(code, id)');

/* The live settings for a zone: admin values if present, definition as fallback. */
function zoneLive(code) {
  const z = zoneOf(code) || ZONES[DEFAULT_ZONE];
  const r = db.prepare('SELECT * FROM zones WHERE code=?').get(z.code);
  const fx = r && isFinite(r.fx) && r.fx > 0 ? r.fx : z.fx;
  /* India keeps using the existing global GST setting so the admin's current
     screen carries on working exactly as before. */
  const tax = z.code === 'IN' ? gstPercent()
            : (r && isFinite(r.tax_percent) && r.tax_percent >= 0 ? r.tax_percent : z.taxPercent);
  return { ...z, fx, taxPercent: tax, enabled: r ? !!r.enabled : true,
    /* India is the base currency — there is nothing to convert, so it is never
       "on automatic" no matter what the column says. */
    fxAuto: z.code === DEFAULT_ZONE ? false : !(r && r.fx_auto === 0),
    fxBase: r && isFinite(r.fx_base) ? r.fx_base : null,
    fxSource: (r && r.fx_source) || '',
    fxUpdatedAt: (r && r.updated_at) || '',
    fxCheckedAt: (r && r.fx_checked_at) || '' };
}
const zoneOfUser = u => zoneLive(u && u.country ? u.country : DEFAULT_ZONE);

/* Which zone a request is priced in.
 *
 *   a signed-in dealer  their own country, always
 *   the admin           India, always
 *   a guest             whichever country they picked
 *
 * The admin case is the one that bites. An admin is not a `user`, so they used
 * to fall through to the guest branch and inherit whatever zone was left in
 * that browser — sign in after looking at the shop as a Dubai visitor and the
 * whole console, revenue tile included, switched to dirhams. The catalogue is
 * kept in rupees and the admin manages it in rupees; there is no version of
 * this screen that should be quoting AED. */
function zoneForRequest(req, asked) {
  if (req.role === 'admin') return zoneLive(DEFAULT_ZONE);
  if (req.user) return zoneOfUser(req.user);
  return zoneLive(asked || DEFAULT_ZONE);
}

/* ---------- quoting a zone in a second currency ----------
 * Every Gulf currency is pegged to the dollar and a great deal of the region's
 * import business is invoiced in dollars, so a dealer there is offered both:
 * their own currency, or USD.
 *
 * What changes is only how the money is written — the currency, its symbol, how
 * many decimals it takes and the rate used to convert from rupees. What does
 * NOT change is the tax: VAT is owed because of where the dealer is, not
 * because of the currency on the invoice. A Dubai dealer paying in dollars
 * still owes 5% UAE VAT, and it stays inside the price either way.
 */
/* The choice on offer is a property of the country, so it is always worked out
 * from the zone's OWN currency — never from whichever one is currently being
 * quoted. Reading it off the quoted zone returns ['USD','USD'] the moment a
 * dealer switches to dollars, which paints a toggle with two identical buttons
 * and no way back to dirhams. */
const zoneCurrencies = z => {
  const base = z.baseCurrency || z.currency;
  return z.altCurrency && z.altCurrency !== base ? [base, z.altCurrency] : [base];
};
function quoteIn(z, code) {
  const want = String(code || '').toUpperCase();
  if (!want || want === z.currency || !zoneCurrencies(z).includes(want)) return z;
  /* the alternate currency's rate is the one kept for its own zone, so a dollar
     quote here and a dollar quote to a US dealer can never disagree */
  const src = Object.values(ZONES).find(x => x.currency === want);
  if (!src) return z;
  const live = zoneLive(src.code);
  return { ...z, baseCurrency: z.baseCurrency || z.currency,
    currency: live.currency, symbol: live.symbol, decimals: live.decimals,
    locale: live.locale, fx: live.fx, quotedIn: want };
}
/* The zone a request should be priced in: where the customer is, written in
 * whichever of the offered currencies they picked. */
const quoteZone = (z, req) => quoteIn(z, (req.query && req.query.currency) || (req.body && req.body.currency));

/* INR -> the zone's currency, rounded to that currency's minor unit.
 * Dinar currencies (OMR, KWD, BHD) are quoted to 3 decimals, not 2. */
function toZone(amountInr, z) {
  const n = Number(amountInr || 0) * (z.fx || 1);
  const p = Math.pow(10, z.decimals);
  return Math.round(n * p) / p;
}
/* What the client sends back is already in zone currency; this brings it home. */
function fromZone(amountLocal, z) {
  const n = Number(amountLocal || 0) / (z.fx || 1);
  return Math.round(n * 100) / 100;
}
/* Validates the country-specific half of a registration. Returns an error
 * message for the dealer, or null when everything checks out. Used by both
 * /api/register and /api/me/complete so the two can never drift apart. */
function zoneFieldError(f, z) {
  const tid = z.taxId, lic = z.licence, pc = z.postcode;

  if (tid) {
    const v = (f.gstin || '').trim();
    if (!v && tid.required) return 'Enter your ' + tid.label + '.';
    if (v && !new RegExp(tid.re).test(v))
      return tid.label + ' format looks invalid. Expected ' + tid.hint + '.';
  } else if ((f.gstin || '').trim()) {
    return 'A tax number is not used for ' + z.country + ' — please leave it blank.';
  }

  if (lic) {
    const v = (f.licence || '').trim();
    if (!v && lic.required) return 'Enter your ' + lic.label + '.';
    if (v && !new RegExp(lic.re).test(v))
      return lic.label + ' format looks invalid. Expected ' + lic.hint + '.';
  }

  if (pc) {
    const v = (f.pincode || '').trim();
    if (!v && pc.required) return 'Enter your ' + pc.label.toLowerCase() + '.';
    if (v && !new RegExp(pc.re).test(v))
      return 'Enter a valid ' + pc.hint + '.';
  }

  if (nationalDigits(f.phone, z).length !== z.phoneLen)
    return 'Enter a valid ' + z.phoneLen + '-digit ' + z.country + ' mobile number (without the +' + z.dial + ').';

  return null;
}
/* Works out the zone from a dialled number, longest dial code first so 971
 * (UAE) is not mistaken for 97. Falls back to India, which is where every
 * existing dealer is. */
function countryFromDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  const byLen = Object.values(ZONES).sort((a, b) => b.dial.length - a.dial.length);
  for (const z of byLen) {
    if (d.startsWith(z.dial) && d.length === z.dial.length + z.phoneLen) return z.code;
  }
  /* Loose prefix match, for a number whose length we cannot account for. A
     one-digit dial code carries almost no information — '1' is the prefix of
     any number that happens to begin with a 1 — so the United States is only
     ever matched on the exact-length rule above, never guessed at here. */
  for (const z of byLen) if (z.dial.length > 1 && d.startsWith(z.dial)) return z.code;
  return DEFAULT_ZONE;
}
/* Strips the dial code off a number, leaving the national digits we store.
 * Deliberately does NOT trim a number down to length: an Indian 10-digit mobile
 * typed into a UAE registration must come back as 10 digits so the caller can
 * reject it, rather than being silently cut to a valid-looking 9. */
function nationalDigits(digits, z) {
  let d = String(digits || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === z.dial.length + z.phoneLen && d.startsWith(z.dial)) return d.slice(z.dial.length);
  if (d.length === z.phoneLen + 1 && d.startsWith('0')) return d.slice(1);
  return d;
}

/* Tax numbers are compared in one canonical case so the same GSTIN typed in
 * lower case cannot slip past the duplicate check. */
const normTaxId = (v, z) => z.taxId && z.taxId.upper ? String(v || '').trim().toUpperCase() : String(v || '').trim();
const normLicence = (v, z) => z.licence && z.licence.upper ? String(v || '').trim().toUpperCase() : String(v || '').trim();

/* Public shape of a zone — safe to hand to the browser. */
const pubZone = z => ({
  code: z.code, country: z.country, dial: z.dial, phoneLen: z.phoneLen,
  currency: z.currency, symbol: z.symbol, locale: z.locale, decimals: z.decimals,
  fx: z.fx, taxLabel: z.taxLabel, taxPercent: z.taxPercent,
  taxId: z.taxId, licence: z.licence, regionLabel: z.regionLabel,
  postcode: z.postcode, enabled: z.enabled !== false,
  fxAuto: z.fxAuto !== false, fxUpdatedAt: z.fxUpdatedAt || '', fxSource: z.fxSource || '',
  /* what this dealer may be quoted in, and which of them they are seeing */
  currencies: zoneCurrencies(z), quotedIn: z.quotedIn || z.currency
});

/* ==========================================================================
   DAILY EXCHANGE RATES

   Product prices are held in rupees and converted when a Gulf dealer looks at
   them. Left to a number typed in by hand, that conversion drifts away from
   reality — a rate six months stale is a discount or a price rise nobody
   decided to give. So the mid-market rate is fetched once a day and applied.

   Three things make that safe to do automatically:

     margin  the rate quoted to dealers is deliberately a little worse than
             mid-market, because the money has to come back through a bank that
             takes its cut. Set in Admin -> Zones; 0 quotes at mid-market.
     guard   a new rate more than N% away from the current one is NOT applied.
             A garbled response or a provider glitch would otherwise reprice the
             whole catalogue in one go. The admin is told and can accept it.
     pinning any zone can be taken off automatic and held at a fixed rate.

   Orders already store the rate they were placed at, so nothing that has
   already happened changes value when today's rate lands.
   ========================================================================== */
const FX_DEFAULTS = { fxAuto: '1', fxMargin: '1.5', fxGuard: '10', fxHour: '7' };
const fs_ = k => { const v = getSetting(k); return v === null || v === undefined || v === '' ? FX_DEFAULTS[k] : v; };
const fxMargin = () => { const v = parseFloat(fs_('fxMargin')); return isFinite(v) && v >= 0 && v <= 25 ? v : 0; };
const fxGuard = () => { const v = parseFloat(fs_('fxGuard')); return isFinite(v) && v > 0 && v <= 100 ? v : 10; };
const fxAutoOn = () => fs_('fxAuto') !== '0';

/* Two independent free sources, tried in order. Neither needs an API key, and
 * both quote per 1 INR. If the first is down the second keeps prices current
 * rather than freezing them at yesterday's number. */
const FX_SOURCES = [
  {
    name: 'exchangerate-api',
    url: 'https://open.er-api.com/v6/latest/INR',
    parse: d => (d && d.result === 'success' && d.rates) ? d.rates : null
  },
  {
    name: 'currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/inr.json',
    /* this one keys everything in lower case */
    parse: d => {
      const r = d && d.inr;
      if (!r) return null;
      const out = {};
      for (const k of Object.keys(r)) out[k.toUpperCase()] = r[k];
      return out;
    }
  }
];

async function fetchRates() {
  const tried = [];
  for (const src of FX_SOURCES) {
    try {
      const r = await fetch(src.url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { tried.push(src.name + ' HTTP ' + r.status); continue; }
      const rates = src.parse(await r.json());
      if (!rates) { tried.push(src.name + ' sent no rates'); continue; }
      /* a source that does not carry the currencies we sell in is no use */
      const need = Object.values(ZONES).filter(z => z.code !== DEFAULT_ZONE).map(z => z.currency);
      const missing = need.filter(c => !isFinite(rates[c]) || rates[c] <= 0);
      if (missing.length) { tried.push(src.name + ' missing ' + missing.join(',')); continue; }
      return { ok: true, rates, source: src.name };
    } catch (e) {
      tried.push(src.name + ' ' + (e.name === 'TimeoutError' ? 'timed out' : e.message));
    }
  }
  return { ok: false, status: tried.join('; ') || 'no source answered' };
}

/* Applies one zone's new rate, or explains why it did not. */
function applyRate(zoneDef, live, source, opts) {
  const o = opts || {};
  const row = db.prepare('SELECT * FROM zones WHERE code=?').get(zoneDef.code);
  const current = row && isFinite(row.fx) && row.fx > 0 ? row.fx : zoneDef.fx;
  /* fx is "local currency per 1 INR", so quoting a little MORE local currency
     is what covers the bank spread — hence plus, not minus.
     Rounded to 8 decimals: binary floating point otherwise leaves a tail like
     0.039075469999999994, which is the number the admin then sees in the box.
     Eight places is far finer than any currency here needs. */
  const rate = Math.round(live * (1 + fxMargin() / 100) * 1e8) / 1e8;
  const moved = Math.abs(rate - current) / current * 100;

  if (!o.force && moved > fxGuard()) {
    return { code: zoneDef.code, skipped: 'guard', movedPercent: +moved.toFixed(2),
             current, proposed: rate, base: live };
  }
  if (moved < 0.01) return { code: zoneDef.code, skipped: 'unchanged', current };

  db.prepare(`UPDATE zones SET fx=?, fx_base=?, fx_source=?, fx_checked_at=?, updated_at=? WHERE code=?`)
    .run(rate, live, source, now(), now(), zoneDef.code);
  db.prepare('INSERT INTO fx_history(code,base,rate,previous,source,note,at) VALUES(?,?,?,?,?,?,?)')
    .run(zoneDef.code, live, rate, current, source, o.note || '', now());
  return { code: zoneDef.code, updated: true, from: current, to: rate, base: live,
           movedPercent: +moved.toFixed(2) };
}

/**
 * Fetches today's rates and applies them to every zone still on automatic.
 * Never throws.
 *
 *   manual  run even when automatic updating is switched off — the admin
 *           pressing "Update now" is asking for this one check, not turning
 *           the feature back on.
 *   accept  apply a move the guard would otherwise hold back. This is a
 *           separate decision from running the check, so that pressing
 *           "Update now" can never silently push through a rate the admin
 *           has not seen.
 */
async function refreshRates(opts) {
  const o = opts || {};
  if (!o.manual && !fxAutoOn()) return { skipped: 'switched_off' };

  const r = await fetchRates();
  if (!r.ok) {
    setSetting('fxLastRun', now());
    setSetting('fxLastStatus', 'failed: ' + r.status);
    /* Prices carry on at the last known rate — stale is far better than zero.
       The admin is told, but at most once a day: a rate service that stays down
       would otherwise post a notification every hour, and a bell that cries
       every hour is a bell nobody reads. Pressing "Update now" always reports
       back directly, so this only governs the unattended runs. */
    const lastTold = getSetting('fxFailNotifiedAt');
    const quiet = lastTold && (Date.now() - new Date(lastTold).getTime()) < 24 * 60 * 60 * 1000;
    if (!o.manual && !quiet) {
      setSetting('fxFailNotifiedAt', now());
      notifyAdmin('zone', 'Exchange rates could not be updated',
        'Today\'s rate check did not get through (' + r.status + '). Dealer prices are still ' +
        'using the last rate we had, so nothing is broken — but if this keeps happening, check ' +
        'the rates by hand in Admin → Zones.');
    }
    return { ok: false, status: r.status };
  }
  setSetting('fxFailNotifiedAt', '');   // back in touch — a later outage is news again

  const results = [];
  const held = [];
  for (const z of Object.values(ZONES)) {
    if (z.code === DEFAULT_ZONE) continue;              // the rupee is the base
    const row = db.prepare('SELECT * FROM zones WHERE code=?').get(z.code);
    if (row && row.fx_auto === 0) { results.push({ code: z.code, skipped: 'pinned' }); continue; }
    const live = r.rates[z.currency];
    const out = applyRate(z, live, r.source, { force: o.accept, note: o.note || (o.manual ? 'manual' : 'daily') });
    /* even when nothing moved, record that we looked */
    db.prepare('UPDATE zones SET fx_checked_at=? WHERE code=?').run(now(), z.code);
    if (out.skipped === 'guard') held.push(out);
    results.push(out);
  }

  setSetting('fxLastRun', now());
  setSetting('fxLastStatus', 'ok via ' + r.source);
  setSetting('fxLastSource', r.source);

  if (held.length) {
    notifyAdmin('zone', 'Exchange rate moved further than expected',
      held.map(h => h.code + ': ' + h.current.toFixed(6) + ' → ' + h.proposed.toFixed(6) +
        ' (' + h.movedPercent + '%)').join('; ') +
      '. That is a bigger jump than the ' + fxGuard() + '% safety limit allows, so prices were left ' +
      'as they are. Open Admin → Zones and press Update now to accept it, or set the rate by hand.');
  }
  const changed = results.filter(x => x.updated);
  if (changed.length) console.log('Exchange rates updated via ' + r.source + ': ' +
    changed.map(c => c.code + ' ' + c.to.toFixed(6)).join(', '));
  return {
    ok: true, source: r.source, results, updated: changed.length,
    /* what the guard stopped, with the country names spelled out so the admin
       screen can ask a plain question rather than showing zone codes */
    held: held.map(h => ({ ...h, country: ZONES[h.code].country, currency: ZONES[h.code].currency }))
  };
}

/* Runs once a day. Checked hourly rather than timed exactly, because free
 * hosting restarts the process whenever it likes and a once-a-day timer would
 * simply never fire. */
function fxDue() {
  const last = getSetting('fxLastOk');
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > 20 * 60 * 60 * 1000;
}
async function fxTick() {
  if (!fxAutoOn() || !fxDue()) return;
  const r = await refreshRates({});
  if (r && r.ok) setSetting('fxLastOk', now());
}

/* The passwords the app has ever shipped with. Nobody may set one of these, and
 * the admin panel keeps saying so until the live one is changed. */
const DEFAULT_ADMIN_PASSWORDS = new Set(['Admin@123', 'admin123', 'Admin123', 'password']);
const usingDefaultAdminPassword = () => {
  const salt = getSetting('adminSalt'), hash = getSetting('adminHash');
  if (!salt || !hash) return false;
  for (const pw of DEFAULT_ADMIN_PASSWORDS) if (safeEqual(hashPw(pw, salt), hash)) return true;
  return false;
};

/* ---------- seed ---------- */
if (!getSetting('seeded')) {
  const seed = [
    ['XEON AC Bracket (2.7 Kg)', 'AC Brackets', '', 1299, 320],
    ['XEON AC Bracket (3 Kg)', 'AC Brackets', '', 1299, 335],
    ['XEON AC Bracket (3.5 Kg)', 'AC Brackets', '', 1299, 365],
    ['TITANIC AC Bracket (5 Kg)', 'AC Brackets', '', 1299, 550],
    ['XUV 700 Adjustable Trolley', 'Adjustable Trolleys', '', 2999, 690],
    ['XUV 300 Adjustable Trolley', 'Adjustable Trolleys', '', 2999, 545],
    ['Angle Trolly', 'Fixed Trolleys', '', 1999, 530],
    ['Front Load Trolly', 'Fixed Trolleys', '', 1999, 625],
  ];
  const ins = db.prepare('INSERT INTO products(id,name,cat,emoji,mrp,dealer,moq,active,sort) VALUES(?,?,?,?,?,?,50,1,?)');
  seed.forEach((s, i) => ins.run(uid('p'), s[0], s[1], s[2], s[3], s[4], i));
  const adminSalt = crypto.randomBytes(16).toString('hex');
  setSetting('adminEmail', process.env.ADMIN_EMAIL || 'admin@hpmpmanufacturerspvtltd.com');
  setSetting('adminSalt', adminSalt);
  setSetting('adminHash', hashPw(process.env.ADMIN_PASSWORD || 'Admin@123', adminSalt));
  setSetting('payeeName', 'HPMP Manufacturers Pvt Ltd');
  setSetting('bankName', ''); setSetting('accountNo', ''); setSetting('ifsc', '');
  setSetting('whatsapp', '+91 79952 65800');
  setSetting('seeded', '1');
  backfillMeta();
  console.log('Database seeded with product catalogue and default admin.');
}

/* ---------- auth middleware ---------- */
function auth(req, res, next) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (tok) {
    const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok);
    if (s) {
      /* An expired token is dropped here rather than left to linger, so a
         stolen one stops working on its own. */
      if (Date.now() - new Date(s.created_at || 0).getTime() > SESSION_TTL_MS) {
        db.prepare('DELETE FROM sessions WHERE token=?').run(tok);
      } else {
        const u = s.role === 'user' ? db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) : null;
        /* the account was deleted while the session was still open */
        if (s.role === 'user' && !u) db.prepare('DELETE FROM sessions WHERE token=?').run(tok);
        else { req.role = s.role; req.user = u; req.token = tok; }
      }
    }
  }
  next();
}
const requireAdmin = (req, res, next) => req.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const requireUser = (req, res, next) => (req.role === 'user' && req.user) ? next() : res.status(401).json({ error: 'Login required' });
const isDealer = req => req.role === 'user' && req.user && req.user.status === 'approved';
const pubUser = u => u && ({ country: u.country || DEFAULT_ZONE, licence: u.licence_no || '', id: u.id, name: u.name, phone: u.phone, email: u.email, company: u.company, gstin: u.gstin, type: u.type, addr: u.addr, city: u.city, state: u.state, pincode: u.pincode || '', whatsapp: u.whatsapp || u.phone || '', status: u.status, note: u.note, terms: u.terms || 'advance', creditDays: u.credit_days || 0, discount: u.discount || 0,
  mobileOk: !!u.mobile_ok, createdAt: u.created_at });

/* price this dealer pays for a product: their custom rate if set, else the standard dealer rate */
const customPrice = (userId, productId) => {
  if (!userId) return null;
  const r = db.prepare('SELECT price FROM dealer_prices WHERE user_id=? AND product_id=?').get(userId, productId);
  return r && isFinite(r.price) ? r.price : null;
};
/* The festive offer running today (highest percentage wins). Offers apply to
 * dealer prices only — guests always see plain MRP. */
function liveOffer() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT * FROM offers WHERE active=1
      AND (starts='' OR starts<=?) AND (ends='' OR ends>=?)
      ORDER BY percent DESC`).all(today, today);
  return rows[0] || null;
}
const pubOffer = o => o && ({ id: o.id, name: o.name, percent: o.percent, starts: o.starts || '', ends: o.ends || '', active: !!o.active });

/* What a dealer actually pays:
 *   base   = their custom rate if one is set, otherwise the standard dealer rate
 *   − their own approved discount %
 *   − the festive offer % running today
 * Both are percentages off the base and are applied one after the other. */
const rateFor = (user, p, offer) => {
  const c = user ? customPrice(user.id, p.id) : null;
  let rate = c !== null ? c : p.dealer;
  const own = user && isFinite(user.discount) ? Math.max(0, Math.min(90, user.discount)) : 0;
  if (own) rate = rate * (1 - own / 100);
  const off = offer === undefined ? liveOffer() : offer;
  if (off && isFinite(off.percent)) rate = rate * (1 - Math.max(0, Math.min(90, off.percent)) / 100);
  return Math.round(rate * 100) / 100;
};

/* ---------- notifications ---------- */
function notify(userId, kind, title, body, orderId) {
  db.prepare('INSERT INTO notifications(id,user_id,kind,title,body,order_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('n' + crypto.randomBytes(6).toString('hex'), String(userId), kind, title, body,
      orderId || '', new Date().toISOString());
  /* also reaches the phone when the app is closed */
  try { pushNotify(userId, title, body, kind); } catch (e) { /* push is best-effort */ }
}
const notifyAdmin = (kind, title, body, orderId) => notify('admin', kind, title, body, orderId);
/* Money for admin notifications and reminder texts. Pass the zone the amount is
 * in; without one it formats as rupees, which is what every pre-zone amount is. */
const fmtMoney = (n, z) => {
  const zz = z || ZONES[DEFAULT_ZONE];
  /* Round numbers read better plain; anything with a fractional part is written
     out in full, so a total never reaches the admin as "$829.2". */
  const frac = Math.abs(Number(n || 0) % 1) > 1e-9;
  return zz.symbol + (zz.symbol.length > 1 ? ' ' : '') +
    Number(n || 0).toLocaleString(zz.locale,
      { minimumFractionDigits: frac ? zz.decimals : 0, maximumFractionDigits: zz.decimals });
};
const pubNotif = n => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, orderId: n.order_id || '', createdAt: n.created_at, read: !!n.read_at });

/* ---------- the company's own details ----------
 * Who HPMP is, as it has to appear on a dispatch slip: legal name, address, the
 * GSTIN a customer's accounts team will look for, and a logo. Held in settings
 * rather than hard-coded, so the branding can be corrected without a deploy —
 * and so the same build serves a second company if it ever needs to.
 */
const COMPANY_FIELDS = ['coName', 'coGstin', 'coCin', 'coAddress', 'coCity',
  'coState', 'coPincode', 'coPhone', 'coEmail', 'coWebsite'];
const companyDetails = () => {
  const g = k => getSetting(k) || '';
  return {
    name: g('coName') || getSetting('payeeName') || 'HPMP Manufacturers Pvt Ltd',
    gstin: g('coGstin'), cin: g('coCin'),
    address: g('coAddress'), city: g('coCity'), state: g('coState'), pincode: g('coPincode'),
    phone: g('coPhone') || getSetting('whatsapp') || '', email: g('coEmail'),
    website: g('coWebsite'), logo: g('coLogo')
  };
};

const app = express();
/* Railway and Render both sit behind a proxy, so the forwarded header is what
 * carries the caller's real address into the rate limiters. */
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

/* Malformed JSON reaches the error handler as a SyntaxError; without this it
 * comes back as a stack trace in an HTML page. */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large — keep product photos under 3 MB.' });
  next(err);
});

app.use((req, res, next) => {
  /* The app is same-origin and self-contained apart from Razorpay's checkout
     script, so the policy can be tight. */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    /* Razorpay's checkout pulls a second script from its CDN. Listing only
       checkout.razorpay.com blocked it, which showed up as a CSP error the
       moment the payment sheet opened. */
    "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://cdn.razorpay.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com; " +
    "frame-src https://api.razorpay.com https://checkout.razorpay.com https://cdn.razorpay.com; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'");
  /* Nothing the API returns should ever be cached by a proxy — several
     responses are specific to the signed-in dealer. */
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const verifyAdminPw = pw => checkPw(pw, getSetting('adminSalt'), getSetting('adminHash'));
app.use(auth);

/* ---------- public API ---------- */
app.get('/api/products', (req, res) => {
  const dealer = isDealer(req);
  const offer = dealer ? liveOffer() : null;
  const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort').all();
  /* Prices live in INR. A signed-in dealer sees them in their own currency; a
     guest sees the zone they picked, falling back to India. Either may ask for
     the zone's alternate currency instead — USD, across the Gulf. */
  const z = quoteZone(zoneForRequest(req, req.query.zone), req);
  const c = v => toZone(v, z);
  /* One lookup for this dealer's whole custom price list, instead of two queries
     per product per request. */
  const custom = {};
  if (dealer) db.prepare('SELECT product_id, price FROM dealer_prices WHERE user_id=?')
    .all(req.user.id).forEach(r => { if (isFinite(r.price)) custom[r.product_id] = r.price; });
  res.json({
    zone: pubZone(z),
    offer: dealer ? pubOffer(offer) : null,
    products: rows.map(p => ({
      id: p.id, name: p.name, cat: p.cat, emoji: p.emoji, image: p.image || '', mrp: c(p.mrp), moq: p.moq,
      descr: p.descr || '', packing: packingForZone(p.packing || '', z, p),
      /* not gated on p.options: an AC bracket with no packing recorded at all
         still ships abroad in a carton of six, and the slip has to say so */
      options: scaleOptions(p.options, z, p),
      ...(dealer ? {
        dealer: c(rateFor(req.user, p, offer)),
        listDealer: c(custom[p.id] !== undefined ? custom[p.id] : p.dealer)
      } : {})
    }))
  });
});

/* Pack options carry a per-piece surcharge in INR ("+₹4 per set"), so it has to
 * travel through the same conversion as the price it is added to. */
/* ---------- packing differs by market ----------
 * India ships either way. A gunny bag is cheap, universal and what the local
 * trade expects, and the material is on a lorry for a day.
 *
 * An export consignment is not: it is handled several more times, sits in a
 * container, and passes through a customs shed. A bag arrives scuffed and the
 * powder coating is the whole point of the product. So everything leaving
 * India goes in cartons only — six sets to a master box, the size that stacks
 * and palletises cleanly.
 *
 * The rule lives here rather than in each product row, so it holds for any
 * product added later without someone having to remember it.
 */
const EXPORT_MASTER_QTY = 6;
const isExportZone = z => !z || z.code !== DEFAULT_ZONE;

/* The carton costs nothing extra abroad. In India the +₹4 / +₹6 buys the dealer
 * an upgrade from a gunny bag, so it is a real charge for a real choice. Abroad
 * the carton IS the packing — there is nothing to upgrade from — so an export
 * price is the rupee price converted, and nothing else. */

/* Is this an AC bracket / stand?
 *
 * Decided from the category first, so a product filed correctly is caught
 * whatever it is called, and from the name second, so one filed loosely is
 * still caught. A Mobile Stand is an accessory rather than a bracket despite
 * the word "stand", and a trolley is never a bracket — both keep their own
 * master packing. */
const isAcBracket = p => {
  if (!p) return false;
  const cat = String(p.cat || '').toLowerCase(), nm = String(p.name || '').toLowerCase();
  if (/mobile/.test(nm)) return false;
  if (/troll/.test(cat) || /troll/.test(nm)) return false;
  return /bracket/.test(cat) || /bracket/.test(nm) || /\bac stand\b/.test(nm)
      || /xeon|titanic/.test(nm);
};

/* Export packing.
 *
 * Every AC bracket leaves India the same way: cartons only, six sets to a
 * master box, whatever it is called and however it is packed at home. That is
 * a market rule, so it is applied by category rather than by matching product
 * names — a bracket added next year is covered without anyone remembering to
 * come back here.
 *
 * Nothing else is touched. A trolley goes out in a bundle of six (ten for the
 * XUV 300) and a Mobile Stand in a carton of fifty, in Hyderabad and in Dubai
 * alike, because those are facts about the product rather than choices of
 * market. Forcing every product to a six-piece carton would quietly have turned
 * the XUV 300 into six per bundle for export and relabelled bundles as boxes. */
function packsForZone(o, z, p) {
  if (!isExportZone(z)) return o;
  if (!isAcBracket(p)) return o;
  const packs = (o && Array.isArray(o.packs)) ? o.packs : [];
  const base = packs.find(k => k.id === 'box') || packs[packs.length - 1] || {};
  return { ...(o || {}), packs: [{
    ...base, id: 'box', label: 'Box packing',
    master: EXPORT_MASTER_QTY + ' pcs per master box', add: 0
  }] };
}

/* The prose beside the choice has to say the same thing. The opening line
 * describes what one set contains and is kept as written — including anything
 * the admin has edited; only the per-method lines are replaced. */
function packingForZone(text, z, p) {
  /* Only the brackets are standardised abroad, so only their note is rewritten.
     A trolley's or an accessory's note describes packing that does not change
     between markets and is left exactly as it is. */
  if (!isExportZone(z) || !isAcBracket(p)) return text || '';
  const kept = String(text || '').split('\n')
    .filter(l => l.trim() && !/^\s*(gunny bag|box)\s+packing\s*:/i.test(l)
                 && !/^\s*master packing\s*:/i.test(l));
  return kept.concat(
    'Export packing: cartons only — ' + EXPORT_MASTER_QTY +
    ' sets per master box, 5-ply corrugated, strapped and palletised. ' +
    'Gunny bag packing is not offered outside India: it does not survive container handling well ' +
    'enough to protect the powder coating.'
  ).join('\n');
}

function scaleOptions(json, z, p) {
  let o = null;
  if (json) { try { o = JSON.parse(json); } catch (e) { o = null; } }
  o = packsForZone(o, z, p);
  if (o && Array.isArray(o.packs)) o.packs = o.packs.map(pk => ({ ...pk, add: toZone(pk.add || 0, z) }));
  return o;
}

const rzpKeys = () => ({ id: getSetting('rzpKeyId') || '', secret: getSetting('rzpKeySecret') || '' });
const rzpEnabled = () => { const k = rzpKeys(); return !!(k.id && k.secret); };

app.get('/api/pay-info', (req, res) => {
  const z = quoteZone(zoneForRequest(req, req.query.zone), req);
  res.json({
    payeeName: getSetting('payeeName'),
    bankName: getSetting('bankName'), accountNo: getSetting('accountNo'),
    ifsc: getSetting('ifsc'), whatsapp: getSetting('whatsapp'),
    /* gstPercent stays for older app builds; taxPercent/taxLabel are the
       zone-aware pair the current client reads. */
    gstPercent: z.taxPercent, taxPercent: z.taxPercent, taxLabel: z.taxLabel,
    zone: pubZone(z),
    company: companyDetails(),
    /* Razorpay settles in INR only, so it is offered to Indian dealers alone. */
    razorpay: { enabled: rzpEnabled() && z.code === 'IN', keyId: (rzpEnabled() && z.code === 'IN') ? rzpKeys().id : '' },
    smsProvider: ss('smsProvider') || '', mailReady: mailReady()
  });
});

/* The zone table, for the registration form and the admin screen. */
app.get('/api/zones', (req, res) => {
  res.json(Object.keys(ZONES).map(c => pubZone(zoneLive(c))).filter(z => z.enabled));
});

/* ---------- admin: zones ---------- */
const fxStatus = () => ({
  auto: fxAutoOn(), margin: fxMargin(), guard: fxGuard(),
  lastRun: getSetting('fxLastRun') || '', lastOk: getSetting('fxLastOk') || '',
  lastStatus: getSetting('fxLastStatus') || 'not run yet',
  source: getSetting('fxLastSource') || ''
});

app.get('/api/admin/zones', requireAdmin, (req, res) => {
  res.json({
    fx: fxStatus(),
    zones: Object.keys(ZONES).map(c => {
      const z = zoneLive(c);
      const n = db.prepare("SELECT COUNT(*) n FROM users WHERE country=? AND status='approved'").get(c).n;
      const pend = db.prepare("SELECT COUNT(*) n FROM users WHERE country=? AND status IN ('pending','incomplete')").get(c).n;
      return { ...pubZone(z), dealers: n, pending: pend, baseFx: ZONES[c].fx, baseTax: ZONES[c].taxPercent,
        fxBase: z.fxBase, fxCheckedAt: z.fxCheckedAt };
    })
  });
});

/* The last few rate changes per zone, so "why was that order priced like that"
 * has an answer. */
app.get('/api/admin/fx/history', requireAdmin, (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  const rows = code && zoneOf(code)
    ? db.prepare('SELECT * FROM fx_history WHERE code=? ORDER BY id DESC LIMIT 40').all(code)
    : db.prepare('SELECT * FROM fx_history ORDER BY id DESC LIMIT 60').all();
  res.json(rows.map(r => ({ code: r.code, base: r.base, rate: r.rate, previous: r.previous,
    source: r.source, note: r.note || '', at: r.at })));
});

/* "Update now" — checks the market straight away rather than waiting for
 * tomorrow. The safety guard still applies: anything that moved too far comes
 * back in `held` for the admin to look at, and only a second call with
 * `accept` puts it through. */
app.post('/api/admin/fx/refresh', requireAdmin, async (req, res) => {
  const accept = !!req.body?.accept;
  const r = await refreshRates({ manual: true, accept, note: accept ? 'accepted by admin' : 'manual' });
  if (r && r.ok) setSetting('fxLastOk', now());
  res.json({ ...r, fx: fxStatus(), zones: Object.keys(ZONES).map(c => pubZone(zoneLive(c))) });
});

app.put('/api/admin/fx', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.auto !== undefined) setSetting('fxAuto', b.auto ? '1' : '0');
  if (b.margin !== undefined) {
    const m = parseFloat(b.margin);
    if (!isFinite(m) || m < 0 || m > 25)
      return res.status(400).json({ error: 'The margin must be between 0 and 25 percent.' });
    setSetting('fxMargin', m);
  }
  if (b.guard !== undefined) {
    const g = parseFloat(b.guard);
    if (!isFinite(g) || g <= 0 || g > 100)
      return res.status(400).json({ error: 'The safety limit must be between 1 and 100 percent.' });
    setSetting('fxGuard', g);
  }
  res.json({ ok: true, fx: fxStatus() });
});

app.post('/api/admin/zones', requireAdmin, (req, res) => {
  const rows = Array.isArray(req.body?.zones) ? req.body.zones : [];
  const upd = db.prepare('UPDATE zones SET fx=?, tax_percent=?, enabled=?, fx_auto=?, updated_at=? WHERE code=?');
  const notes = [];
  for (const r of rows) {
    const z = zoneOf(r.code);
    if (!z) continue;
    const fx = parseFloat(r.fx);
    const tax = parseFloat(r.taxPercent);
    if (!isFinite(fx) || fx <= 0) return res.status(400).json({ error: 'Enter a positive exchange rate for ' + z.country + '.' });
    if (!isFinite(tax) || tax < 0 || tax > 100) return res.status(400).json({ error: 'Enter a tax rate between 0 and 100 for ' + z.country + '.' });
    /* India is never switched off — it is the home market and the base currency. */
    const en = z.code === 'IN' ? 1 : (r.enabled ? 1 : 0);

    const cur = db.prepare('SELECT * FROM zones WHERE code=?').get(z.code);
    const wasAuto = !(cur && cur.fx_auto === 0);
    let auto = r.fxAuto === undefined ? wasAuto : !!r.fxAuto;
    /* Typing a rate by hand while the zone is on automatic is a contradiction:
       tomorrow's update would wipe it out and the admin would think the app had
       ignored them. Editing the number pins the zone, and we say so. */
    const edited = cur && Math.abs(fx - cur.fx) / cur.fx > 0.0001;
    if (edited && auto && r.fxAuto === undefined) {
      auto = false;
      notes.push(z.country + ' is now held at the rate you typed — it will not follow the daily rate until you switch it back to automatic.');
    }
    if (edited) db.prepare('INSERT INTO fx_history(code,base,rate,previous,source,note,at) VALUES(?,?,?,?,?,?,?)')
      .run(z.code, null, fx, cur ? cur.fx : null, 'admin', 'set by hand', now());

    upd.run(fx, tax, en, z.code === DEFAULT_ZONE ? 0 : (auto ? 1 : 0), now(), z.code);
    if (z.code === 'IN') setSetting('gstPercent', tax);
  }
  res.json({ ok: true, notes, fx: fxStatus(), zones: Object.keys(ZONES).map(c => pubZone(zoneLive(c))) });
});

/* ---------- GSTIN verification ---------- */
const GST_STATES = { '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh' };
const PAN_TYPE = { C: 'Private/Public company', P: 'Proprietor / Individual', F: 'Partnership firm', H: 'HUF', A: 'Association of persons', T: 'Trust', B: 'Body of individuals', L: 'Local authority', J: 'Artificial juridical person', G: 'Government' };
function gstinParse(g) {
  g = String(g || '').toUpperCase().trim();
  if (!GSTIN_RE.test(g)) return { valid: false };
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) { const m = cs.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(m / 36) + m % 36; }
  return {
    valid: true, gstin: g, checksumOk: cs[(36 - sum % 36) % 36] === g[14],
    stateCode: g.slice(0, 2), stateName: GST_STATES[g.slice(0, 2)] || '',
    pan: g.slice(2, 12), entityType: PAN_TYPE[g[5]] || ''
  };
}

app.get('/api/gstin/:g', async (req, res) => {
  const info = gstinParse(req.params.g);
  info.verified = false;
  if (!info.valid) return res.json(info);
  const key = getSetting('gstApiKey');
  /* The offline checksum is free and stays open — the form needs it while
     someone is typing. The paid lookup behind it does not: left unmetered,
     anyone could empty the AppyFlow balance from a loop. */
  const wait = rateLimit('gstin:' + clientIp(req), 30, 60 * 60 * 1000, 60 * 60 * 1000);
  if (key && !wait) {
    try {
      const r = await fetch('https://appyflow.in/api/verifyGST?gstNo=' + info.gstin + '&key_secret=' + encodeURIComponent(key), { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      const t = d && d.taxpayerInfo;
      if (t) {
        info.verified = true;
        info.legalName = t.lgnm || '';
        info.tradeName = t.tradeNam || '';
        info.gstStatus = t.sts || '';
        const a = t.pradr && t.pradr.addr;
        if (a) info.address = [a.bno, a.bnm, a.st, a.loc, a.dst, a.stcd, a.pncd].filter(Boolean).join(', ');
      }
    } catch (e) { /* lookup unavailable — offline info still returned */ }
  }
  res.json(info);
});

app.get('/api/transports', (req, res) => {
  res.json(db.prepare('SELECT * FROM transports ORDER BY name').all());
});

app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const f = {};
  for (const k of ['name', 'phone', 'email', 'password', 'company', 'gstin', 'type', 'addr', 'city', 'state', 'licence'])
    f[k] = String(b[k] || '').trim();
  f.pincode = String(b.pincode || '').trim();

  const z = zoneLive(b.country);
  if (!zoneOf(b.country)) return res.status(400).json({ error: 'Choose your country.' });
  if (!z.enabled) return res.status(400).json({ error: 'Registration for ' + z.country + ' is not open yet. Please contact us.' });
  f.country = z.code;
  f.gstin = normTaxId(f.gstin, z);
  f.licence = normLicence(f.licence, z);

  const waNum = String(b.whatsapp || '').trim() || f.phone;
  /* Everything except the country-specific fields, which are checked below. */
  for (const k of ['name', 'phone', 'email', 'password', 'company', 'type', 'addr', 'city', 'state'])
    if (!f[k]) return res.status(400).json({ error: 'Please fill all required fields.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (f.password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const zErr = zoneFieldError(f, z);
  if (zErr) return res.status(400).json({ error: zErr });
  const waNat = nationalDigits(waNum, z);
  if (waNat.length !== z.phoneLen) return res.status(400).json({ error: 'Enter a valid ' + z.phoneLen + '-digit WhatsApp number (without the +' + z.dial + ').' });

  if (f.email.toLowerCase() === String(getSetting('adminEmail')).toLowerCase()) return res.status(400).json({ error: 'This email is reserved.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(f.email)) return res.status(400).json({ error: 'An account with this email already exists — try logging in.' });
  /* Tax numbers are only unique within a country, and most zones now allow a
     blank one, so an empty value must never collide with another blank.
     The column is UNIQUE and SQLite permits any number of NULLs but only one
     empty string — so a blank is stored as NULL, not ''. Without that, the
     second dealer anywhere to register without a VAT number is refused with an
     unexplained server error. */
  if (f.gstin && db.prepare('SELECT 1 FROM users WHERE gstin=? AND country=?').get(f.gstin, f.country))
    return res.status(400).json({ error: 'This ' + z.taxId.label + ' is already registered — try logging in or contact support.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const id = uid('u');
  const mCode = otpCode();
  const phoneNat = nationalDigits(f.phone, z);
  db.prepare(`INSERT INTO users(id,name,phone,email,pass_hash,salt,company,gstin,type,addr,city,state,pincode,whatsapp,status,mobile_code,email_ok,created_at,country,licence_no)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,1,?,?,?)`)
    .run(id, f.name, phoneNat, f.email, hashPw(f.password, salt), salt, f.company, f.gstin || null, f.type, f.addr, f.city, f.state, f.pincode, waNat, mCode, now(), f.country, f.licence);
  notifyAdmin('registration', 'New registration — ' + f.company,
    f.name + ' (' + f.type + ') from ' + (f.city || '—') + ', ' + z.country + ', mobile +' + z.dial + ' ' + phoneNat +
    '. Verify the ' + (z.taxId ? z.taxId.label : 'business details') + ' and approve the account.');
  /* the verification code goes straight to their mobile */
  sendCode(db.prepare('SELECT * FROM users WHERE id=?').get(id), 'verification', mCode,
    'They have just registered.').catch(() => {});
  const token = newSession(id, 'user');
  res.json({ token, role: 'user', user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

/* Finds an account from whatever the customer typed: their registered email,
 * their mobile number or their WhatsApp number, with or without +91. */
function findAccount(idRaw) {
  const id = String(idRaw || '').trim();
  if (!id) return null;
  if (id.includes('@'))
    return db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(id) || null;
  const digits = id.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const clean = "replace(replace(replace(replace(%c,' ',''),'-',''),'+',''),'(','')";
  const norm = f => clean.replace('%c', f);
  /* Numbers arrive in every shape: +971 50 123 4567, 0501234567, or the bare
     national number. Resolve the country first where we can, and only fall
     back to tail matching when we cannot. */
  let u = null;

  /* Try the number's own country first. If it carries a dial code we serve —
     +973 3600 1234 — we know both the zone and the national part, so we can
     match precisely instead of guessing at a tail length. This has to come
     first: an 8-digit Gulf number typed with its country code matches none of
     the tail rules below, which is why it could never be found before. */
  const cc = countryFromDigits(digits);
  if (cc) {
    const z = ZONES[cc];
    const nat = nationalDigits(digits, z);
    if (nat.length === z.phoneLen) {
      u = db.prepare(`SELECT * FROM users WHERE (country=? OR country IS NULL OR country='')
          AND (${norm('phone')}=? OR ${norm('whatsapp')}=?)`).get(z.code, nat, nat) || null;
      /* the same national number could exist in another zone we serve */
      if (!u) u = db.prepare(`SELECT * FROM users WHERE ${norm('phone')}=? OR ${norm('whatsapp')}=?`)
        .get(nat, nat) || null;
    }
  }

  /* Typed without a country code, exactly as it is stored. */
  if (!u) {
    u = db.prepare(`SELECT * FROM users WHERE ${norm('phone')}=? OR ${norm('whatsapp')}=?`)
      .get(digits, digits) || null;
  }
  /* Last resort: match on the tail. Ten digits identifies an Indian mobile
     however it was typed; the shorter lengths cover the Gulf zones. Longest
     first, so a more specific match always wins. */
  if (!u) {
    for (const len of [10, 9, 8]) {
      if (digits.length < len) continue;
      const tail = digits.slice(-len);
      u = db.prepare(`SELECT * FROM users
          WHERE (length(${norm('phone')})=${len}    AND substr(${norm('phone')},    -${len})=?)
             OR (length(${norm('whatsapp')})=${len} AND substr(${norm('whatsapp')}, -${len})=?)`).get(tail, tail) || null;
      if (u) break;
    }
  }
  return u;
}

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || req.body?.id || '').trim();
  const password = String(req.body?.password || '');
  /* Two buckets: one stops a single account being ground through a word list,
     the other stops one machine working across many accounts. A real dealer
     mistyping their password never comes close to either, and a successful
     sign-in clears both.

     The account bucket does mean someone who knows a dealer's email can keep
     that dealer out for fifteen minutes by guessing at it. That is the accepted
     trade — the alternative is unlimited guessing — and it is why the limit sits
     at ten rather than the three or four you might otherwise pick. */
  const idKey = 'login:' + email.toLowerCase();
  const ipKey = 'loginip:' + clientIp(req);
  for (const key of [idKey, ipKey]) {
    const wait = rateLimit(key, key === idKey ? 10 : 40, 15 * 60 * 1000, 15 * 60 * 1000);
    if (wait) return res.status(429).json({ error: waitMsg(wait) });
  }

  if (email.toLowerCase() === String(getSetting('adminEmail')).toLowerCase()) {
    if (checkPw(password, getSetting('adminSalt'), getSetting('adminHash'))) {
      clearLimit(idKey); clearLimit(ipKey);
      const token = newSession(null, 'admin');
      return res.json({ token, role: 'admin' });
    }
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const u = findAccount(email);
  if (!u || !checkPw(password, u.salt, u.pass_hash))
    return res.status(401).json({ error: 'Those details did not match an account. Check the email or mobile number and password.' });
  clearLimit(idKey); clearLimit(ipKey);
  const token = newSession(u.id, 'user');
  res.json({ token, role: 'user', user: pubUser(u) });
});

/* ---------- mobile & email verification ----------
 * No SMS/email gateway is needed: the admin sees each pending code in the
 * Registrations tab and sends it to the customer on WhatsApp (one tap) or by
 * email. The customer types it back in, which proves the number is theirs. */
/* Five wrong guesses burns the code, everywhere a code is checked. Six digits
 * is only a million combinations — without a counter that is a short afternoon
 * of scripted requests, not a secret. */
const MAX_CODE_TRIES = 5;
app.post('/api/verify', requireUser, (req, res) => {
  const code = String(req.body?.code || '').trim();
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
  if (!u.mobile_code) return res.status(400).json({ error: 'No code was issued. Ask us to resend it.' });
  if ((u.verify_tries || 0) >= MAX_CODE_TRIES) {
    db.prepare("UPDATE users SET mobile_code='', verify_tries=0 WHERE id=?").run(u.id);
    return res.status(429).json({ error: 'Too many wrong attempts. Please ask for a new code.' });
  }
  if (!safeEqual(code, String(u.mobile_code))) {
    db.prepare('UPDATE users SET verify_tries=verify_tries+1 WHERE id=?').run(u.id);
    return res.status(400).json({ error: 'That code does not match. Please check and try again.' });
  }
  db.prepare('UPDATE users SET mobile_ok=1, email_ok=1, verify_tries=0 WHERE id=?').run(u.id);
  const after = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  notifyAdmin('registration', 'Mobile number verified',
    after.company + ' has verified their WhatsApp number. Ready for your approval.');
  res.json({ ok: true, user: pubUser(after) });
});

/* customer taps "resend" — same code, sent again over the gateway */
app.post('/api/verify/resend', requireUser, async (req, res) => {
  const wait = rateLimit('resend:' + req.user.id, 1, 60000, 60000);
  if (wait) return res.status(429).json({ error: 'Please wait a minute before asking for another code.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (u.mobile_ok) return res.status(400).json({ error: 'Already verified.' });
  let code = u.mobile_code;
  if (!code) {
    code = otpCode();
    db.prepare("UPDATE users SET mobile_code=?, verify_tries=0 WHERE id=?").run(code, u.id);
  }
  const r = await sendCode(db.prepare('SELECT * FROM users WHERE id=?').get(u.id), 'verification', code,
    'They asked for it again.');
  res.json({ ok: true, sent: r.ok, withAdmin: !r.ok, via: r.via || '' });
});

/* admin sends the code over the gateway on demand */
app.post('/api/admin/users/:id/sendcode', requireAdmin, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (!u.mobile_code) return res.status(400).json({ error: 'No code is pending for this account.' });
  const r = await sendCode(u, 'verification', u.mobile_code, 'Sent from the admin panel.');
  res.json({ ok: true, sent: r.ok, status: r.status, code: u.mobile_ok ? '' : u.mobile_code });
});

/* admin issues a fresh code (e.g. the customer changed number) */
app.post('/api/admin/users/:id/recode', requireAdmin, (req, res) => {
  const kind = 'mobile';
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const code = otpCode();
  db.prepare('UPDATE users SET mobile_code=?, mobile_ok=0 WHERE id=?').run(code, u.id);
  notify(u.id, 'verify', 'New verification code issued',
    'A fresh verification code is on its way to your mobile. Enter it on your profile screen.');
  sendCode(db.prepare('SELECT * FROM users WHERE id=?').get(u.id), 'verification', code, 'Reissued by admin.')
    .catch(() => {});
  res.json({ ok: true, code });
});

/* ---------- signing in with a mobile number ----------
 * The dealer types their number, we issue a 6-digit code that lasts 10 minutes
 * and send it over whichever channel is configured. With no gateway set up the
 * code lands in the admin panel and the team passes it on, exactly like the
 * verification codes. */
const OTP_WINDOW_MS = 10 * 60 * 1000;

app.post('/api/otp/request', async (req, res) => {
  const raw = String(req.body?.mobile || req.body?.id || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15)
    return res.status(400).json({ error: 'Enter a valid mobile number.' });

  const u = findAccount(raw);
  /* 45 seconds between codes for one number, and a ceiling on how many a single
     machine can trigger — every code sent costs money at the gateway. */
  const wait = rateLimit('otp:' + (u ? u.id : digits), 1, 45000, 45000)
    || rateLimit('otpip:' + clientIp(req), 20, 60 * 60 * 1000, 30 * 60 * 1000);
  if (wait) return res.status(429).json({ error: 'A code was just sent. Please wait a moment before asking again.' });

  const code = otpCode();
  let r;
  if (u) {
    db.prepare('UPDATE users SET login_code=?, login_at=?, login_tries=0 WHERE id=?').run(code, now(), u.id);
    r = await sendCode(u, 'login', code, 'They are signing in.');
  } else {
    /* nobody has this number yet — hold the code until they verify, then the
       account is created for them */
    db.prepare(`INSERT INTO otp_codes(mobile,code,created_at,tries) VALUES(?,?,?,0)
      ON CONFLICT(mobile) DO UPDATE SET code=excluded.code, created_at=excluded.created_at, tries=0`)
      .run(digits, code, now());
    r = await sendCode({ id: 'new:' + digits, phone: digits, whatsapp: digits, name: '', company: '', email: '' },
      'login', code, 'New number — they are signing in for the first time.');
  }
  const mask = digits.slice(-10).replace(/^(\d{2})\d{6}(\d{2})$/, '$1******$2');
  const maskMail = u ? String(u.email || '').replace(/^(.).*(@.*)$/, '$1•••$2') : '';
  res.json({ ok: true, sent: r.ok, withAdmin: !r.ok, via: r.via || '',
    to: r.via === 'email' ? maskMail : mask });
});

app.post('/api/otp/login', (req, res) => {
  const raw = String(req.body?.mobile || req.body?.id || '').trim();
  const digits = raw.replace(/\D/g, '');
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });

  /* A guess costs something whether or not the number belongs to anyone, so the
     address is capped before either branch is reached. */
  const ipWait = rateLimit('otploginip:' + clientIp(req), 40, 60 * 60 * 1000, 30 * 60 * 1000);
  if (ipWait) return res.status(429).json({ error: waitMsg(ipWait) });

  const u = findAccount(raw);

  /* someone we already know */
  if (u) {
    if (!u.login_code) return res.status(400).json({ error: 'Ask for a code first.' });
    const age = Date.now() - new Date(u.login_at || 0).getTime();
    if (!(age >= 0 && age < OTP_WINDOW_MS)) {
      db.prepare("UPDATE users SET login_code='', login_tries=0 WHERE id=?").run(u.id);
      return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
    }
    /* This is the counter that was missing: the new-number branch below has
       always had one, so an unregistered number was better protected than a
       real dealer's account. */
    if ((u.login_tries || 0) >= MAX_CODE_TRIES) {
      db.prepare("UPDATE users SET login_code='', login_at='', login_tries=0 WHERE id=?").run(u.id);
      return res.status(429).json({ error: 'Too many wrong attempts. Please ask for a new code.' });
    }
    if (!safeEqual(code, String(u.login_code))) {
      db.prepare('UPDATE users SET login_tries=login_tries+1 WHERE id=?').run(u.id);
      return res.status(400).json({ error: 'That code is not right. Please check and try again.' });
    }
    db.prepare("UPDATE users SET login_code='', login_at='', login_tries=0, mobile_ok=1 WHERE id=?").run(u.id);
    const token = newSession(u.id, 'user');
    const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
    return res.json({ token, role: 'user', user: pubUser(fresh),
      needsProfile: fresh.status === 'incomplete' });
  }

  /* a number we have never seen — check the held code, then start their account */
  const row = db.prepare('SELECT * FROM otp_codes WHERE mobile=?').get(digits);
  if (!row) return res.status(400).json({ error: 'Ask for a code first.' });
  if ((row.tries || 0) >= MAX_CODE_TRIES) {
    db.prepare('DELETE FROM otp_codes WHERE mobile=?').run(digits);
    return res.status(429).json({ error: 'Too many wrong attempts. Please ask for a new code.' });
  }
  const age = Date.now() - new Date(row.created_at || 0).getTime();
  if (!(age >= 0 && age < OTP_WINDOW_MS)) {
    db.prepare('DELETE FROM otp_codes WHERE mobile=?').run(digits);
    return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
  }
  if (!safeEqual(code, String(row.code))) {
    db.prepare('UPDATE otp_codes SET tries=tries+1 WHERE mobile=?').run(digits);
    return res.status(400).json({ error: 'That code is not right. Please check and try again.' });
  }

  db.prepare('DELETE FROM otp_codes WHERE mobile=?').run(digits);
  const id = uid('u');
  const salt = crypto.randomBytes(16).toString('hex');
  /* The dial code they verified on tells us which country they are in, so the
     details form that follows already shows the right tax fields. */
  const cc = countryFromDigits(digits);
  const ten = nationalDigits(digits, ZONES[cc]);
  db.prepare(`INSERT INTO users(id,name,phone,email,pass_hash,salt,company,gstin,type,addr,city,state,pincode,
      whatsapp,status,mobile_ok,email_ok,created_at,country,licence_no)
    VALUES(?,'',?,?,?,?,'',NULL,'Dealer','','','','',?,'incomplete',1,1,?,?,'')`)
    .run(id, ten, id + '@pending.bluewave', hashPw(crypto.randomBytes(12).toString('hex'), salt), salt, ten, now(), cc);
  const token = newSession(id, 'user');
  res.json({ token, role: 'user', user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)),
    needsProfile: true });
});

/* the details a first-time customer fills in after verifying their number */
app.post('/api/me/complete', requireUser, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (u.status !== 'incomplete')
    return res.status(400).json({ error: 'This account is already registered.' });

  const b = req.body || {};
  const f = {};
  for (const k of ['name', 'email', 'company', 'gstin', 'type', 'addr', 'city', 'state', 'licence'])
    f[k] = String(b[k] || '').trim();
  f.pincode = String(b.pincode || '').trim();

  /* They may correct the country the OTP guessed — e.g. an Indian mobile on a
     UAE trade licence — so the posted value wins when it is a zone we serve. */
  const z = zoneLive(b.country || u.country);
  if (!z.enabled) return res.status(400).json({ error: 'Registration for ' + z.country + ' is not open yet. Please contact us.' });
  f.country = z.code;
  f.gstin = normTaxId(f.gstin, z);
  f.licence = normLicence(f.licence, z);
  const phone = nationalDigits(String(b.phone || u.phone || ''), z);
  const waNum = nationalDigits(String(b.whatsapp || ''), z) || phone;
  f.phone = phone;

  if (!f.name || !f.company || !f.email || !f.addr || !f.city || !f.state)
    return res.status(400).json({ error: 'Please fill in every required field.' });
  if (!/^\S+@\S+\.\S+$/.test(f.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const zErr = zoneFieldError(f, z);
  if (zErr) return res.status(400).json({ error: zErr });
  if (f.email.toLowerCase() === String(getSetting('adminEmail')).toLowerCase())
    return res.status(400).json({ error: 'This email is reserved.' });
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?) AND id<>?').get(f.email, u.id))
    return res.status(400).json({ error: 'An account with this email already exists.' });
  if (f.gstin && db.prepare('SELECT 1 FROM users WHERE gstin=? AND country=? AND id<>?').get(f.gstin, f.country, u.id))
    return res.status(400).json({ error: 'This ' + z.taxId.label + ' is already registered — please contact us.' });

  const type = ['Dealer', 'Distributor', 'Retailer', 'Contractor'].includes(f.type) ? f.type : 'Dealer';
  let hash = u.pass_hash, salt = u.salt;
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    salt = crypto.randomBytes(16).toString('hex');
    hash = hashPw(String(b.password), salt);
  }
  db.prepare(`UPDATE users SET name=?, email=?, company=?, gstin=?, type=?, addr=?, city=?, state=?,
      pincode=?, phone=?, whatsapp=?, pass_hash=?, salt=?, country=?, licence_no=?, status='pending' WHERE id=?`)
    .run(f.name, f.email, f.company, f.gstin || null, type, f.addr, f.city, f.state, f.pincode,
      phone, waNum, hash, salt, f.country, f.licence, u.id);

  notifyAdmin('registration', 'New registration — ' + f.company,
    f.name + ' (' + type + ') from ' + (f.city || '—') + ', ' + z.country + ', mobile +' + z.dial + ' ' + phone +
    '. Number already verified by OTP. Check the ' + (z.taxId ? z.taxId.label : 'business details') + ' and approve.');
  res.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});

/* ---------- forgotten password ----------
 * Back now that codes actually reach the customer: a 6-digit code by SMS, good
 * for 30 minutes, then they set a new password. */
const RESET_WINDOW_MS = 30 * 60 * 1000;

app.post('/api/forgot', async (req, res) => {
  const idRaw = String(req.body?.id || req.body?.mobile || '').trim();
  if (!idRaw) return res.status(400).json({ error: 'Enter your registered email or mobile number.' });
  const ipWait = rateLimit('forgotip:' + clientIp(req), 20, 60 * 60 * 1000, 30 * 60 * 1000);
  if (ipWait) return res.status(429).json({ error: waitMsg(ipWait) });
  const u = findAccount(idRaw);
  const generic = { ok: true, sent: false, hint: 'If that account is registered, a code is on its way.' };
  if (!u) return res.json(generic);
  if (rateLimit('forgot:' + u.id, 1, 45000, 45000))
    return res.status(429).json({ error: 'A code was just sent. Please wait a moment before asking again.' });
  const code = otpCode();
  db.prepare('UPDATE users SET reset_code=?, reset_at=?, reset_tries=0 WHERE id=?').run(code, now(), u.id);
  const r = await sendCode(u, 'password reset', code, 'They asked to reset their password.');
  const to = String(u.whatsapp || u.phone || '').replace(/\D/g, '').slice(-10);
  const maskMail = String(u.email || '').replace(/^(.).*(@.*)$/, '$1•••$2');
  res.json({ ok: true, sent: r.ok, withAdmin: !r.ok, via: r.via || '',
    to: r.via === 'email' ? maskMail : to.replace(/^(\d{2})\d{6}(\d{2})$/, '$1******$2') });
});

app.post('/api/reset', (req, res) => {
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
  if (password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const ipWait = rateLimit('resetip:' + clientIp(req), 40, 60 * 60 * 1000, 30 * 60 * 1000);
  if (ipWait) return res.status(429).json({ error: waitMsg(ipWait) });
  const u = findAccount(String(req.body?.id || req.body?.mobile || ''));
  if (!u || !u.reset_code) return res.status(400).json({ error: 'No reset is pending for that account. Ask for a new code.' });
  const age = Date.now() - new Date(u.reset_at || 0).getTime();
  if (!(age >= 0 && age < RESET_WINDOW_MS)) {
    db.prepare("UPDATE users SET reset_code='', reset_tries=0 WHERE id=?").run(u.id);
    return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
  }
  /* A reset code hands over the whole account, so it gets the same five-guess
     ceiling as every other code. */
  if ((u.reset_tries || 0) >= MAX_CODE_TRIES) {
    db.prepare("UPDATE users SET reset_code='', reset_at='', reset_tries=0 WHERE id=?").run(u.id);
    return res.status(429).json({ error: 'Too many wrong attempts. Please ask for a new code.' });
  }
  if (!safeEqual(code, String(u.reset_code))) {
    db.prepare('UPDATE users SET reset_tries=reset_tries+1 WHERE id=?').run(u.id);
    return res.status(400).json({ error: 'That code does not match. Please check and try again.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE users SET pass_hash=?, salt=?, reset_code='', reset_at='', reset_tries=0 WHERE id=?")
    .run(hashPw(password, salt), salt, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  notify(u.id, 'verify', 'Password changed', 'Your password was reset. Sign in with the new one.');
  res.json({ ok: true });
});

app.post('/api/admin/mail-test', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(to)) return res.status(400).json({ error: 'Enter an email address to test with.' });
  const r = await sendMail(to, 'Blue Wave test email',
    'This is a test from your Blue Wave admin panel. If you can read this, one-time codes can be emailed to your dealers.');
  db.prepare('INSERT INTO reminders(order_id,kind,channel,phone,message,status,sent_at) VALUES(?,?,?,?,?,?,?)')
    .run('test', 'mail_test', 'email', to, 'mail test', r.ok ? 'sent' : r.status, now());
  res.json({ ok: r.ok, status: r.status, detail: r.detail || '' });
});

/* what was actually attempted, newest first — the quickest way to see why a
   message never arrived */
app.get('/api/admin/sms-log', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT kind, channel, phone, status, sent_at FROM reminders
    ORDER BY id DESC LIMIT 20`).all());
});

/* let the admin prove the gateway works before dealers rely on it */
app.post('/api/admin/sms-test', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!to.replace(/\D/g, '')) return res.status(400).json({ error: 'Enter a mobile number to test with.' });
  const r = await sendSms(to, 'Blue Wave test message: your SMS gateway is working. 123456', '123456');
  db.prepare('INSERT INTO reminders(order_id,kind,channel,phone,message,status,sent_at) VALUES(?,?,?,?,?,?,?)')
    .run('test', 'sms_test', ss('smsProvider') || 'none', to, 'gateway test',
      (r.ok ? 'sent' : r.status) + (r.detail ? ' — ' + r.detail : ''), now());
  res.json({
    ok: r.ok, status: r.status, detail: r.detail || '', provider: ss('smsProvider') || '',
    sentTo: intlNumber(to),
    configured: {
      msg91: !!getSetting('smsKey'), fast2sms: !!getSetting('smsKey'),
      twilio: !!(getSetting('twilioSid') && getSetting('twilioToken') && getSetting('twilioFrom')),
      whatsapp: !!(getSetting('waPhoneId') && getSetting('waToken'))
    }
  });
});

app.get('/api/me', (req, res) => {
  if (req.role === 'admin') return res.json({ role: 'admin' });
  if (req.role === 'user' && req.user) return res.json({ role: 'user', user: pubUser(req.user) });
  res.json({ role: null });
});

app.post('/api/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
  res.json({ ok: true });
});

app.post('/api/me/password', requireUser, (req, res) => {
  const u = req.user;
  if (!checkPw(req.body?.current, u.salt, u.pass_hash))
    return res.status(400).json({ error: 'Current password is incorrect.' });
  const np = String(req.body?.newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hashPw(np, salt), salt, u.id);
  res.json({ ok: true });
});

app.put('/api/me', requireUser, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const f = {};
  for (const k of ['addr', 'city', 'state', 'phone', 'pincode', 'whatsapp']) f[k] = b[k] !== undefined ? String(b[k]).trim() : (u[k] || '');
  const z = zoneOfUser(u);
  if (!f.addr || !f.city || !f.state) return res.status(400).json({ error: 'Address, city and ' + z.regionLabel.toLowerCase() + ' are required.' });
  if (nationalDigits(f.phone, z).length !== z.phoneLen)
    return res.status(400).json({ error: 'Enter a valid ' + z.phoneLen + '-digit phone number.' });
  if (f.pincode && z.postcode && !new RegExp(z.postcode.re).test(f.pincode))
    return res.status(400).json({ error: 'Enter a valid ' + z.postcode.hint + '.' });
  if (f.whatsapp && nationalDigits(f.whatsapp, z).length !== z.phoneLen)
    return res.status(400).json({ error: 'Enter a valid ' + z.phoneLen + '-digit WhatsApp number.' });
  db.prepare('UPDATE users SET addr=?, city=?, state=?, phone=?, pincode=?, whatsapp=? WHERE id=?')
    .run(f.addr, f.city, f.state, nationalDigits(f.phone, z), f.pincode, nationalDigits(f.whatsapp || f.phone, z), u.id);
  res.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});

/* Order numbers run BW + YYMM + serial for that month:
 * BW2607001 = July 2026, first order of the month. Serial restarts each month. */
function nextOrderId() {
  const d = new Date();
  const prefix = 'BW' + String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
  /* counter is kept per month so a deleted order never frees its number */
  const counter = parseInt(getSetting('seq_' + prefix)) || 0;
  const last = db.prepare('SELECT id FROM orders WHERE id LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%');
  let highest = counter;
  if (last) { const v = parseInt(String(last.id).slice(prefix.length), 10); if (isFinite(v) && v > highest) highest = v; }
  const n = highest + 1;
  setSetting('seq_' + prefix, n);
  return prefix + String(n).padStart(3, '0');
}

/* ---------- orders ---------- */
app.post('/api/orders', (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const addr = String(b.addr || '').trim();
  if (!items.length) return res.status(400).json({ error: 'Cart is empty.' });
  if (!addr) return res.status(400).json({ error: 'Delivery address is required.' });
  let contact;
  if (req.role === 'user' && req.user) {
    const u = req.user;
    contact = { name: u.name, phone: u.phone, whatsapp: u.whatsapp || u.phone, email: u.email, company: u.company, gstin: u.gstin };
  } else {
    contact = { name: String(b.name || '').trim(), phone: String(b.phone || '').trim(), whatsapp: String(b.whatsapp || b.phone || '').trim(), email: String(b.email || '').trim(), company: '', gstin: '' };
    if (!contact.name || !contact.phone) return res.status(400).json({ error: 'Name and phone are required.' });
  }
  const dealer = isDealer(req);
  /* The order is written in the currency the dealer was quoted in — that is the
     figure they agreed to and the one their invoice has to show. Across the
     Gulf that is either the local currency or dollars, whichever they were
     looking at when they placed it. */
  const z = quoteZone(zoneForRequest(req, b.zone), req);
  const lines = [];
  for (const it of items) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(String(it.pid));
    const qty = Math.floor(Number(it.qty));
    if (!p || !qty || qty < 1) return res.status(400).json({ error: 'Invalid item in cart.' });
    let rate = toZone(dealer ? rateFor(req.user, p) : p.mrp, z);
    let label = p.name;
    /* Filtered for the market first, so an export order cannot ask for gunny
       packing — whether from an old app build, a stale cart or a hand-made
       request. Outside India the only entry left is the carton, and that is
       what gets priced and printed on the dispatch slip. */
    const opts = packsForZone(p.options ? JSON.parse(p.options) : null, z, p);
    /* Held aside for the dispatch slip: how the goods are packed and how many
       go in a master box. Snapshotted onto the line rather than looked up when
       the slip is printed, because master quantities differ by market and can
       be edited later — a slip reprinted next year must still describe the
       consignment that actually left the building. */
    let packId = '', packLabel = '', master = '', perBox = 0, size = '';
    if (opts && opts.packs && opts.packs.length) {
      const pk = opts.packs.find(x => x.id === String(it.pack || 'gunny')) || opts.packs[0];
      const add = toZone(pk.add || 0, z);
      rate = Math.round((rate + add) * Math.pow(10, z.decimals)) / Math.pow(10, z.decimals);
      label += ' — ' + pk.label + (add ? ' (+' + z.symbol + add + '/pc)' : '');
      packId = pk.id; packLabel = pk.label; master = pk.master || '';
      const m = /(\d+)/.exec(master);           // "6 pcs per master box" -> 6
      perBox = m ? parseInt(m[1], 10) : 0;
    }
    if (opts && opts.sizes) {
      const sz = String(it.size || '');
      if (!opts.sizes.includes(sz)) return res.status(400).json({ error: 'Please choose a size for ' + p.name + '.' });
      label += ' — ' + sz;
      size = sz;
    }
    lines.push({ pid: p.id, name: label, qty, rate, product: p.name,
      pack: packId, packLabel, master, perBox, size });
  }
  /* Prices are tax-inclusive: total = listed price; tax = the portion within it.
     A zone with no VAT yet (Qatar, Kuwait) simply books zero. */
  const subtotal = lines.reduce((s, l) => s + l.rate * l.qty, 0);
  const r = z.taxPercent;
  const gst = r > 0 ? Math.round((subtotal - subtotal / (1 + r / 100)) * 100) / 100 : 0;
  const total = subtotal;
  const transport = String(b.transport || '').trim().slice(0, 80);
  const id = nextOrderId();
  /* Signed-in orders are protected by the account; a guest order gets its own
     secret instead, returned once, to whoever placed it. */
  const guestToken = req.user ? '' : crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO orders(id,user_id,contact_json,addr,notes,items_json,subtotal,gst,total,tier,status,transport,created_at,country,currency,fx_rate,tax_percent,tax_label,guest_token)
    VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?,?,?,?,?,?,?)`)
    .run(id, req.user ? req.user.id : null, JSON.stringify(contact), addr, String(b.notes || '').trim(), JSON.stringify(lines), subtotal, gst, total, dealer ? 'dealer' : 'mrp', transport, now(),
      z.code, z.currency, z.fx, r, z.taxLabel, guestToken);
  const out = orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
  if (guestToken) out.accessToken = guestToken;
  res.json({ order: out });
});

/* Orders placed before multi-zone have no snapshot, so they read as Indian
 * rupees at the global GST rate — exactly what they were. */
const orderZone = o => {
  const z = zoneLive(o.country || DEFAULT_ZONE);
  /* Careful: isFinite(null) is true and null >= 0 is true, so a NULL column
     would sail through a naive check and come back out as null. */
  const tax = (o.tax_percent !== null && o.tax_percent !== undefined
               && isFinite(o.tax_percent) && o.tax_percent >= 0) ? o.tax_percent : gstPercent();
  /* An order placed in the zone's alternate currency has to be *shown* in that
     currency as well — symbol, decimal places and number formatting all follow
     the money, not the country. Taking only the currency code from the order
     and the rest from the zone is how a dollar total ends up printed as
     "AED 13.82" on the dealer's own invoice. */
  const cur = o.currency || z.currency;
  const disp = cur === z.currency ? z : (Object.values(ZONES).find(x => x.currency === cur) || z);
  return { ...z, currency: cur, symbol: disp.symbol, decimals: disp.decimals, locale: disp.locale,
    taxPercent: tax, taxLabel: o.tax_label || z.taxLabel };
};

/* Each of these used to be recomputed six times per order, and every call went
 * back to SQLite for the zone and the GST setting. Once is enough. */
const orderOut = o => {
  const z = orderZone(o);
  return {
    id: o.id, userId: o.user_id, contact: JSON.parse(o.contact_json), addr: o.addr, notes: o.notes,
    items: JSON.parse(o.items_json), subtotal: o.subtotal, gst: o.gst, total: o.total,
    country: o.country || DEFAULT_ZONE, currency: z.currency, symbol: z.symbol,
    decimals: z.decimals, locale: z.locale,
    taxPercent: z.taxPercent, taxLabel: z.taxLabel, fxRate: o.fx_rate || 1,
    /* What the customer's tax number is called where they are — GSTIN in India,
       VAT across the Gulf, EIN in the States. Carried on the order itself, so a
       slip printed years later still reads correctly even if that zone has
       since been switched off. */
    taxIdLabel: (z.taxId && (z.taxId.short || z.taxId.label)) || 'Tax no.',
    gstPercent: z.taxPercent, tier: o.tier, status: o.status, payRef: o.pay_ref,
    transport: o.transport || '', lrNumber: o.lr_number || '', dispatchTransport: o.dispatch_transport || '',
    dispatchMode: o.dispatch_mode || '', vehicleNo: o.vehicle_no || '', driverName: o.driver_name || '', driverPhone: o.driver_phone || '',
    dispatchedAt: o.dispatched_at || '', creditDue: o.credit_due || '', creditSettled: !!o.credit_settled,
    createdAt: o.created_at
  };
};

/* Who may see or act on an order.
 *   admin                      — always
 *   the dealer who placed it   — their own only
 *   a guest                    — only with the secret handed back at checkout
 * The old rule read `if (o.user_id && ...)`, which skipped the check entirely
 * for guest orders because theirs is NULL. Order numbers run in sequence, so
 * that made every guest's name, phone, address and basket public. */
function mayAccessOrder(req, o) {
  if (req.role === 'admin') return true;
  if (o.user_id) return !!(req.user && req.user.id === o.user_id);
  const supplied = String(req.get('X-Order-Token') || req.query.t || req.body?.orderToken || '');
  return !!o.guest_token && safeEqual(supplied, o.guest_token);
}
/* Loads the order and checks access in one step; returns null once it has
 * answered the request itself. Deliberately answers 404 either way, so the
 * endpoint cannot be used to confirm which order numbers exist. */
function orderFor(req, res) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o || !mayAccessOrder(req, o)) {
    res.status(404).json({ error: 'Order not found.' });
    return null;
  }
  return o;
}

app.get('/api/my/orders', requireUser, (req, res) => {
  res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.user.id).map(orderOut));
});

app.get('/api/orders/:id', (req, res) => {
  const o = orderFor(req, res); if (!o) return;
  res.json(orderOut(o));
});

app.post('/api/orders/:id/payment', (req, res) => {
  const o = orderFor(req, res); if (!o) return;
  const ref = String(req.body?.payRef || '').trim();
  if (!ref) return res.status(400).json({ error: 'Payment reference is required.' });
  if (o.status !== 'awaiting_payment') return res.status(400).json({ error: 'Payment already recorded for this order.' });
  db.prepare("UPDATE orders SET pay_ref=?, status='payment_submitted' WHERE id=?").run(ref, o.id);
  const who = (() => { try { return JSON.parse(o.contact_json || '{}'); } catch (e) { return {}; } })();
  notifyAdmin('order', 'New order ' + o.id,
    (who.company || who.name || 'Customer') + ' — ' + fmtMoney(o.total, orderZone(o)) + ', payment reference ' + ref + '. Confirm and dispatch.', o.id);
  if (o.user_id) notify(o.user_id, 'order', 'Order ' + o.id + ' received',
    'We have your payment details and are checking them. You will get an update when the order is confirmed.', o.id);
  res.json({ ok: true, order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)) });
});

/* ---------- Razorpay gateway ----------
 * Razorpay settles in these currencies for an Indian merchant account. A zone
 * outside this list falls back to bank transfer rather than being billed the
 * right number in the wrong currency. AED and SAR need international payments
 * enabled on the account; if they are not, the gateway itself will say so. */
const RZP_CURRENCIES = new Set(['INR', 'AED', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'USD']);

app.post('/api/orders/:id/rzp-order', async (req, res) => {
  if (!rzpEnabled()) return res.status(400).json({ error: 'Online payment is not enabled yet. Please pay by UPI/bank transfer.' });
  const o = orderFor(req, res); if (!o) return;
  if (o.status !== 'awaiting_payment') return res.status(400).json({ error: 'Payment already recorded for this order.' });
  /* The order total is held in the dealer's own currency. Sending it to
     Razorpay labelled INR charged a 1,000 AED order as ₹1,000 — roughly a
     96% discount. The currency and the minor-unit scale both have to come
     from the order's own zone. */
  const oz = orderZone(o);
  const currency = o.currency || oz.currency || 'INR';
  const minor = Math.round(o.total * Math.pow(10, oz.decimals));
  if (!RZP_CURRENCIES.has(currency))
    return res.status(400).json({ error: 'Online card payment is not available for ' + currency +
      ' orders yet. Please pay by bank transfer — the details are on this screen.' });
  const k = rzpKeys();
  try {
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(k.id + ':' + k.secret).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: minor, currency, receipt: o.id }),
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json();
    if (!r.ok || !d.id) return res.status(502).json({ error: (d.error && d.error.description) || 'Payment gateway error — try UPI/bank transfer instead.' });
    db.prepare('UPDATE orders SET rzp_order_id=? WHERE id=?').run(d.id, o.id);
    res.json({ rzpOrderId: d.id, keyId: k.id, amount: minor, currency, name: getSetting('payeeName'), contact: JSON.parse(o.contact_json) });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach payment gateway — try UPI/bank transfer instead.' });
  }
});

app.post('/api/orders/:id/rzp-verify', (req, res) => {
  if (!rzpEnabled()) return res.status(400).json({ error: 'Online payment is not enabled.' });
  const o = orderFor(req, res); if (!o) return;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: 'Missing payment details.' });
  if (o.rzp_order_id !== razorpay_order_id) return res.status(400).json({ error: 'Payment does not match this order.' });
  const expected = crypto.createHmac('sha256', rzpKeys().secret)
    .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(razorpay_signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(400).json({ error: 'Payment verification failed. If money was deducted, contact us with your payment ID.' });
  db.prepare("UPDATE orders SET status='paid', pay_ref=? WHERE id=?").run('Razorpay ' + razorpay_payment_id, o.id);
  res.json({ ok: true, order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)) });
});

/* ---------- admin API ---------- */
/* ================= WEB PUSH =================
 * Real background / lock-screen notifications, sent straight from this server
 * using the Web Push protocol: VAPID (ES256 JWT) for identifying ourselves and
 * aes128gcm for encrypting the payload. No third-party service, no npm package.
 * ============================================ */
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = str => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* our permanent identity for push; generated once and kept in settings */
function vapidKeys() {
  let pub = getSetting('vapidPub'), priv = getSetting('vapidPriv');
  if (!pub || !priv) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pub = b64url(kp.publicKey.export({ type: 'spki', format: 'der' }).slice(-65));
    priv = b64url(kp.privateKey.export({ type: 'pkcs8', format: 'der' }));
    setSetting('vapidPub', pub); setSetting('vapidPriv', priv);
  }
  return { pub, priv };
}
const vapidPrivKey = () => crypto.createPrivateKey({
  key: unb64url(vapidKeys().priv), format: 'der', type: 'pkcs8'
});

/* ES256 JWT proving the push came from us */
function vapidHeaders(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:' + (getSetting('adminEmail') || 'admin@example.com')
  }));
  const der = crypto.sign('sha256', Buffer.from(head + '.' + body), vapidPrivKey());
  /* DER (r,s) → raw 64-byte signature the spec expects */
  let off = 2; if (der[1] & 0x80) off += der[1] & 0x7f;
  const rLen = der[off + 1]; let r = der.slice(off + 2, off + 2 + rLen);
  const sOff = off + 2 + rLen; const sLen = der[sOff + 1];
  let sg = der.slice(sOff + 2, sOff + 2 + sLen);
  const pad = b => b.length >= 32 ? b.slice(b.length - 32) : Buffer.concat([Buffer.alloc(32 - b.length), b]);
  const sig = b64url(Buffer.concat([pad(r), pad(sg)]));
  return {
    Authorization: 'vapid t=' + head + '.' + body + '.' + sig + ', k=' + vapidKeys().pub,
    'Content-Encoding': 'aes128gcm',
    TTL: '86400'
  };
}

function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])])).digest().slice(0, len);
}

/* encrypt one payload for one subscription (RFC 8291) */
function encryptPush(sub, payload) {
  const clientPub = unb64url(sub.p256dh);
  const authSecret = unb64url(sub.auth);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPub);
  const salt = crypto.randomBytes(16);
  const prkInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), clientPub, serverPub
  ]);
  const ikm = hkdf(authSecret, shared, prkInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);  // padding delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([serverPub.length]), serverPub, body]);
}

async function pushToSub(sub, data) {
  try {
    const body = encryptPush(sub, JSON.stringify(data));
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { ...vapidHeaders(sub.endpoint), 'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length) },
      body, signal: AbortSignal.timeout(10000)
    });
    /* the browser tells us when a device has uninstalled or expired */
    if (r.status === 404 || r.status === 410) db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id);
    return r.ok;
  } catch (e) { return false; }
}

/* fire-and-forget: every in-app notification also goes out as a real push */
function pushNotify(userId, title, body, kind) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id=?').all(String(userId));
  if (!subs.length) return;
  const data = { title, body, kind: kind || 'info', at: Date.now() };
  subs.forEach(sub => { pushToSub(sub, data).catch(() => {}); });
}

app.get('/api/push/key', (req, res) => res.json({ key: vapidKeys().pub }));

app.post('/api/push/subscribe', (req, res) => {
  const key = req.role === 'admin' ? 'admin' : (req.user && req.user.id);
  if (!key) return res.status(401).json({ error: 'Login required' });
  const s = req.body?.sub || {};
  const endpoint = String(s.endpoint || '');
  const p256dh = String(s.keys?.p256dh || ''), auth = String(s.keys?.auth || '');
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Incomplete subscription.' });
  db.prepare(`INSERT INTO push_subs(id,user_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh,
      auth=excluded.auth, created_at=excluded.created_at`)
    .run('s' + crypto.randomBytes(6).toString('hex'), key, endpoint, p256dh, auth, now());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint);
  res.json({ ok: true });
});

/* lets a device check for anything new since it last looked — used by the
   Android app's background check, which has no web push of its own */
app.get('/api/notifications/since', (req, res) => {
  const key = req.role === 'admin' ? 'admin' : (req.user && req.user.id);
  if (!key) return res.json({ items: [], unread: 0 });
  const since = String(req.query.since || '');
  const rows = since
    ? db.prepare('SELECT * FROM notifications WHERE user_id=? AND created_at>? ORDER BY created_at').all(key, since)
    : db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 5').all(key);
  const unread = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND (read_at='' OR read_at IS NULL)").get(key).c;
  res.json({ unread, now: now(), items: rows.map(pubNotif) });
});

/* ---------- notifications ---------- */
function notifKey(req) {
  if (req.role === 'admin') return 'admin';
  return req.role === 'user' && req.user ? req.user.id : null;
}
app.get('/api/notifications', (req, res) => {
  const key = notifKey(req);
  if (!key) return res.json({ unread: 0, items: [] });
  const items = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60').all(key);
  const unread = items.filter(n => !n.read_at).length;
  res.json({ unread, items: items.map(pubNotif) });
});
app.post('/api/notifications/read', (req, res) => {
  const key = notifKey(req);
  if (!key) return res.json({ ok: true });
  if (req.body?.id) db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(), String(req.body.id), key);
  else db.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND (read_at='' OR read_at IS NULL)").run(now(), key);
  res.json({ ok: true });
});
app.delete('/api/notifications', (req, res) => {
  const key = notifKey(req);
  if (key) db.prepare('DELETE FROM notifications WHERE user_id=?').run(key);
  res.json({ ok: true });
});

/* ---------- festive offers ---------- */
app.get('/api/admin/offers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM offers ORDER BY created_at DESC').all().map(pubOffer));
});
app.post('/api/admin/offers', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const percent = Number(b.percent);
  if (!name) return res.status(400).json({ error: 'Give the offer a name, e.g. Diwali Dhamaka.' });
  if (!isFinite(percent) || percent <= 0 || percent > 90) return res.status(400).json({ error: 'Discount must be between 1 and 90 percent.' });
  const starts = String(b.starts || '').slice(0, 10), ends = String(b.ends || '').slice(0, 10);
  if (starts && ends && ends < starts) return res.status(400).json({ error: 'End date cannot be before the start date.' });
  const id = 'o' + crypto.randomBytes(5).toString('hex');
  db.prepare('INSERT INTO offers(id,name,percent,starts,ends,active,created_at) VALUES(?,?,?,?,?,1,?)')
    .run(id, name, percent, starts, ends, now());
  /* tell every approved dealer about it */
  db.prepare("SELECT id FROM users WHERE status='approved'").all().forEach(u =>
    notify(u.id, 'offer', '' + name,
      percent + '% off your dealer prices' + (ends ? ' until ' + ends : '') + '. Open the shop to see the new rates.'));
  res.json({ ok: true, id });
});
app.put('/api/admin/offers/:id', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM offers WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Offer not found.' });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : o.name;
  const percent = b.percent !== undefined ? Number(b.percent) : o.percent;
  if (!name) return res.status(400).json({ error: 'Offer name is required.' });
  if (!isFinite(percent) || percent <= 0 || percent > 90) return res.status(400).json({ error: 'Discount must be between 1 and 90 percent.' });
  db.prepare('UPDATE offers SET name=?, percent=?, starts=?, ends=?, active=? WHERE id=?').run(
    name, percent,
    b.starts !== undefined ? String(b.starts).slice(0, 10) : o.starts,
    b.ends !== undefined ? String(b.ends).slice(0, 10) : o.ends,
    b.active !== undefined ? (b.active ? 1 : 0) : o.active, o.id);
  res.json({ ok: true });
});
app.delete('/api/admin/offers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM offers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM users WHERE status='pending'").get().n,
    orders: db.prepare("SELECT COUNT(*) n FROM orders WHERE status<>'awaiting_payment'").get().n,
    paySubmitted: db.prepare("SELECT COUNT(*) n FROM orders WHERE status='payment_submitted'").get().n,
    revenue: db.prepare("SELECT COALESCE(SUM(total),0) t FROM orders WHERE status NOT IN ('cancelled','awaiting_payment')").get().t
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  /* the admin also sees the pending verification codes, so they can pass them
     to the customer on WhatsApp or by email */
  res.json(db.prepare("SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC")
    .all().map(u => ({ ...pubUser(u), mobileCode: u.mobile_ok ? '' : (u.mobile_code || ''),
      resetCode: u.reset_code || '', resetAt: u.reset_at || '' })));
});

/* Admin can correct a dealer's details (typos in name, company, GSTIN, address …) */
app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};
  const v = k => (b[k] === undefined ? u[k] : String(b[k]).trim());
  const name = v('name'), company = v('company'), phone = v('phone');
  const email = (b.email === undefined ? u.email : String(b.email).trim().toLowerCase());
  const gstin = (b.gstin === undefined ? u.gstin : String(b.gstin).trim().toUpperCase());
  const whatsapp = (b.whatsapp === undefined ? (u.whatsapp || '') : String(b.whatsapp).trim());
  const type = ['Dealer', 'Distributor', 'Retailer', 'Contractor'].includes(b.type) ? b.type : u.type;
  const addr = v('addr'), city = v('city'), state = v('state'), pincode = v('pincode');

  const uz = zoneLive(b.country || u.country);
  if (!name || !company) return res.status(400).json({ error: 'Name and company are required.' });
  if (nationalDigits(phone, uz).length !== uz.phoneLen)
    return res.status(400).json({ error: 'Enter a valid ' + uz.phoneLen + '-digit ' + uz.country + ' mobile number.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  /* India runs the full GSTIN checksum; other zones use their own format rule. */
  let gi = {};
  if (uz.code === 'IN') {
    gi = gstinParse(gstin);
    if (!gi.valid) return res.status(400).json({ error: 'GSTIN format is not valid.' });
  } else if (uz.taxId) {
    const tv = normTaxId(gstin, uz);
    if (!tv && uz.taxId.required) return res.status(400).json({ error: 'Enter the ' + uz.taxId.label + '.' });
    if (tv && !new RegExp(uz.taxId.re).test(tv))
      return res.status(400).json({ error: uz.taxId.label + ' format is not valid. Expected ' + uz.taxId.hint + '.' });
  }
  if (pincode && uz.postcode && !new RegExp(uz.postcode.re).test(pincode))
    return res.status(400).json({ error: uz.postcode.label + ' must be a valid ' + uz.postcode.hint + '.' });

  const dupE = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?').get(email, u.id);
  if (dupE) return res.status(409).json({ error: 'Another account already uses that email.' });
  const dupG = gstin ? db.prepare('SELECT id FROM users WHERE gstin=? AND country=? AND id<>?').get(gstin, uz.code, u.id) : null;
  if (dupG) return res.status(409).json({ error: 'Another account already uses that ' + (uz.taxId ? uz.taxId.label : 'tax number') + '.' });

  const licence = b.licence === undefined ? (u.licence_no || '') : normLicence(b.licence, uz);
  db.prepare(`UPDATE users SET name=?, company=?, phone=?, whatsapp=?, email=?, gstin=?, type=?,
    addr=?, city=?, state=?, pincode=?, country=?, licence_no=? WHERE id=?`)
    .run(name, company, nationalDigits(phone, uz), nationalDigits(whatsapp || phone, uz), email, gstin || null, type, addr, city,
      state || gi.stateName || '', pincode, uz.code, licence, u.id);
  res.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});

app.post('/api/admin/users/:id/status', requireAdmin, (req, res) => {
  const st = req.body?.status;
  if (!['approved', 'rejected', 'pending'].includes(st)) return res.status(400).json({ error: 'Bad status.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const terms = ['credit', 'advance'].includes(req.body?.terms) ? req.body.terms : (u.terms || 'advance');
  const creditDays = terms === 'credit' ? Math.max(1, parseInt(req.body?.creditDays) || u.credit_days || 30) : 0;
  /* extra discount for this dealer, % off their dealer price */
  let disc = req.body?.discount === undefined ? (u.discount || 0) : Number(req.body.discount);
  if (!isFinite(disc) || disc < 0) disc = 0;
  if (disc > 90) disc = 90;
  db.prepare('UPDATE users SET status=?, note=?, terms=?, credit_days=?, discount=? WHERE id=?')
    .run(st, String(req.body?.note || ''), terms, creditDays, disc, u.id);
  if (st === 'approved')
    notify(u.id, 'approval', 'Account approved',
      'Your ' + (u.type || 'dealer') + ' account is approved on ' +
      (terms === 'credit' ? creditDays + '-day credit' : 'advance payment') + ' terms' +
      (disc ? ', with an extra ' + disc + '% off your dealer prices' : '') +
      '. Dealer pricing is now live in the app.');
  else if (st === 'rejected')
    notify(u.id, 'approval', 'Registration not approved',
      'Please contact us to sort out the details' + (req.body?.note ? ': ' + String(req.body.note) : '.'));
  res.json({ ok: true });
});

/* ================= CREDIT REMINDERS =================
 * Runs automatically once an hour; sends WhatsApp/SMS reminders to credit
 * customers before and after their payment due date.
 * Channel is configured in Admin → Settings → Payment reminders.
 * ==================================================== */
const REM_DEFAULTS = {
  remBefore: '3',                 // days before due date
  remOnDue: '1',                  // send on the due date itself
  remAfter: '1,3,7',              // days after due date (overdue chasers)
  remHour: '10',                  // hour to send, in the business's own timezone
  remTz: 'Asia/Kolkata',          // where "10 o'clock" means ten o'clock
  remProvider: '',                // '', 'whatsapp' (Meta Cloud API) or 'msg91'
  remTemplate: 'Dear {name}, this is a payment reminder from HPMP Manufacturers (Blue Wave). Order {order} of {amount} placed on {date} is {due}. Kindly arrange the payment. Thank you.'
};
const rs = k => { const v = getSetting(k); return v === null || v === undefined || v === '' ? REM_DEFAULTS[k] : v; };
const dayList = s => String(s || '').split(',').map(x => parseInt(x.trim())).filter(n => isFinite(n) && n >= 0);
/* Hosts run on UTC. Working out "which day is it" and "is it ten o'clock yet"
 * from the server clock sent India's 10am reminders at 3:30pm; every date here
 * is therefore read in the business's own timezone. */
const remTz = () => {
  const v = rs('remTz');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: v }); return v; } catch (e) { return 'Asia/Kolkata'; }
};
const tzParts = (d, tz) => {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +(p.hour === '24' ? '0' : p.hour) };
};
const localHour = () => tzParts(new Date(), remTz()).h;
/* midnight of that date, as a plain day number — safe to subtract */
const dayIndex = d => { const p = tzParts(new Date(d), remTz()); return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86400000); };
const daysBetween = (a, b) => dayIndex(b) - dayIndex(a);

function reminderText(o, u, dueDays) {
  const due = dueDays > 0 ? 'due in ' + dueDays + ' day' + (dueDays > 1 ? 's' : '')
    : dueDays === 0 ? 'due today'
      : 'overdue by ' + Math.abs(dueDays) + ' day' + (Math.abs(dueDays) > 1 ? 's' : '');
  return String(rs('remTemplate'))
    .replace(/{name}/g, (u && (u.company || u.name)) || o.contact_name || 'Customer')
    .replace(/{order}/g, o.id)
    .replace(/{amount}/g, fmtMoney(o.total, orderZone(o)))
    .replace(/{date}/g, new Date(o.created_at).toLocaleDateString('en-IN'))
    .replace(/{due}/g, due)
    .replace(/{dueDate}/g, o.credit_due ? new Date(o.credit_due).toLocaleDateString('en-IN') : '')
    ;
}
const waLink = (phone, text, zone) =>
  'https://wa.me/' + intlNumber(phone, zone) +
  '?text=' + encodeURIComponent(text);

/* =================== SMS GATEWAY ===================
 * One-time codes (sign-in, password reset, number verification) go out through
 * whichever SMS provider is configured in Admin → Settings. Everything is a
 * plain HTTPS call, so no packages are needed.
 *
 * Providers, and what each needs:
 *   msg91      authkey + sender id (+ optional DLT template id for India)
 *   fast2sms   api key           (works without DLT on its 'q' route)
 *   twilio     account sid + auth token + from-number (best outside India)
 *   whatsapp   Meta Cloud API phone-number id + token
 * ==================================================== */
const SMS_DEFAULTS = { smsProvider: '', smsSender: 'HPMPMF', smsRoute: '4' };
const ss = k => { const v = getSetting(k); return v === null || v === '' || v === undefined ? SMS_DEFAULTS[k] : v; };
/* Turns a stored national number into the international form the SMS and
 * WhatsApp gateways expect. Safe to call twice — a number that already carries
 * its dial code is returned untouched. Defaults to India when no zone is given,
 * which is how every number in the database looked before multi-zone. */
const intlNumber = (phone, zone) => {
  const n = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  const z = zone || ZONES[DEFAULT_ZONE];
  if (n.length === z.phoneLen) return z.dial + n;
  /* already international for some zone we serve */
  for (const zz of Object.values(ZONES)) if (n.length === zz.dial.length + zz.phoneLen && n.startsWith(zz.dial)) return n;
  return n.length === 10 ? '91' + n : n;
};
/* The dial code of an already-international number, for gateways that want the
 * country as a separate field. Defaults to India. */
const dialOf = intl => {
  const n = String(intl || '').replace(/\D/g, '');
  const byLen = Object.values(ZONES).sort((a, b) => b.dial.length - a.dial.length);
  for (const z of byLen) if (n.length === z.dial.length + z.phoneLen && n.startsWith(z.dial)) return z.dial;
  return '91';
};

/* MSG91 has three endpoints and the right one depends on what you have set up:
 *   • OTP API      — best for one-time codes, needs a DLT-approved OTP template
 *   • Flow API     — any DLT template, used for reminders
 *   • Send SMS v2  — plain route, for accounts/numbers that need no template
 * We pick automatically from the settings, so nothing extra to choose. */
async function smsMsg91(to, text, otp) {
  const key = getSetting('smsKey');
  if (!key) return { ok: false, status: 'MSG91 auth key not saved', detail: 'Paste the auth key in Settings and save.' };
  const tplId = String(getSetting('smsTemplateId') || '').trim();
  const sender = ss('smsSender');
  const mobile = intlNumber(to);
  const reply = async (r, label) => {
    const raw = await r.text();
    let d = {}; try { d = JSON.parse(raw); } catch (e) { /* not json */ }
    const good = r.ok && String(d.type || '').toLowerCase() !== 'error';
    return good ? { ok: true, status: 'sent', detail: label + ': ' + raw.slice(0, 200) }
      : { ok: false, status: 'MSG91 (' + label + ') replied ' + r.status, detail: raw.slice(0, 300) };
  };
  try {
    /* 1. a one-time code with an approved OTP template */
    if (otp && tplId) {
      const url = 'https://control.msg91.com/api/v5/otp?template_id=' + encodeURIComponent(tplId) +
        '&mobile=' + encodeURIComponent(mobile) + '&otp=' + encodeURIComponent(otp) +
        '&otp_expiry=10' + (sender ? '&sender=' + encodeURIComponent(sender) : '');
      const r = await fetch(url, {
        method: 'POST',
        headers: { authkey: key, 'Content-Type': 'application/json', accept: 'application/json' },
        body: '{}', signal: AbortSignal.timeout(12000)
      });
      const out = await reply(r, 'OTP API');
      if (out.ok) return out;
      /* an OTP template rejected here is usually a normal template — try the flow API */
    }
    /* 2. any other DLT template */
    if (tplId) {
      const r = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: key, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          template_id: tplId, short_url: '0', sender,
          recipients: [{ mobiles: mobile, OTP: otp || '', MESSAGE: text, NAME: '' }]
        }),
        signal: AbortSignal.timeout(12000)
      });
      return reply(r, 'Flow API');
    }
    /* 3. no template configured — plain SMS */
    const r = await fetch('https://api.msg91.com/api/v2/sendsms', {
      method: 'POST',
      headers: { authkey: key, 'Content-Type': 'application/json' },
      /* the country has to match the number, or MSG91 routes it as Indian and
         the send is rejected for every Gulf dealer */
      body: JSON.stringify({ sender, route: ss('smsRoute'), country: dialOf(mobile), sms: [{ message: text, to: [mobile] }] }),
      signal: AbortSignal.timeout(12000)
    });
    return reply(r, 'Send SMS');
  } catch (e) { return { ok: false, status: 'Could not reach MSG91', detail: e.message }; }
}

async function smsFast2Sms(to, text) {
  const key = getSetting('smsKey');
  if (!key) return { ok: false, status: 'Fast2SMS API key not saved', detail: 'Paste the API key in Settings and save.' };
  /* Fast2SMS only delivers inside India. Saying so plainly beats a silent
     failure — the code then falls through to the admin-WhatsApp path. */
  if (dialOf(intlNumber(to)) !== '91')
    return { ok: false, status: 'Fast2SMS delivers to Indian numbers only',
             detail: 'This dealer is outside India. Use MSG91 or Twilio for the Gulf zones, or send the code on WhatsApp.' };
  const num = intlNumber(to).replace(/^91/, '');
  try {
    const r = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: 'q', message: text, language: 'english', flash: 0, numbers: num }),
      signal: AbortSignal.timeout(12000)
    });
    const raw = await r.text();
    let d = {}; try { d = JSON.parse(raw); } catch (e) { /* not json */ }
    if (r.ok && d.return === true) return { ok: true, status: 'sent', detail: raw.slice(0, 300) };
    const help = FAST2SMS_HELP[String(d.status_code || '')];
    return { ok: false,
      status: help ? help.short : 'Fast2SMS replied ' + r.status,
      detail: (help ? help.fix + ' — ' : '') + raw.slice(0, 300) };
  } catch (e) { return { ok: false, status: 'Could not reach Fast2SMS', detail: e.message }; }
}

/* Fast2SMS answers with a numeric status_code and a terse message. These are
 * the ones that actually stop a live account, turned into something the admin
 * can act on without going digging. Codes from Fast2SMS's own error list. */
const FAST2SMS_HELP = {
  '412': { short: 'Fast2SMS key rejected',
           fix: 'The authorisation key is wrong. Copy it again from Fast2SMS → Dev API and save it in Settings.' },
  '413': { short: 'Fast2SMS key disabled',
           fix: 'The key has been switched off in your Fast2SMS account. Re-enable or regenerate it.' },
  '414': { short: 'Fast2SMS has blocked this server\'s IP',
           fix: 'In Fast2SMS → Dev API, either switch OFF the IP whitelist or add this server\'s address. '
              + 'On Railway the outbound address changes on every deploy unless you are on the Pro plan with '
              + 'static outbound IPs, so a whitelist will keep breaking — switching the restriction off is the '
              + 'fix that lasts.' },
  '415': { short: 'Fast2SMS account disabled', fix: 'Contact Fast2SMS support — the account itself is switched off.' },
  '416': { short: 'Fast2SMS wallet is empty', fix: 'Top up the Fast2SMS wallet; no messages send at zero balance.' },
  '995': { short: 'Fast2SMS flagged this as spam',
           fix: 'Too many messages to the same number too quickly. Wait a few minutes before retrying.' },
  '996': { short: 'Fast2SMS KYC not complete', fix: 'Finish KYC in the Fast2SMS dashboard before the OTP route will work.' },
  '999': { short: 'Fast2SMS needs a first top-up',
           fix: 'Fast2SMS requires one payment of at least ₹100 into the wallet before the API is enabled.' }
};

async function smsTwilio(to, text) {
  const sid = getSetting('twilioSid'), tok = getSetting('twilioToken'), from = getSetting('twilioFrom');
  if (!sid || !tok || !from) return { ok: false, status: 'Twilio details incomplete',
    detail: 'Account SID, auth token and from-number are all required.' };
  try {
    const body = new URLSearchParams({ To: '+' + intlNumber(to), From: from, Body: text });
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body, signal: AbortSignal.timeout(12000)
    });
    const raw = await r.text();
    let d = {}; try { d = JSON.parse(raw); } catch (e) { /* not json */ }
    return r.ok ? { ok: true, status: 'sent', detail: 'SID ' + (d.sid || '') }
      : { ok: false, status: 'Twilio replied ' + r.status, detail: (d.message || raw).slice(0, 300) };
  } catch (e) { return { ok: false, status: 'Could not reach Twilio', detail: e.message }; }
}

async function smsWhatsApp(to, text) {
  const token = getSetting('waToken'), pid = getSetting('waPhoneId');
  if (!token || !pid) return { ok: false, status: 'WhatsApp details incomplete',
    detail: 'Phone Number ID and permanent token are both required.' };
  try {
    const r = await fetch('https://graph.facebook.com/v20.0/' + pid + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: intlNumber(to), type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(12000)
    });
    const raw = await r.text();
    let d = {}; try { d = JSON.parse(raw); } catch (e) { /* not json */ }
    return r.ok ? { ok: true, status: 'sent', detail: raw.slice(0, 200) }
      : { ok: false, status: 'WhatsApp replied ' + r.status, detail: ((d.error && d.error.message) || raw).slice(0, 300) };
  } catch (e) { return { ok: false, status: 'Could not reach WhatsApp', detail: e.message }; }
}

/* =================== EMAIL =====================
 * A small SMTP client, so codes can also be emailed. Every dealer gives an
 * email at registration, an app password from Gmail/Zoho/your host is enough,
 * and there is no DLT paperwork — which makes this the quickest way to get
 * one-time codes actually delivered.
 * =============================================== */
function smtpSend({ host, port, secure, user, pass, from, fromName, to, subject, text }) {
  return new Promise(resolve => {
    let sock, done = false, step = 0, buf = '';
    const finish = (ok, status) => {
      if (done) return; done = true;
      try { sock && sock.destroy(); } catch (e) { /* already closed */ }
      resolve({ ok, status });
    };
    const timer = setTimeout(() => finish(false, 'Mail server did not answer in time'), 15000);
    const msg = [
      'From: ' + (fromName ? '"' + fromName + '" ' : '') + '<' + from + '>',
      'To: <' + to + '>',
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Date: ' + new Date().toUTCString(),
      '', text, '.'
    ].join('\r\n');
    const write = line => { try { sock.write(line + '\r\n'); } catch (e) { finish(false, 'Connection lost'); } };
    let canStartTls = false;
    const onLine = line => {
      const code = parseInt(line.slice(0, 3));
      if (/STARTTLS/i.test(line)) canStartTls = true;      // advertised in the EHLO reply
      if (line[3] === '-') return;                         // multi-line reply, wait for the last
      if (code >= 400) {
        /* a server that does not do STARTTLS just carries on unencrypted */
        if (step === 2) { write('AUTH LOGIN'); step = 3; return; }
        return finish(false, 'Mail server said: ' + line.trim().slice(0, 160));
      }
      if (step === 0) { write('EHLO bluewave'); step = 1; return; }
      if (step === 1) {                                     // after EHLO
        if (!secure && canStartTls) { write('STARTTLS'); step = 2; return; }
        write('AUTH LOGIN'); step = 3; return;
      }
      if (step === 2) {                                     // STARTTLS accepted → wrap the socket
        const plain = sock;
        plain.removeAllListeners('data');
        sock = tls.connect({ socket: plain, servername: host, rejectUnauthorized: false }, () => {
          sock.on('data', onData); write('EHLO bluewave'); step = 21;
        });
        sock.on('error', e => finish(false, 'TLS failed: ' + e.message));
        return;
      }
      if (step === 21) { write('AUTH LOGIN'); step = 3; return; }
      if (step === 3) { write(Buffer.from(user).toString('base64')); step = 4; return; }
      if (step === 4) { write(Buffer.from(pass).toString('base64')); step = 5; return; }
      if (step === 5) { write('MAIL FROM:<' + from + '>'); step = 6; return; }
      if (step === 6) { write('RCPT TO:<' + to + '>'); step = 7; return; }
      if (step === 7) { write('DATA'); step = 8; return; }
      if (step === 8) { write(msg); step = 9; return; }
      if (step === 9) {
        /* say goodbye properly and give the server a moment to acknowledge */
        write('QUIT'); clearTimeout(timer);
        setTimeout(() => finish(true, 'sent'), 60);
        return;
      }
    };
    const onData = d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
    };
    try {
      sock = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
      sock.setTimeout(15000);
      sock.on('data', onData);
      sock.on('error', e => finish(false, 'Could not reach the mail server: ' + e.message));
      sock.on('timeout', () => finish(false, 'Mail server timed out'));
    } catch (e) { finish(false, e.message); }
  });
}

const mailReady = () => !!(getSetting('smtpHost') && getSetting('smtpUser') && getSetting('smtpPass'));

async function sendMail(to, subject, text) {
  if (!to) return { ok: false, status: 'No email address on the account' };
  if (!mailReady()) return { ok: false, status: 'Email not set up', detail: 'Add your mail server details in Settings.' };
  const port = parseInt(getSetting('smtpPort')) || 587;
  return smtpSend({
    host: getSetting('smtpHost'), port, secure: port === 465,
    user: getSetting('smtpUser'), pass: getSetting('smtpPass'),
    from: getSetting('smtpFrom') || getSetting('smtpUser'),
    fromName: getSetting('smtpFromName') || 'Blue Wave',
    to, subject, text
  });
}

/** Sends a one-time code. Returns {ok,status}; never throws. */
async function sendSms(to, text, otp) {
  const p = ss('smsProvider');
  if (!p) return { ok: false, status: 'No SMS provider chosen', detail: 'Pick one in Settings and save your keys.' };
  if (!String(to || '').replace(/\D/g, '')) return { ok: false, status: 'No mobile number to send to' };
  if (p === 'msg91') return smsMsg91(to, text, otp);
  if (p === 'fast2sms') return smsFast2Sms(to, text);
  if (p === 'twilio') return smsTwilio(to, text);
  if (p === 'whatsapp') return smsWhatsApp(to, text);
  return { ok: false, status: 'unknown_provider' };
}

/* Anything a customer should receive — one-time codes and payment reminders —
 * goes through here: SMS gateway first, email second, and the admin is told if
 * neither worked. One path, one place to fix. */
async function deliver({ phone, email, name, subject, text, mailText, otp }) {
  let r = await sendSms(phone, text, otp);
  if (r.ok) return { ...r, via: ss('smsProvider') === 'whatsapp' ? 'whatsapp' : 'sms' };
  if (mailReady() && email) {
    const m = await sendMail(email, subject || 'Blue Wave', mailText || text);
    if (m.ok) return { ...m, via: 'email' };
    return { ok: false, status: r.status + ' / email: ' + m.status, via: '' };
  }
  return { ...r, via: '' };
}

/** Sends a code by whatever channel is available, and records what happened.
 *  Order: SMS gateway → email → tell the admin. Something always reaches
 *  someone, so a dealer is never stuck. */
async function sendCode(user, purpose, code, extraNote) {
  /* Sent in international form so a Gulf dealer's code reaches them — the
     gateways cannot guess the country from a bare national number. */
  const uz = zoneOfUser(user);
  const to = intlNumber(String(user.whatsapp || user.phone || ''), uz);
  const text = 'Blue Wave ' + purpose + ' code: ' + code +
    '. Valid for 10 minutes. Do not share it with anyone. HPMP Manufacturers Pvt Ltd.';
  const r = await deliver({
    phone: to, email: user.email, name: user.name, otp: code,
    subject: 'Blue Wave ' + purpose + ' code: ' + code,
    text,
    mailText: 'Hello ' + (user.name || '') + ',\n\n' +
      'Your Blue Wave ' + purpose + ' code is ' + code + '.\n' +
      'It is valid for 10 minutes. Please do not share it with anyone.\n\n' +
      'If you did not ask for this, you can ignore this email.\n\n' +
      'HPMP Manufacturers Pvt Ltd'
  });
  const via = r.via;
  db.prepare('INSERT INTO reminders(order_id,kind,channel,phone,message,status,sent_at) VALUES(?,?,?,?,?,?,?)')
    .run('code:' + user.id, purpose.replace(/\s+/g, '_'), via || ss('smsProvider') || 'admin',
      via === 'email' ? user.email : to, text, r.ok ? 'sent' : r.status, now());

  if (!r.ok) notifyAdmin('verify', purpose[0].toUpperCase() + purpose.slice(1) + ' code — ' +
      (user.company || user.name || ('+' + String(to).replace(/\D/g, ''))),
    (user.name ? user.name + ' ' : '') + '(' + to + ') needs their ' + purpose + ' code: ' + code + '.' +
    (extraNote ? ' ' + extraNote : '') + ' Send it on WhatsApp.');
  return { ...r, via };
}

/* kept for the manual "send now" button */
async function sendMessage(phone, text) { return sendSms(phone, text); }

/* every outstanding credit order with its due date and how many days remain */
function creditOutstanding() {
  const rows = db.prepare(`SELECT * FROM orders WHERE credit_due<>'' AND credit_settled=0
      AND status NOT IN ('cancelled','delivered_paid')`).all();
  const today = new Date();
  return rows.map(o => {
    const u = o.user_id ? db.prepare('SELECT * FROM users WHERE id=?').get(o.user_id) : null;
    const c = JSON.parse(o.contact_json || '{}');
    return {
      order: o, user: u, contact: c,
      phone: (u && (u.whatsapp || u.phone)) || c.phone || '',
      dueDays: daysBetween(today, new Date(o.credit_due))
    };
  });
}

function reminderKind(dueDays) {
  if (dueDays > 0 && dayList(rs('remBefore')).includes(dueDays)) return 'before-' + dueDays;
  if (dueDays === 0 && String(rs('remOnDue')) !== '0') return 'due';
  if (dueDays < 0 && dayList(rs('remAfter')).includes(Math.abs(dueDays))) return 'after-' + Math.abs(dueDays);
  return null;
}

async function runCreditReminders(force) {
  const hour = parseInt(rs('remHour'));
  /* off by choice, or nothing configured to send with */
  const auto = getSetting('remAuto');
  if (auto === '0') return { skipped: 'switched_off' };
  if (!ss('smsProvider') && !mailReady()) return { skipped: 'no_channel' };
  if (!force && localHour() !== (isFinite(hour) ? hour : 10)) return { skipped: 'not_send_hour' };
  let sent = 0, skipped = 0;
  /* taken once — the list was being rebuilt from scratch just to count it */
  const due = creditOutstanding();
  for (const row of due) {
    const kind = reminderKind(row.dueDays);
    if (!kind) { skipped++; continue; }
    /* never repeat a delivered reminder, and never log the same one twice in a day */
    const already = db.prepare(`SELECT 1 FROM reminders WHERE order_id=? AND kind=?
        AND (status='sent' OR date(sent_at)=date('now'))`).get(row.order.id, kind);
    if (already) { skipped++; continue; }
    const text = reminderText({ ...row.order, contact_name: row.contact.name }, row.user, row.dueDays);
    const r = await deliver({
      phone: row.phone, email: row.user && row.user.email, name: row.contact.name,
      subject: 'Payment reminder — order ' + row.order.id, text
    });
    db.prepare('INSERT INTO reminders(order_id,kind,channel,phone,message,status,sent_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.order.id, kind, r.via || ss('smsProvider') || 'none',
        r.via === 'email' ? (row.user && row.user.email) || row.phone : row.phone,
        text, r.ok ? 'sent' : r.status, now());
    if (r.ok) sent++;
    else notifyAdmin('credit', 'Reminder could not be sent — ' + (row.contact.company || row.contact.name),
      'Order ' + row.order.id + ' is ' + (row.dueDays < 0 ? Math.abs(row.dueDays) + ' day(s) overdue' : 'due in ' + row.dueDays + ' day(s)') +
      '. Message not delivered (' + r.status + '). Chase them from the Credit tab.');
  }
  return { sent, skipped, checked: due.length };
}
setInterval(() => { runCreditReminders(false).catch(() => { }); }, 60 * 60 * 1000);
setTimeout(() => { runCreditReminders(false).catch(() => { }); }, 30000);

/* Credit customers can confirm an order on credit and pay later */
app.post('/api/orders/:id/credit', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  if (req.user.status !== 'approved' || (req.user.terms || 'advance') !== 'credit')
    return res.status(403).json({ error: 'Credit facility is not enabled for your account — pay in advance or contact us.' });
  if (o.status !== 'awaiting_payment') return res.status(400).json({ error: 'This order is already confirmed or paid.' });
  const days = req.user.credit_days || 30;
  const due = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare("UPDATE orders SET status='confirmed', pay_ref=?, credit_due=?, credit_settled=0 WHERE id=?")
    .run('On credit — payment due in ' + days + ' days', due, o.id);
  res.json({ ok: true, order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)) });
});

/* ---- admin: credit ledger, reminders ---- */
app.get('/api/admin/credit', requireAdmin, (req, res) => {
  const rows = creditOutstanding().sort((a, b) => a.dueDays - b.dueDays).map(r => {
    const last = db.prepare('SELECT * FROM reminders WHERE order_id=? ORDER BY id DESC LIMIT 1').get(r.order.id);
    return {
      id: r.order.id, company: (r.user && r.user.company) || r.contact.company || r.contact.name || '',
      name: (r.user && r.user.name) || r.contact.name || '', phone: r.phone,
      total: r.order.total, createdAt: r.order.created_at, dueAt: r.order.credit_due,
      dueDays: r.dueDays, creditDays: (r.user && r.user.credit_days) || 0,
      status: r.order.status,
      lastReminder: last ? { kind: last.kind, status: last.status, at: last.sent_at } : null,
      waLink: waLink(r.phone, reminderText({ ...r.order, contact_name: r.contact.name }, r.user, r.dueDays), zoneOfUser(r.user)),
      message: reminderText({ ...r.order, contact_name: r.contact.name }, r.user, r.dueDays)
    };
  });
  res.json({
    orders: rows,
    provider: rs('remProvider'),
    totalDue: rows.reduce((s, r) => s + r.total, 0),
    overdue: rows.filter(r => r.dueDays < 0).length
  });
});

app.post('/api/admin/credit/:id/settle', requireAdmin, (req, res) => {
  const r = db.prepare('UPDATE orders SET credit_settled=1 WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

app.post('/api/admin/credit/:id/remind', requireAdmin, async (req, res) => {
  const row = creditOutstanding().find(x => x.order.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Credit order not found.' });
  const text = reminderText({ ...row.order, contact_name: row.contact.name }, row.user, row.dueDays);
  const r = await deliver({
    phone: row.phone, email: row.user && row.user.email, name: row.contact && row.contact.name,
    subject: 'Payment reminder — order ' + row.order.id, text
  });
  db.prepare('INSERT INTO reminders(order_id,kind,channel,phone,message,status,sent_at) VALUES(?,?,?,?,?,?,?)')
    .run(row.order.id, 'manual', rs('remProvider') || 'none', row.phone, text, r.ok ? 'sent' : r.status, now());
  if (!r.ok) return res.status(400).json({ error: r.status === 'no_provider' || r.status === 'not_configured'
    ? 'Automatic sending is not configured yet — use the WhatsApp button, or add your provider keys in Settings.'
    : 'Could not send (' + r.status + ').' });
  res.json({ ok: true });
});

app.post('/api/admin/credit/run', requireAdmin, async (req, res) => res.json(await runCreditReminders(true)));

app.get('/api/admin/reminders', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM reminders ORDER BY id DESC LIMIT 100').all());
});

/* ---- per-dealer price list ---- */
app.get('/api/admin/users/:id/prices', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const custom = {};
  db.prepare('SELECT * FROM dealer_prices WHERE user_id=?').all(u.id).forEach(r => custom[r.product_id] = r.price);
  res.json({
    user: pubUser(u),
    products: db.prepare('SELECT * FROM products ORDER BY sort').all().map(p => ({
      id: p.id, name: p.name, cat: p.cat, mrp: p.mrp, standard: p.dealer,
      custom: custom[p.id] !== undefined ? custom[p.id] : null
    }))
  });
});

app.put('/api/admin/users/:id/prices', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const prices = req.body?.prices || {};
  const del = db.prepare('DELETE FROM dealer_prices WHERE user_id=? AND product_id=?');
  const set = db.prepare('INSERT INTO dealer_prices(user_id,product_id,price) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET price=excluded.price');
  for (const [pid, val] of Object.entries(prices)) {
    if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(pid)) continue;
    const n = parseFloat(val);
    if (val === '' || val === null || !isFinite(n) || n < 0) del.run(u.id, pid);
    else set.run(u.id, pid, n);
  }
  res.json({ ok: true });
});

/* An order only reaches the admin once payment is made (or it was confirmed
 * on approved credit terms). Unpaid carts stay with the customer. */
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM orders WHERE status<>'awaiting_payment' ORDER BY created_at DESC")
    .all().map(orderOut));
});

app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const st = req.body?.status;
  if (!['awaiting_payment', 'payment_submitted', 'paid', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(st))
    return res.status(400).json({ error: 'Bad status.' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, o.id);
  const SAY = {
    paid: ['Payment confirmed', 'We have confirmed your payment. Your order is being prepared.'],
    confirmed: ['Order confirmed', 'Your order is confirmed and is being packed.'],
    shipped: ['Order dispatched', 'Your order has left our facility. Open the order to see the dispatch details.'],
    delivered: ['Order delivered', 'Your order is marked delivered. Thank you for your business!'],
    cancelled: ['Order cancelled', 'Your order has been cancelled. Please contact us if this is unexpected.']
  };
  if (o.user_id && SAY[st]) notify(o.user_id, 'order', SAY[st][0] + ' — ' + o.id, SAY[st][1], o.id);
  res.json({ ok: true });
});

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY sort').all());
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim(), cat = String(b.cat || 'AC Brackets').trim();
  const mrp = Number(b.mrp), dealer = Number(b.dealer);
  if (!name || !isFinite(mrp) || !isFinite(dealer) || mrp <= 0 || dealer < 0)
    return res.status(400).json({ error: 'Provide name, MRP and dealer price.' });
  const sort = (db.prepare('SELECT COALESCE(MAX(sort),0) m FROM products').get().m) + 1;
  const id = uid('p');
  db.prepare('INSERT INTO products(id,name,cat,emoji,mrp,dealer,moq,active,sort) VALUES(?,?,?,?,?,?,?,1,?)')
    .run(id, name, cat, cat.toLowerCase().includes('bracket') ? '' : '', mrp, dealer, Math.max(1, parseInt(b.moq) || 50), sort);
  /* Give it its description, packing note and master packing straight away.
     This used to wait for backfillMeta() on the next restart, so a trolley
     added this morning printed a dash where its bundle count belongs on every
     slip until someone happened to redeploy. */
  const m = productMeta(name);
  if (m.descr || m.packing || m.options)
    db.prepare('UPDATE products SET descr=?, packing=?, options=? WHERE id=?')
      .run(m.descr || '', m.packing || '', m.options || '', id);
  res.json({ ok: true, id, packing: m.packing || '' });
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : p.name;
  const mrp = b.mrp !== undefined ? Number(b.mrp) : p.mrp;
  const dealer = b.dealer !== undefined ? Number(b.dealer) : p.dealer;
  if (!name || !isFinite(mrp) || !isFinite(dealer) || mrp <= 0 || dealer < 0)
    return res.status(400).json({ error: 'Invalid values.' });
  if (b.descr !== undefined || b.packing !== undefined)
    db.prepare('UPDATE products SET descr=?, packing=? WHERE id=?')
      .run(b.descr !== undefined ? String(b.descr).slice(0, 3000) : (p.descr || ''),
        b.packing !== undefined ? String(b.packing).slice(0, 3000) : (p.packing || ''), p.id);
  db.prepare('UPDATE products SET name=?, cat=?, mrp=?, dealer=?, moq=?, active=?, image=? WHERE id=?')
    .run(name, b.cat !== undefined ? String(b.cat).trim() : p.cat, mrp, dealer,
      b.moq !== undefined ? Math.max(1, parseInt(b.moq) || p.moq) : p.moq,
      b.active !== undefined ? (b.active ? 1 : 0) : p.active,
      b.image !== undefined ? String(b.image).slice(0, 800000) : (p.image || ''), p.id);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/orders/:id/dispatch', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  const b = req.body || {};
  const mode = b.mode === 'local' ? 'local' : 'outstation';
  const clip = (v, n) => String(v || '').trim().slice(0, n);

  if (mode === 'local') {
    /* same-city delivery — Porter / own vehicle */
    const vehicle = clip(b.vehicleNo, 24).toUpperCase();
    if (!vehicle) return res.status(400).json({ error: 'Enter the vehicle number for local delivery.' });
    db.prepare(`UPDATE orders SET dispatch_mode='local', vehicle_no=?, driver_name=?, driver_phone=?,
        dispatch_transport=?, lr_number='', dispatched_at=?, status='shipped' WHERE id=?`)
      .run(vehicle, clip(b.driverName, 60), clip(b.driverPhone, 15),
        clip(b.transport, 80) || 'Porter (local delivery)', now(), o.id);
  } else {
    /* other district / state — transporter with LR number */
    const lr = clip(b.lrNumber, 60);
    if (!lr) return res.status(400).json({ error: 'Enter the LR number for outstation dispatch.' });
    db.prepare(`UPDATE orders SET dispatch_mode='outstation', lr_number=?, dispatch_transport=?,
        vehicle_no='', driver_name='', driver_phone='', dispatched_at=?, status='shipped' WHERE id=?`)
      .run(lr, clip(b.transport, 80), now(), o.id);
  }
  const after = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  if (o.user_id) notify(o.user_id, 'order', 'Order ' + o.id + ' dispatched',
    mode === 'local'
      ? 'Out for local delivery — vehicle ' + (after.vehicle_no || '') +
        (after.driver_name ? ', driver ' + after.driver_name : '') +
        (after.driver_phone ? ' (' + after.driver_phone + ')' : '') + '.'
      : 'Sent by ' + (after.dispatch_transport || 'transport') + ' — LR number ' + (after.lr_number || '') +
        '. Track it with the transporter using this LR.', o.id);
  res.json({ ok: true, order: orderOut(after) });
});


app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

/* ---------- backup / restore ----------
 * A full copy of everything as one JSON file, so a wiped host, a bad deploy or
 * a move to another provider never costs you dealers or orders. */
/* 'zones' holds the admin's live exchange rates and Gulf VAT percentages, and
 * 'reminders' is what stops a credit customer being chased twice for the same
 * order. Leaving them out meant a restore quietly reverted every rate to the
 * seed values and re-sent reminders that had already gone. */
const BACKUP_TABLES = ['users', 'products', 'orders', 'settings', 'transports', 'dealer_prices',
  'offers', 'notifications', 'zones', 'reminders', 'fx_history'];

/* Only columns the table actually has, quoted, so a crafted backup file cannot
 * smuggle SQL through a JSON key. */
const tableColumns = t => new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(r => r.name));
const quoteId = c => '"' + String(c).replace(/"/g, '""') + '"';

app.get('/api/admin/backup', requireAdmin, (req, res) => {
  const data = {};
  for (const t of BACKUP_TABLES) {
    try { data[t] = db.prepare('SELECT * FROM ' + t).all(); } catch (e) { data[t] = []; }
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Disposition', 'attachment; filename="bluewave-backup-' + stamp + '.json"');
  res.json({ app: 'bluewave', version: 1, takenAt: new Date().toISOString(), data });
});

app.post('/api/admin/restore', requireAdmin, (req, res) => {
  if (!verifyAdminPw(req.body?.password))
    return res.status(403).json({ error: 'Verification password is incorrect — restore cancelled.' });
  const backup = req.body?.backup;
  if (!backup || backup.app !== 'bluewave' || !backup.data)
    return res.status(400).json({ error: 'That file is not a Blue Wave backup.' });

  const counts = {};
  try {
    db.exec('BEGIN');
    for (const t of BACKUP_TABLES) {
      const rows = Array.isArray(backup.data[t]) ? backup.data[t] : null;
      if (!rows) continue;
      const allowed = tableColumns(t);
      db.prepare('DELETE FROM ' + quoteId(t)).run();
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        /* keys that are not real columns are dropped, not interpolated */
        const cols = Object.keys(row).filter(c => allowed.has(c));
        if (!cols.length) continue;
        db.prepare('INSERT OR REPLACE INTO ' + quoteId(t) + ' (' + cols.map(quoteId).join(',') + ') VALUES (' +
          cols.map(() => '?').join(',') + ')').run(...cols.map(c => {
            const v = row[c];
            /* SQLite binds only these; an object or array in the file would throw
               and abort the whole restore */
            return (v === null || typeof v === 'string' || typeof v === 'number'
              || typeof v === 'bigint') ? v : (typeof v === 'boolean' ? (v ? 1 : 0) : JSON.stringify(v));
          }));
      }
      counts[t] = rows.length;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* nothing to roll back */ }
    return res.status(400).json({ error: 'Restore failed: ' + e.message });
  }
  db.prepare("DELETE FROM sessions WHERE role='user'").run();   // old logins no longer match
  res.json({ ok: true, counts });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  if (!verifyAdminPw(req.body?.password)) return res.status(403).json({ error: 'Verification password is incorrect — deletion cancelled.' });
  const scope = req.body?.scope;
  /* Everything that hangs off a user goes with them. Left behind, the price
     lists and push subscriptions would silently reattach themselves to the next
     account that happened to be issued the same id. */
  if (scope === 'accounts') {
    db.prepare('DELETE FROM users').run();
    db.prepare("DELETE FROM sessions WHERE role='user'").run();
    db.prepare('DELETE FROM dealer_prices').run();
    db.prepare("DELETE FROM notifications WHERE user_id<>'admin'").run();
    db.prepare("DELETE FROM push_subs WHERE user_id<>'admin'").run();
    db.prepare('DELETE FROM otp_codes').run();
    db.prepare("UPDATE orders SET user_id=NULL WHERE user_id IS NOT NULL").run();
  } else if (scope === 'orders') {
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM reminders').run();
  } else return res.status(400).json({ error: 'Bad scope.' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/delete', requireAdmin, (req, res) => {
  if (!verifyAdminPw(req.body?.password)) return res.status(403).json({ error: 'Verification password is incorrect — deletion cancelled.' });
  const id = req.params.id;
  const r = db.prepare('DELETE FROM users WHERE id=?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'User not found.' });
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM dealer_prices WHERE user_id=?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id=?').run(id);
  db.prepare('DELETE FROM push_subs WHERE user_id=?').run(id);
  /* their orders stay — they are the business record — but stop pointing at an
     account that no longer exists */
  db.prepare('UPDATE orders SET user_id=NULL WHERE user_id=?').run(id);
  res.json({ ok: true });
});

app.get('/api/admin/transports', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM transports ORDER BY name').all());
});

app.post('/api/admin/transports', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Enter a transport name.' });
  if (db.prepare('SELECT 1 FROM transports WHERE name=?').get(name))
    return res.status(400).json({ error: 'This transport is already in the list.' });
  db.prepare('INSERT INTO transports(id,name) VALUES(?,?)').run(uid('t'), name);
  res.json({ ok: true });
});

app.delete('/api/admin/transports/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM transports WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    payeeName: getSetting('payeeName'), bankName: getSetting('bankName'),
    accountNo: getSetting('accountNo'), ifsc: getSetting('ifsc'), whatsapp: getSetting('whatsapp'),
    adminEmail: getSetting('adminEmail'), gstPercent: gstPercent(),
    company: companyDetails(),
    defaultAdminPassword: usingDefaultAdminPassword(),
    rzpKeyId: getSetting('rzpKeyId') || '', rzpSecretSet: !!getSetting('rzpKeySecret'),
    gstApiKeySet: !!getSetting('gstApiKey'),
    remProvider: rs('remProvider'), remAuto: getSetting('remAuto') === '0' ? '0' : '1',
    remBefore: rs('remBefore'), remOnDue: rs('remOnDue'),
    remAfter: rs('remAfter'), remHour: rs('remHour'), remTz: remTz(), remTemplate: rs('remTemplate'),
    waPhoneId: getSetting('waPhoneId') || '', waTokenSet: !!getSetting('waToken'),
    smsProvider: ss('smsProvider'), smsRoute: ss('smsRoute'),
    smtpHost: getSetting('smtpHost') || '', smtpPort: getSetting('smtpPort') || '587',
    smtpUser: getSetting('smtpUser') || '', smtpFrom: getSetting('smtpFrom') || '',
    smtpFromName: getSetting('smtpFromName') || 'Blue Wave', smtpPassSet: !!getSetting('smtpPass'),
    smsTemplateId: getSetting('smsTemplateId') || '',
    twilioSid: getSetting('twilioSid') || '', twilioFrom: getSetting('twilioFrom') || '',
    twilioTokenSet: !!getSetting('twilioToken'),
    smsSender: getSetting('smsSender') || '', smsKeySet: !!getSetting('smsKey'),
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  for (const k of ['payeeName', 'bankName', 'accountNo', 'ifsc', 'whatsapp', 'adminEmail', 'rzpKeyId',
    'remProvider', 'remAuto', 'remBefore', 'remOnDue', 'remAfter', 'remHour', 'remTz', 'remTemplate', 'waPhoneId', 'smsSender',
    'smsProvider', 'smsRoute', 'smsTemplateId', 'twilioSid', 'twilioFrom',
    'smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smtpFromName',
    /* the company's own details, as they appear on a dispatch slip or invoice */
    ...COMPANY_FIELDS])
    if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  /* The logo is a data URL and can be several hundred KB, so it is set only
     when one is actually sent, and cleared explicitly. */
  if (b.coLogo !== undefined) setSetting('coLogo', String(b.coLogo).slice(0, 800000));
  for (const k of ['waToken', 'smsKey', 'twilioToken', 'smtpPass'])
    if (b[k] !== undefined && String(b[k]).trim() !== '') setSetting(k, String(b[k]).trim());
  if (b.gstPercent !== undefined) { const g = parseFloat(b.gstPercent); if (isFinite(g) && g >= 0 && g <= 100) setSetting('gstPercent', g); }
  if (b.rzpKeySecret !== undefined && String(b.rzpKeySecret).trim() !== '')
    setSetting('rzpKeySecret', String(b.rzpKeySecret).trim());
  if (b.gstApiKey !== undefined && String(b.gstApiKey).trim() !== '')
    setSetting('gstApiKey', String(b.gstApiKey).trim());
  if (b.rzpClear) { setSetting('rzpKeyId', ''); setSetting('rzpKeySecret', ''); }
  if (b.adminPassword) {
    const pw = String(b.adminPassword);
    if (pw.length < 10)
      return res.status(400).json({ error: 'The admin password must be at least 10 characters — it is the key to every dealer account and order.' });
    if (DEFAULT_ADMIN_PASSWORDS.has(pw))
      return res.status(400).json({ error: 'Please choose a password that is not the factory default.' });
    const salt = crypto.randomBytes(16).toString('hex');
    setSetting('adminSalt', salt);
    setSetting('adminHash', hashPw(pw, salt));
    /* an admin password change signs the old admin sessions out */
    db.prepare("DELETE FROM sessions WHERE role='admin'").run();
  }
  res.json({ ok: true });
});

/* ---------- static frontend ---------- */
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    /* index.html carries the whole app, so it must never be served stale after
       a deploy; the icons and manifest beside it can be cached hard. */
    if (p.endsWith('index.html') || p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
/* An unknown /api path is a 404 in JSON, not the whole SPA — the old catch-all
 * handed index.html to the Android notification poller when a route was
 * misspelled, and it read as success. */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* Last line of defence: anything a route throws lands here as JSON instead of a
 * stack trace on the dealer's screen. */
app.use((err, req, res, next) => {
  console.error('Unhandled error on ' + req.method + ' ' + req.path + ':', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong at our end. Please try again.' });
});

/* Expired sessions, spent rate-limit rows and stale one-time codes are cleared
 * on boot and once an hour after that. */
purgeSessions();
setInterval(purgeSessions, 60 * 60 * 1000);

/* Exchange rates: checked hourly, actually fetched once a day. The first run is
 * delayed a little so a restart does not hold up the first page load. */
setTimeout(() => { fxTick().catch(() => { }); }, 20000);
setInterval(() => { fxTick().catch(() => { }); }, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log('Blue Wave app running on port ' + PORT);
  if (usingDefaultAdminPassword()) {
    console.warn('\n  ****************************************************************\n' +
                 '  *  WARNING: the admin account is still on its factory password. *\n' +
                 '  *  Anyone who has read the setup notes can sign in as admin.    *\n' +
                 '  *  Set ADMIN_PASSWORD in the host\'s environment variables, or   *\n' +
                 '  *  change it in Admin -> Settings before sharing the link.      *\n' +
                 '  ****************************************************************\n');
  }
});
