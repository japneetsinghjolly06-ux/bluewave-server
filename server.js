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
function productMeta(name) {
  const n = name.toLowerCase();
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
  if (n.includes('xuv')) {
    const cartons = n.includes('300') ? 10 : 6;
    return {
      descr: `${name} — height and width adjustable appliance trolley for washing machines and refrigerators. Smooth-rolling wheels with brake locks, high-grade steel frame, 7-tank powder coating. Adjustable to fit all standard appliance sizes.`,
      packing: `Each trolley packed knocked-down in an individual printed carton with assembly hardware.\nMaster packing: ${cartons} cartons per bundle.`,
      options: ''
    };
  }
  if (n.includes('angle')) {
    return {
      descr: 'Angle Trolly — fixed-frame appliance trolley with smooth-rolling wheels. Sturdy angle-steel construction with 7-tank powder coating, ideal for washing machines, coolers and refrigerators. Available in multiple sizes.',
      packing: 'Each trolley packed in an individual carton with wheels pre-fitted.\nMaster packing: 6 pcs per bundle.',
      options: JSON.stringify({ sizes: ['19 x 24 inch', '22 x 22 inch', '22 x 24 inch', '23 x 24 inch', '24 x 24 inch'] })
    };
  }
  if (n.includes('front load')) {
    return {
      descr: 'Front Load Trolly — fixed-frame trolley designed for front-load washing machines. Wide stable base, vibration-friendly design, smooth-rolling wheels with brake locks, 7-tank powder coated steel. Available in multiple sizes.',
      packing: 'Each trolley packed in an individual carton with wheels pre-fitted.\nMaster packing: 6 pcs per bundle.',
      options: JSON.stringify({ sizes: ['Ultra 6 kg', 'Ultra 7 kg', 'Ultra 8 kg'] })
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
   taxPercent  standard rate as at August 2026. Qatar and Kuwait have not
             introduced VAT (Kuwait has ruled it out before 2028, Qatar is
             expected to follow its e-invoicing law), so they sit at 0 and the
             admin can switch them on the day it lands.
   Licence formats are deliberately lenient — turning away a real dealer over
   a format guess is worse than the admin eyeballing the number at approval.
   ========================================================================== */
const ZONES = {
  IN: {
    code: 'IN', country: 'India', dial: '91', phoneLen: 10,
    currency: 'INR', symbol: '₹', locale: 'en-IN', decimals: 2, fx: 1,
    taxLabel: 'GST', taxPercent: 18,
    taxId: { label: 'GSTIN', placeholder: '36ABCDE1234F1Z5', hint: '15 characters, e.g. 36ABCDE1234F1Z5',
             re: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', upper: true, required: true },
    licence: null,
    regionLabel: 'State',
    postcode: { label: 'Pincode', re: '^[1-9][0-9]{5}$', hint: '6-digit pincode', required: true }
  },
  AE: {
    code: 'AE', country: 'United Arab Emirates', dial: '971', phoneLen: 9,
    currency: 'AED', symbol: 'AED', locale: 'en-AE', decimals: 2, fx: 0.0384,
    taxLabel: 'VAT', taxPercent: 5,
    taxId: { label: 'VAT TRN', placeholder: '100123456700003', hint: '15-digit Tax Registration Number',
             re: '^[0-9]{15}$', upper: false, required: true },
    licence: { label: 'Trade licence number', placeholder: 'e.g. CN-1234567', hint: 'as printed on your DED trade licence',
               re: '^[A-Za-z0-9][A-Za-z0-9\\-\\/ ]{2,29}$', upper: true, required: true },
    regionLabel: 'Emirate',
    postcode: null
  },
  SA: {
    code: 'SA', country: 'Saudi Arabia', dial: '966', phoneLen: 9,
    currency: 'SAR', symbol: 'SAR', locale: 'en-SA', decimals: 2, fx: 0.0392,
    taxLabel: 'VAT', taxPercent: 15,
    taxId: { label: 'VAT registration number', placeholder: '300123456700003', hint: '15 digits, starts and ends with 3',
             re: '^3[0-9]{13}3$', upper: false, required: true },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '1010123456', hint: '10-digit CR number',
               re: '^[0-9]{10}$', upper: false, required: true },
    regionLabel: 'Region',
    postcode: { label: 'Postal code', re: '^[0-9]{5}$', hint: '5-digit postal code', required: false }
  },
  OM: {
    code: 'OM', country: 'Oman', dial: '968', phoneLen: 8,
    currency: 'OMR', symbol: 'OMR', locale: 'en-OM', decimals: 3, fx: 0.00402,
    taxLabel: 'VAT', taxPercent: 5,
    taxId: { label: 'VAT identification number', placeholder: 'OM1100000000', hint: 'OM followed by 10 digits',
             re: '^OM[0-9]{10}$', upper: true, required: true },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '1234567', hint: '7 to 10 digits',
               re: '^[0-9]{7,10}$', upper: false, required: true },
    regionLabel: 'Governorate',
    postcode: { label: 'Postal code', re: '^[0-9]{3}$', hint: '3-digit postal code', required: false }
  },
  QA: {
    code: 'QA', country: 'Qatar', dial: '974', phoneLen: 8,
    currency: 'QAR', symbol: 'QAR', locale: 'en-QA', decimals: 2, fx: 0.0380,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'Tax Identification Number (TIN)', placeholder: '5012345678', hint: 'your Dhareeba TIN — leave blank if not registered',
             re: '^[0-9]{8,12}$', upper: false, required: false },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '123456', hint: '6 to 10 digits',
               re: '^[0-9]{6,10}$', upper: false, required: true },
    regionLabel: 'Municipality',
    postcode: null
  },
  KW: {
    code: 'KW', country: 'Kuwait', dial: '965', phoneLen: 8,
    currency: 'KWD', symbol: 'KWD', locale: 'en-KW', decimals: 3, fx: 0.00320,
    taxLabel: 'VAT', taxPercent: 0,
    taxId: { label: 'Tax card number', placeholder: 'optional', hint: 'Kuwait has no VAT yet — leave blank if you have no tax card',
             re: '^[A-Za-z0-9\\-\\/]{4,20}$', upper: true, required: false },
    licence: { label: 'Commercial Licence number', placeholder: '123456', hint: '4 to 12 digits',
               re: '^[0-9]{4,12}$', upper: false, required: true },
    regionLabel: 'Governorate',
    postcode: null
  },
  BH: {
    code: 'BH', country: 'Bahrain', dial: '973', phoneLen: 8,
    currency: 'BHD', symbol: 'BHD', locale: 'en-BH', decimals: 3, fx: 0.00393,
    taxLabel: 'VAT', taxPercent: 10,
    taxId: { label: 'VAT account number', placeholder: '200012345600002', hint: '15-digit VAT account number',
             re: '^[0-9]{15}$', upper: false, required: true },
    licence: { label: 'Commercial Registration (CR) number', placeholder: '12345-1', hint: 'CR number as issued by MOIC',
               re: '^[0-9]{4,8}(-[0-9]{1,3})?$', upper: false, required: true },
    regionLabel: 'Governorate',
    postcode: null
  }
};
const DEFAULT_ZONE = 'IN';
const zoneOf = c => ZONES[String(c || '').toUpperCase()] || null;

/* Seed the editable half of each zone once, then leave it to the admin. */
for (const z of Object.values(ZONES)) {
  db.prepare('INSERT OR IGNORE INTO zones(code,fx,tax_percent,enabled,updated_at) VALUES(?,?,?,1,?)')
    .run(z.code, z.fx, z.taxPercent, now());
}

/* The live settings for a zone: admin values if present, definition as fallback. */
function zoneLive(code) {
  const z = zoneOf(code) || ZONES[DEFAULT_ZONE];
  const r = db.prepare('SELECT * FROM zones WHERE code=?').get(z.code);
  const fx = r && isFinite(r.fx) && r.fx > 0 ? r.fx : z.fx;
  /* India keeps using the existing global GST setting so the admin's current
     screen carries on working exactly as before. */
  const tax = z.code === 'IN' ? gstPercent()
            : (r && isFinite(r.tax_percent) && r.tax_percent >= 0 ? r.tax_percent : z.taxPercent);
  return { ...z, fx, taxPercent: tax, enabled: r ? !!r.enabled : true };
}
const zoneOfUser = u => zoneLive(u && u.country ? u.country : DEFAULT_ZONE);

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
  for (const z of byLen) if (d.startsWith(z.dial)) return z.code;
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
  postcode: z.postcode, enabled: z.enabled !== false
});

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
  const adminSalt = crypto.randomBytes(8).toString('hex');
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
      req.role = s.role;
      req.user = s.role === 'user' ? db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) : null;
      req.token = tok;
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
  return zz.symbol + (zz.symbol.length > 1 ? ' ' : '') +
    Number(n || 0).toLocaleString(zz.locale, { minimumFractionDigits: 0, maximumFractionDigits: zz.decimals });
};
const pubNotif = n => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, orderId: n.order_id || '', createdAt: n.created_at, read: !!n.read_at });

const app = express();
app.use(express.json({ limit: '3mb' }));
const verifyAdminPw = pw => hashPw(String(pw || ''), getSetting('adminSalt')) === getSetting('adminHash');
app.use(auth);

/* ---------- public API ---------- */
app.get('/api/products', (req, res) => {
  const dealer = isDealer(req);
  const offer = dealer ? liveOffer() : null;
  const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort').all();
  /* Prices live in INR. A signed-in dealer sees them in their own currency; a
     guest sees the zone they picked, falling back to India. */
  const z = req.user ? zoneOfUser(req.user) : zoneLive(req.query.zone || DEFAULT_ZONE);
  const c = v => toZone(v, z);
  res.json({
    zone: pubZone(z),
    offer: dealer ? pubOffer(offer) : null,
    products: rows.map(p => ({
      id: p.id, name: p.name, cat: p.cat, emoji: p.emoji, image: p.image || '', mrp: c(p.mrp), moq: p.moq,
      descr: p.descr || '', packing: p.packing || '',
      options: p.options ? scaleOptions(p.options, z) : null,
      ...(dealer ? {
        dealer: c(rateFor(req.user, p, offer)),
        listDealer: c(customPrice(req.user.id, p.id) !== null ? customPrice(req.user.id, p.id) : p.dealer)
      } : {})
    }))
  });
});

/* Pack options carry a per-piece surcharge in INR ("+₹4 per set"), so it has to
 * travel through the same conversion as the price it is added to. */
function scaleOptions(json, z) {
  let o; try { o = JSON.parse(json); } catch (e) { return null; }
  if (o && Array.isArray(o.packs)) o.packs = o.packs.map(pk => ({ ...pk, add: toZone(pk.add || 0, z) }));
  return o;
}

const rzpKeys = () => ({ id: getSetting('rzpKeyId') || '', secret: getSetting('rzpKeySecret') || '' });
const rzpEnabled = () => { const k = rzpKeys(); return !!(k.id && k.secret); };

app.get('/api/pay-info', (req, res) => {
  const z = req.user ? zoneOfUser(req.user) : zoneLive(req.query.zone || DEFAULT_ZONE);
  res.json({
    payeeName: getSetting('payeeName'),
    bankName: getSetting('bankName'), accountNo: getSetting('accountNo'),
    ifsc: getSetting('ifsc'), whatsapp: getSetting('whatsapp'),
    /* gstPercent stays for older app builds; taxPercent/taxLabel are the
       zone-aware pair the current client reads. */
    gstPercent: z.taxPercent, taxPercent: z.taxPercent, taxLabel: z.taxLabel,
    zone: pubZone(z),
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
app.get('/api/admin/zones', requireAdmin, (req, res) => {
  res.json(Object.keys(ZONES).map(c => {
    const z = zoneLive(c);
    const n = db.prepare("SELECT COUNT(*) n FROM users WHERE country=? AND status='approved'").get(c).n;
    const pend = db.prepare("SELECT COUNT(*) n FROM users WHERE country=? AND status IN ('pending','incomplete')").get(c).n;
    return { ...pubZone(z), dealers: n, pending: pend, baseFx: ZONES[c].fx, baseTax: ZONES[c].taxPercent };
  }));
});

app.post('/api/admin/zones', requireAdmin, (req, res) => {
  const rows = Array.isArray(req.body?.zones) ? req.body.zones : [];
  const upd = db.prepare('UPDATE zones SET fx=?, tax_percent=?, enabled=?, updated_at=? WHERE code=?');
  for (const r of rows) {
    const z = zoneOf(r.code);
    if (!z) continue;
    const fx = parseFloat(r.fx);
    const tax = parseFloat(r.taxPercent);
    if (!isFinite(fx) || fx <= 0) return res.status(400).json({ error: 'Enter a positive exchange rate for ' + z.country + '.' });
    if (!isFinite(tax) || tax < 0 || tax > 100) return res.status(400).json({ error: 'Enter a tax rate between 0 and 100 for ' + z.country + '.' });
    /* India is never switched off — it is the home market and the base currency. */
    const en = z.code === 'IN' ? 1 : (r.enabled ? 1 : 0);
    upd.run(fx, tax, en, now(), z.code);
    if (z.code === 'IN') setSetting('gstPercent', tax);
  }
  res.json({ ok: true, zones: Object.keys(ZONES).map(c => pubZone(zoneLive(c))) });
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
  if (key) {
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
  /* Tax numbers are only unique within a country, and some zones allow a blank
     one, so an empty value must never collide with another blank. */
  if (f.gstin && db.prepare('SELECT 1 FROM users WHERE gstin=? AND country=?').get(f.gstin, f.country))
    return res.status(400).json({ error: 'This ' + z.taxId.label + ' is already registered — try logging in or contact support.' });
  const salt = crypto.randomBytes(8).toString('hex');
  const id = uid('u');
  const mCode = String(Math.floor(100000 + Math.random() * 900000));
  const phoneNat = nationalDigits(f.phone, z);
  db.prepare(`INSERT INTO users(id,name,phone,email,pass_hash,salt,company,gstin,type,addr,city,state,pincode,whatsapp,status,mobile_code,email_ok,created_at,country,licence_no)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,1,?,?,?)`)
    .run(id, f.name, phoneNat, f.email, hashPw(f.password, salt), salt, f.company, f.gstin, f.type, f.addr, f.city, f.state, f.pincode, waNat, mCode, now(), f.country, f.licence);
  notifyAdmin('registration', 'New registration — ' + f.company,
    f.name + ' (' + f.type + ') from ' + (f.city || '—') + ', ' + z.country + ', mobile +' + z.dial + ' ' + phoneNat +
    '. Verify the ' + (z.taxId ? z.taxId.label : 'business details') + ' and approve the account.');
  /* the verification code goes straight to their mobile */
  sendCode(db.prepare('SELECT * FROM users WHERE id=?').get(id), 'verification', mCode,
    'They have just registered.').catch(() => {});
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,?,?,?)').run(token, id, 'user', now());
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
  /* Numbers can arrive with a country code (+91, +971, +1 …) or without, so we
     match on the last ten digits first — that identifies an Indian mobile
     whichever way it was typed — then fall back to the whole number for
     shorter foreign ones. */
  const tail = digits.slice(-10);
  let u = null;
  if (tail.length === 10) {
    u = db.prepare(`SELECT * FROM users WHERE substr(${norm('phone')}, -10)=?
        OR substr(${norm('whatsapp')}, -10)=?`).get(tail, tail) || null;
  }
  if (!u) {
    u = db.prepare(`SELECT * FROM users WHERE ${norm('phone')}=? OR ${norm('whatsapp')}=?`)
      .get(digits, digits) || null;
  }
  if (!u && digits.length > 10) {
    /* stored without the country code */
    const short = digits.slice(-9);
    u = db.prepare(`SELECT * FROM users WHERE substr(${norm('phone')}, -9)=?
        OR substr(${norm('whatsapp')}, -9)=?`).get(short, short) || null;
  }
  return u;
}

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || req.body?.id || '').trim();
  const password = String(req.body?.password || '');
  if (email.toLowerCase() === String(getSetting('adminEmail')).toLowerCase()) {
    if (hashPw(password, getSetting('adminSalt')) === getSetting('adminHash')) {
      const token = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,NULL,?,?)').run(token, 'admin', now());
      return res.json({ token, role: 'admin' });
    }
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const u = findAccount(email);
  if (!u || hashPw(password, u.salt) !== u.pass_hash)
    return res.status(401).json({ error: 'Those details did not match an account. Check the email or mobile number and password.' });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,?,?,?)').run(token, u.id, 'user', now());
  res.json({ token, role: 'user', user: pubUser(u) });
});

/* ---------- mobile & email verification ----------
 * No SMS/email gateway is needed: the admin sees each pending code in the
 * Registrations tab and sends it to the customer on WhatsApp (one tap) or by
 * email. The customer types it back in, which proves the number is theirs. */
app.post('/api/verify', requireUser, (req, res) => {
  const code = String(req.body?.code || '').trim();
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
  if (!u.mobile_code) return res.status(400).json({ error: 'No code was issued. Ask us to resend it.' });
  if (code !== String(u.mobile_code)) return res.status(400).json({ error: 'That code does not match. Please check and try again.' });
  db.prepare('UPDATE users SET mobile_ok=1, email_ok=1 WHERE id=?').run(u.id);
  const after = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  notifyAdmin('registration', 'Mobile number verified',
    after.company + ' has verified their WhatsApp number. Ready for your approval.');
  res.json({ ok: true, user: pubUser(after) });
});

/* customer taps "resend" — same code, sent again over the gateway */
const resendAt = new Map();
app.post('/api/verify/resend', requireUser, async (req, res) => {
  const kind = 'mobile';
  const key = req.user.id + ':' + kind;
  const last = resendAt.get(key) || 0;
  if (Date.now() - last < 60000)
    return res.status(429).json({ error: 'Please wait a minute before asking for another code.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (u.mobile_ok) return res.status(400).json({ error: 'Already verified.' });
  let code = u.mobile_code;
  if (!code) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('UPDATE users SET mobile_code=? WHERE id=?').run(code, u.id);
  }
  resendAt.set(key, Date.now());
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
  const code = String(Math.floor(100000 + Math.random() * 900000));
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
const otpAt = new Map();
const OTP_WINDOW_MS = 10 * 60 * 1000;

app.post('/api/otp/request', async (req, res) => {
  const raw = String(req.body?.mobile || req.body?.id || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15)
    return res.status(400).json({ error: 'Enter a valid mobile number.' });

  const u = findAccount(raw);
  const key = 'o:' + (u ? u.id : digits);
  if (Date.now() - (otpAt.get(key) || 0) < 45000)
    return res.status(429).json({ error: 'A code was just sent. Please wait a moment before asking again.' });
  otpAt.set(key, Date.now());

  const code = String(Math.floor(100000 + Math.random() * 900000));
  let r;
  if (u) {
    db.prepare('UPDATE users SET login_code=?, login_at=? WHERE id=?').run(code, now(), u.id);
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

  const u = findAccount(raw);

  /* someone we already know */
  if (u) {
    if (!u.login_code) return res.status(400).json({ error: 'Ask for a code first.' });
    const age = Date.now() - new Date(u.login_at || 0).getTime();
    if (!(age >= 0 && age < OTP_WINDOW_MS)) {
      db.prepare("UPDATE users SET login_code='' WHERE id=?").run(u.id);
      return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
    }
    if (code !== String(u.login_code)) return res.status(400).json({ error: 'That code is not right. Please check and try again.' });
    db.prepare("UPDATE users SET login_code='', login_at='', mobile_ok=1 WHERE id=?").run(u.id);
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,?,?,?)').run(token, u.id, 'user', now());
    const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
    return res.json({ token, role: 'user', user: pubUser(fresh),
      needsProfile: fresh.status === 'incomplete' });
  }

  /* a number we have never seen — check the held code, then start their account */
  const row = db.prepare('SELECT * FROM otp_codes WHERE mobile=?').get(digits);
  if (!row) return res.status(400).json({ error: 'Ask for a code first.' });
  if ((row.tries || 0) >= 5) {
    db.prepare('DELETE FROM otp_codes WHERE mobile=?').run(digits);
    return res.status(429).json({ error: 'Too many wrong attempts. Please ask for a new code.' });
  }
  const age = Date.now() - new Date(row.created_at || 0).getTime();
  if (!(age >= 0 && age < OTP_WINDOW_MS)) {
    db.prepare('DELETE FROM otp_codes WHERE mobile=?').run(digits);
    return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
  }
  if (code !== String(row.code)) {
    db.prepare('UPDATE otp_codes SET tries=tries+1 WHERE mobile=?').run(digits);
    return res.status(400).json({ error: 'That code is not right. Please check and try again.' });
  }

  db.prepare('DELETE FROM otp_codes WHERE mobile=?').run(digits);
  const id = uid('u');
  const salt = crypto.randomBytes(8).toString('hex');
  /* The dial code they verified on tells us which country they are in, so the
     details form that follows already shows the right tax fields. */
  const cc = countryFromDigits(digits);
  const ten = nationalDigits(digits, ZONES[cc]);
  db.prepare(`INSERT INTO users(id,name,phone,email,pass_hash,salt,company,gstin,type,addr,city,state,pincode,
      whatsapp,status,mobile_ok,email_ok,created_at,country,licence_no)
    VALUES(?,'',?,?,?,?,'',NULL,'Dealer','','','','',?,'incomplete',1,1,?,?,'')`)
    .run(id, ten, id + '@pending.bluewave', hashPw(crypto.randomBytes(12).toString('hex'), salt), salt, ten, now(), cc);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,?,?,?)').run(token, id, 'user', now());
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
    salt = crypto.randomBytes(8).toString('hex');
    hash = hashPw(String(b.password), salt);
  }
  db.prepare(`UPDATE users SET name=?, email=?, company=?, gstin=?, type=?, addr=?, city=?, state=?,
      pincode=?, phone=?, whatsapp=?, pass_hash=?, salt=?, country=?, licence_no=?, status='pending' WHERE id=?`)
    .run(f.name, f.email, f.company, f.gstin, type, f.addr, f.city, f.state, f.pincode,
      phone, waNum, hash, salt, f.country, f.licence, u.id);

  notifyAdmin('registration', 'New registration — ' + f.company,
    f.name + ' (' + type + ') from ' + (f.city || '—') + ', ' + z.country + ', mobile +' + z.dial + ' ' + phone +
    '. Number already verified by OTP. Check the ' + (z.taxId ? z.taxId.label : 'business details') + ' and approve.');
  res.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});

/* ---------- forgotten password ----------
 * Back now that codes actually reach the customer: a 6-digit code by SMS, good
 * for 30 minutes, then they set a new password. */
const forgotAt = new Map();
const RESET_WINDOW_MS = 30 * 60 * 1000;

app.post('/api/forgot', async (req, res) => {
  const idRaw = String(req.body?.id || req.body?.mobile || '').trim();
  if (!idRaw) return res.status(400).json({ error: 'Enter your registered email or mobile number.' });
  const u = findAccount(idRaw);
  const generic = { ok: true, sent: false, hint: 'If that account is registered, a code is on its way.' };
  if (!u) return res.json(generic);
  const key = 'f:' + u.id;
  if (Date.now() - (forgotAt.get(key) || 0) < 45000)
    return res.status(429).json({ error: 'A code was just sent. Please wait a moment before asking again.' });
  forgotAt.set(key, Date.now());
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET reset_code=?, reset_at=? WHERE id=?').run(code, now(), u.id);
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
  const u = findAccount(String(req.body?.id || req.body?.mobile || ''));
  if (!u || !u.reset_code) return res.status(400).json({ error: 'No reset is pending for that account. Ask for a new code.' });
  const age = Date.now() - new Date(u.reset_at || 0).getTime();
  if (!(age >= 0 && age < RESET_WINDOW_MS)) {
    db.prepare("UPDATE users SET reset_code='' WHERE id=?").run(u.id);
    return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
  }
  if (code !== String(u.reset_code)) return res.status(400).json({ error: 'That code does not match. Please check and try again.' });
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare("UPDATE users SET pass_hash=?, salt=?, reset_code='', reset_at='' WHERE id=?")
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
  if (hashPw(String(req.body?.current || ''), u.salt) !== u.pass_hash)
    return res.status(400).json({ error: 'Current password is incorrect.' });
  const np = String(req.body?.newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const salt = crypto.randomBytes(8).toString('hex');
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
  /* The order is written in the dealer's own currency — that is the figure they
     agreed to and the one their invoice has to show. */
  const z = req.user ? zoneOfUser(req.user) : zoneLive(b.zone || DEFAULT_ZONE);
  const lines = [];
  for (const it of items) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(String(it.pid));
    const qty = Math.floor(Number(it.qty));
    if (!p || !qty || qty < 1) return res.status(400).json({ error: 'Invalid item in cart.' });
    let rate = toZone(dealer ? rateFor(req.user, p) : p.mrp, z);
    let label = p.name;
    const opts = p.options ? JSON.parse(p.options) : null;
    if (opts && opts.packs) {
      const pk = opts.packs.find(x => x.id === String(it.pack || 'gunny')) || opts.packs[0];
      const add = toZone(pk.add || 0, z);
      rate = Math.round((rate + add) * Math.pow(10, z.decimals)) / Math.pow(10, z.decimals);
      label += ' — ' + pk.label + (add ? ' (+' + z.symbol + add + '/pc)' : '');
    }
    if (opts && opts.sizes) {
      const sz = String(it.size || '');
      if (!opts.sizes.includes(sz)) return res.status(400).json({ error: 'Please choose a size for ' + p.name + '.' });
      label += ' — ' + sz;
    }
    lines.push({ pid: p.id, name: label, qty, rate });
  }
  /* Prices are tax-inclusive: total = listed price; tax = the portion within it.
     A zone with no VAT yet (Qatar, Kuwait) simply books zero. */
  const subtotal = lines.reduce((s, l) => s + l.rate * l.qty, 0);
  const r = z.taxPercent;
  const gst = r > 0 ? Math.round((subtotal - subtotal / (1 + r / 100)) * 100) / 100 : 0;
  const total = subtotal;
  const transport = String(b.transport || '').trim().slice(0, 80);
  const id = nextOrderId();
  db.prepare(`INSERT INTO orders(id,user_id,contact_json,addr,notes,items_json,subtotal,gst,total,tier,status,transport,created_at,country,currency,fx_rate,tax_percent,tax_label)
    VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?,?,?,?,?,?)`)
    .run(id, req.user ? req.user.id : null, JSON.stringify(contact), addr, String(b.notes || '').trim(), JSON.stringify(lines), subtotal, gst, total, dealer ? 'dealer' : 'mrp', transport, now(),
      z.code, z.currency, z.fx, r, z.taxLabel);
  res.json({ order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
});

/* Orders placed before multi-zone have no snapshot, so they read as Indian
 * rupees at the global GST rate — exactly what they were. */
const orderZone = o => {
  const z = zoneLive(o.country || DEFAULT_ZONE);
  /* Careful: isFinite(null) is true and null >= 0 is true, so a NULL column
     would sail through a naive check and come back out as null. */
  const tax = (o.tax_percent !== null && o.tax_percent !== undefined
               && isFinite(o.tax_percent) && o.tax_percent >= 0) ? o.tax_percent : gstPercent();
  return { ...z, currency: o.currency || z.currency, taxPercent: tax, taxLabel: o.tax_label || z.taxLabel };
};

const orderOut = o => ({
  id: o.id, userId: o.user_id, contact: JSON.parse(o.contact_json), addr: o.addr, notes: o.notes,
  items: JSON.parse(o.items_json), subtotal: o.subtotal, gst: o.gst, total: o.total,
  country: o.country || DEFAULT_ZONE, currency: orderZone(o).currency, symbol: orderZone(o).symbol,
  decimals: orderZone(o).decimals, locale: orderZone(o).locale,
  taxPercent: orderZone(o).taxPercent, taxLabel: orderZone(o).taxLabel, fxRate: o.fx_rate || 1,
  gstPercent: orderZone(o).taxPercent, tier: o.tier, status: o.status, payRef: o.pay_ref,
  transport: o.transport || '', lrNumber: o.lr_number || '', dispatchTransport: o.dispatch_transport || '',
  dispatchMode: o.dispatch_mode || '', vehicleNo: o.vehicle_no || '', driverName: o.driver_name || '', driverPhone: o.driver_phone || '',
  dispatchedAt: o.dispatched_at || '', creditDue: o.credit_due || '', creditSettled: !!o.credit_settled,
  createdAt: o.created_at
});

app.get('/api/my/orders', requireUser, (req, res) => {
  res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.user.id).map(orderOut));
});

app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.user_id && !(req.role === 'admin' || (req.user && req.user.id === o.user_id)))
    return res.status(403).json({ error: 'Not allowed.' });
  res.json(orderOut(o));
});

app.post('/api/orders/:id/payment', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.user_id && !(req.user && req.user.id === o.user_id) && req.role !== 'admin')
    return res.status(403).json({ error: 'Not allowed.' });
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

/* ---------- Razorpay gateway ---------- */
app.post('/api/orders/:id/rzp-order', async (req, res) => {
  if (!rzpEnabled()) return res.status(400).json({ error: 'Online payment is not enabled yet. Please pay by UPI/bank transfer.' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.user_id && !(req.user && req.user.id === o.user_id) && req.role !== 'admin')
    return res.status(403).json({ error: 'Not allowed.' });
  if (o.status !== 'awaiting_payment') return res.status(400).json({ error: 'Payment already recorded for this order.' });
  const k = rzpKeys();
  try {
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(k.id + ':' + k.secret).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: Math.round(o.total * 100), currency: 'INR', receipt: o.id })
    });
    const d = await r.json();
    if (!r.ok || !d.id) return res.status(502).json({ error: (d.error && d.error.description) || 'Payment gateway error — try UPI/bank transfer instead.' });
    db.prepare('UPDATE orders SET rzp_order_id=? WHERE id=?').run(d.id, o.id);
    res.json({ rzpOrderId: d.id, keyId: k.id, amount: Math.round(o.total * 100), currency: 'INR', name: getSetting('payeeName'), contact: JSON.parse(o.contact_json) });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach payment gateway — try UPI/bank transfer instead.' });
  }
});

app.post('/api/orders/:id/rzp-verify', (req, res) => {
  if (!rzpEnabled()) return res.status(400).json({ error: 'Online payment is not enabled.' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
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
    .run(name, company, nationalDigits(phone, uz), nationalDigits(whatsapp || phone, uz), email, gstin, type, addr, city,
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
  remHour: '10',                  // local hour to send (24h)
  remProvider: '',                // '', 'whatsapp' (Meta Cloud API) or 'msg91'
  remTemplate: 'Dear {name}, this is a payment reminder from HPMP Manufacturers (Blue Wave). Order {order} of {amount} placed on {date} is {due}. Kindly arrange the payment. Thank you.'
};
const rs = k => { const v = getSetting(k); return v === null || v === undefined || v === '' ? REM_DEFAULTS[k] : v; };
const dayList = s => String(s || '').split(',').map(x => parseInt(x.trim())).filter(n => isFinite(n) && n >= 0);
const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86400000);

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
      body: JSON.stringify({ sender, route: ss('smsRoute'), country: '91', sms: [{ message: text, to: [mobile] }] }),
      signal: AbortSignal.timeout(12000)
    });
    return reply(r, 'Send SMS');
  } catch (e) { return { ok: false, status: 'Could not reach MSG91', detail: e.message }; }
}

async function smsFast2Sms(to, text) {
  const key = getSetting('smsKey');
  if (!key) return { ok: false, status: 'Fast2SMS API key not saved', detail: 'Paste the API key in Settings and save.' };
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
    return (r.ok && d.return === true)
      ? { ok: true, status: 'sent', detail: raw.slice(0, 300) }
      : { ok: false, status: 'Fast2SMS replied ' + r.status, detail: raw.slice(0, 300) };
  } catch (e) { return { ok: false, status: 'Could not reach Fast2SMS', detail: e.message }; }
}

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
  if (!force && new Date().getHours() !== (isFinite(hour) ? hour : 10)) return { skipped: 'not_send_hour' };
  let sent = 0, skipped = 0;
  for (const row of creditOutstanding()) {
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
  return { sent, skipped, checked: creditOutstanding().length };
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
  res.json({ ok: true, id });
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
const BACKUP_TABLES = ['users', 'products', 'orders', 'settings', 'transports', 'dealer_prices', 'offers', 'notifications'];

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
      db.prepare('DELETE FROM ' + t).run();
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        db.prepare('INSERT OR REPLACE INTO ' + t + ' (' + cols.join(',') + ') VALUES (' +
          cols.map(() => '?').join(',') + ')').run(...cols.map(c => row[c]));
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
  if (scope === 'accounts') {
    db.prepare('DELETE FROM users').run();
    db.prepare("DELETE FROM sessions WHERE role='user'").run();
  } else if (scope === 'orders') {
    db.prepare('DELETE FROM orders').run();
  } else return res.status(400).json({ error: 'Bad scope.' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/delete', requireAdmin, (req, res) => {
  if (!verifyAdminPw(req.body?.password)) return res.status(403).json({ error: 'Verification password is incorrect — deletion cancelled.' });
  const r = db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'User not found.' });
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
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
    rzpKeyId: getSetting('rzpKeyId') || '', rzpSecretSet: !!getSetting('rzpKeySecret'),
    gstApiKeySet: !!getSetting('gstApiKey'),
    remProvider: rs('remProvider'), remAuto: getSetting('remAuto') === '0' ? '0' : '1',
    remBefore: rs('remBefore'), remOnDue: rs('remOnDue'),
    remAfter: rs('remAfter'), remHour: rs('remHour'), remTemplate: rs('remTemplate'),
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
    'remProvider', 'remAuto', 'remBefore', 'remOnDue', 'remAfter', 'remHour', 'remTemplate', 'waPhoneId', 'smsSender',
    'smsProvider', 'smsRoute', 'smsTemplateId', 'twilioSid', 'twilioFrom',
    'smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smtpFromName'])
    if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  for (const k of ['waToken', 'smsKey', 'twilioToken', 'smtpPass'])
    if (b[k] !== undefined && String(b[k]).trim() !== '') setSetting(k, String(b[k]).trim());
  if (b.gstPercent !== undefined) { const g = parseFloat(b.gstPercent); if (isFinite(g) && g >= 0 && g <= 100) setSetting('gstPercent', g); }
  if (b.rzpKeySecret !== undefined && String(b.rzpKeySecret).trim() !== '')
    setSetting('rzpKeySecret', String(b.rzpKeySecret).trim());
  if (b.gstApiKey !== undefined && String(b.gstApiKey).trim() !== '')
    setSetting('gstApiKey', String(b.gstApiKey).trim());
  if (b.rzpClear) { setSetting('rzpKeyId', ''); setSetting('rzpKeySecret', ''); }
  if (b.adminPassword) {
    const salt = crypto.randomBytes(8).toString('hex');
    setSetting('adminSalt', salt);
    setSetting('adminHash', hashPw(String(b.adminPassword), salt));
  }
  res.json({ ok: true });
});

/* ---------- static frontend ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Blue Wave app running on port ' + PORT));
