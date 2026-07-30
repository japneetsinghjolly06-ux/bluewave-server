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
try { db.exec("ALTER TABLE users ADD COLUMN whatsapp TEXT DEFAULT ''"); } catch (e) { /* column exists */ }
/* in-app notifications: user_id 'admin' means the admin panel */
db.exec(`CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, title TEXT, body TEXT,
  order_id TEXT DEFAULT '', created_at TEXT, read_at TEXT DEFAULT '')`);
db.exec('CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at)');

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

/* ---------- seed ---------- */
if (!getSetting('seeded')) {
  const seed = [
    ['XEON AC Bracket (2.7 Kg)', 'AC Brackets', '❄️', 1299, 320],
    ['XEON AC Bracket (3 Kg)', 'AC Brackets', '❄️', 1299, 335],
    ['XEON AC Bracket (3.5 Kg)', 'AC Brackets', '❄️', 1299, 365],
    ['TITANIC AC Bracket (5 Kg)', 'AC Brackets', '❄️', 1299, 550],
    ['XUV 700 Adjustable Trolley', 'Adjustable Trolleys', '🧺', 2999, 690],
    ['XUV 300 Adjustable Trolley', 'Adjustable Trolleys', '🧺', 2999, 545],
    ['Angle Trolly', 'Fixed Trolleys', '🧺', 1999, 530],
    ['Front Load Trolly', 'Fixed Trolleys', '🧺', 1999, 625],
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
const pubUser = u => u && ({ id: u.id, name: u.name, phone: u.phone, email: u.email, company: u.company, gstin: u.gstin, type: u.type, addr: u.addr, city: u.city, state: u.state, pincode: u.pincode || '', whatsapp: u.whatsapp || u.phone || '', status: u.status, note: u.note, terms: u.terms || 'advance', creditDays: u.credit_days || 0, discount: u.discount || 0,
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
const fmtMoney = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
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
  res.json({
    offer: dealer ? pubOffer(offer) : null,
    products: rows.map(p => ({
      id: p.id, name: p.name, cat: p.cat, emoji: p.emoji, image: p.image || '', mrp: p.mrp, moq: p.moq,
      descr: p.descr || '', packing: p.packing || '',
      options: p.options ? JSON.parse(p.options) : null,
      ...(dealer ? {
        dealer: rateFor(req.user, p, offer),
        listDealer: (customPrice(req.user.id, p.id) !== null ? customPrice(req.user.id, p.id) : p.dealer)
      } : {})
    }))
  });
});

const rzpKeys = () => ({ id: getSetting('rzpKeyId') || '', secret: getSetting('rzpKeySecret') || '' });
const rzpEnabled = () => { const k = rzpKeys(); return !!(k.id && k.secret); };

app.get('/api/pay-info', (req, res) => {
  res.json({
    payeeName: getSetting('payeeName'),
    bankName: getSetting('bankName'), accountNo: getSetting('accountNo'),
    ifsc: getSetting('ifsc'), whatsapp: getSetting('whatsapp'), gstPercent: gstPercent(),
    razorpay: { enabled: rzpEnabled(), keyId: rzpEnabled() ? rzpKeys().id : '' },
    smsProvider: ss('smsProvider') || '', mailReady: mailReady()
  });
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
  for (const k of ['name', 'phone', 'email', 'password', 'company', 'gstin', 'type', 'addr', 'city', 'state', 'pincode'])
    f[k] = String(b[k] || '').trim();
  const waNum = String(b.whatsapp || '').trim() || f.phone;
  f.gstin = f.gstin.toUpperCase();
  if (Object.entries(f).some(([k, v]) => !v)) return res.status(400).json({ error: 'Please fill all required fields.' });
  if (!/^\d{10}$/.test(f.phone.replace(/\D/g, '').slice(-10))) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });
  if (!/^[1-9]\d{5}$/.test(f.pincode)) return res.status(400).json({ error: 'Enter a valid 6-digit pincode.' });
  if (!/^\d{10}$/.test(waNum.replace(/\D/g, '').slice(-10))) return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (f.password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!GSTIN_RE.test(f.gstin)) return res.status(400).json({ error: 'GSTIN format looks invalid. Expected 15 characters like 36ABCDE1234F1Z5.' });
  if (f.email.toLowerCase() === String(getSetting('adminEmail')).toLowerCase()) return res.status(400).json({ error: 'This email is reserved.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(f.email)) return res.status(400).json({ error: 'An account with this email already exists — try logging in.' });
  if (db.prepare('SELECT 1 FROM users WHERE gstin=?').get(f.gstin)) return res.status(400).json({ error: 'This GSTIN is already registered — try logging in or contact support.' });
  const salt = crypto.randomBytes(8).toString('hex');
  const id = uid('u');
  const mCode = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare(`INSERT INTO users(id,name,phone,email,pass_hash,salt,company,gstin,type,addr,city,state,pincode,whatsapp,status,mobile_code,email_ok,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,1,?)`)
    .run(id, f.name, f.phone, f.email, hashPw(f.password, salt), salt, f.company, f.gstin, f.type, f.addr, f.city, f.state, f.pincode, waNum.replace(/\D/g, '').slice(-10), mCode, now());
  notifyAdmin('registration', 'New registration — ' + f.company,
    f.name + ' (' + f.type + ') from ' + (f.city || '—') + ', mobile ' + f.phone +
    '. Verify the GSTIN and approve the account.');
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
  const idRaw = String(req.body?.mobile || req.body?.id || '').trim();
  if (!idRaw) return res.status(400).json({ error: 'Enter your registered mobile number.' });
  const u = findAccount(idRaw);
  /* same answer either way, so the form can't be used to find out who is registered */
  const generic = { ok: true, sent: false, hint: 'If that number is registered, a code is on its way.' };
  if (!u) return res.json(generic);
  const key = 'o:' + u.id;
  if (Date.now() - (otpAt.get(key) || 0) < 45000)
    return res.status(429).json({ error: 'A code was just sent. Please wait a moment before asking again.' });
  otpAt.set(key, Date.now());

  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET login_code=?, login_at=? WHERE id=?').run(code, now(), u.id);
  const to = String(u.whatsapp || u.phone || '');
  const r = await sendCode(u, 'login', code, 'They are signing in.');
  const mask = to.replace(/\D/g, '').slice(-10).replace(/^(\d{2})\d{6}(\d{2})$/, '$1******$2');
  const maskMail = String(u.email || '').replace(/^(.).*(@.*)$/, '$1•••$2');
  res.json({ ok: true, sent: r.ok, withAdmin: !r.ok, via: r.via || '',
    to: r.via === 'email' ? maskMail : mask });
});

app.post('/api/otp/login', (req, res) => {
  const idRaw = String(req.body?.mobile || req.body?.id || '').trim();
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
  const u = findAccount(idRaw);
  if (!u || !u.login_code) return res.status(400).json({ error: 'Ask for a code first.' });
  const age = Date.now() - new Date(u.login_at || 0).getTime();
  if (!(age >= 0 && age < OTP_WINDOW_MS)) {
    db.prepare("UPDATE users SET login_code='' WHERE id=?").run(u.id);
    return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
  }
  if (code !== String(u.login_code)) return res.status(400).json({ error: 'That code is not right. Please check and try again.' });
  db.prepare("UPDATE users SET login_code='', login_at='', mobile_ok=1 WHERE id=?").run(u.id);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,role,created_at) VALUES(?,?,?,?)').run(token, u.id, 'user', now());
  res.json({ token, role: 'user', user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
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
  if (!f.addr || !f.city || !f.state) return res.status(400).json({ error: 'Address, city and state are required.' });
  if (!/^\d{10}$/.test(f.phone.replace(/\D/g, '').slice(-10))) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });
  if (f.pincode && !/^[1-9]\d{5}$/.test(f.pincode)) return res.status(400).json({ error: 'Enter a valid 6-digit pincode.' });
  if (f.whatsapp && !/^\d{10}$/.test(f.whatsapp.replace(/\D/g, '').slice(-10))) return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number.' });
  db.prepare('UPDATE users SET addr=?, city=?, state=?, phone=?, pincode=?, whatsapp=? WHERE id=?')
    .run(f.addr, f.city, f.state, f.phone, f.pincode, (f.whatsapp || f.phone).replace(/\D/g, '').slice(-10), u.id);
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
  const lines = [];
  for (const it of items) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(String(it.pid));
    const qty = Math.floor(Number(it.qty));
    if (!p || !qty || qty < 1) return res.status(400).json({ error: 'Invalid item in cart.' });
    let rate = dealer ? rateFor(req.user, p) : p.mrp;
    let label = p.name;
    const opts = p.options ? JSON.parse(p.options) : null;
    if (opts && opts.packs) {
      const pk = opts.packs.find(x => x.id === String(it.pack || 'gunny')) || opts.packs[0];
      rate += pk.add || 0;
      label += ' — ' + pk.label + (pk.add ? ' (+₹' + pk.add + '/pc)' : '');
    }
    if (opts && opts.sizes) {
      const sz = String(it.size || '');
      if (!opts.sizes.includes(sz)) return res.status(400).json({ error: 'Please choose a size for ' + p.name + '.' });
      label += ' — ' + sz;
    }
    lines.push({ pid: p.id, name: label, qty, rate });
  }
  /* Prices are GST-inclusive: total = listed price; gst = tax portion included within it */
  const subtotal = lines.reduce((s, l) => s + l.rate * l.qty, 0);
  const r = gstPercent();
  const gst = Math.round((subtotal - subtotal / (1 + r / 100)) * 100) / 100;
  const total = subtotal;
  const transport = String(b.transport || '').trim().slice(0, 80);
  const id = nextOrderId();
  db.prepare(`INSERT INTO orders(id,user_id,contact_json,addr,notes,items_json,subtotal,gst,total,tier,status,transport,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?)`)
    .run(id, req.user ? req.user.id : null, JSON.stringify(contact), addr, String(b.notes || '').trim(), JSON.stringify(lines), subtotal, gst, total, dealer ? 'dealer' : 'mrp', transport, now());
  res.json({ order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
});

const orderOut = o => ({
  id: o.id, userId: o.user_id, contact: JSON.parse(o.contact_json), addr: o.addr, notes: o.notes,
  items: JSON.parse(o.items_json), subtotal: o.subtotal, gst: o.gst, total: o.total,
  gstPercent: gstPercent(), tier: o.tier, status: o.status, payRef: o.pay_ref,
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
  notifyAdmin('order', '🧾 New order ' + o.id,
    (who.company || who.name || 'Customer') + ' — ' + fmtMoney(o.total) + ', payment reference ' + ref + '. Confirm and dispatch.', o.id);
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
    notify(u.id, 'offer', '🎉 ' + name,
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

  if (!name || !company) return res.status(400).json({ error: 'Name and company are required.' });
  if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, '').slice(-10)))
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const gi = gstinParse(gstin);
  if (!gi.valid) return res.status(400).json({ error: 'GSTIN format is not valid.' });
  if (pincode && !/^\d{6}$/.test(pincode)) return res.status(400).json({ error: 'Pincode must be 6 digits.' });

  const dupE = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?').get(email, u.id);
  if (dupE) return res.status(409).json({ error: 'Another account already uses that email.' });
  const dupG = db.prepare('SELECT id FROM users WHERE gstin=? AND id<>?').get(gstin, u.id);
  if (dupG) return res.status(409).json({ error: 'Another account already uses that GSTIN.' });

  db.prepare(`UPDATE users SET name=?, company=?, phone=?, whatsapp=?, email=?, gstin=?, type=?,
    addr=?, city=?, state=?, pincode=? WHERE id=?`)
    .run(name, company, phone, whatsapp || phone, email, gstin, type, addr, city,
      state || gi.stateName || '', pincode, u.id);
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
    notify(u.id, 'approval', '✅ Account approved',
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
    .replace(/{amount}/g, '₹' + Number(o.total).toLocaleString('en-IN'))
    .replace(/{date}/g, new Date(o.created_at).toLocaleDateString('en-IN'))
    .replace(/{due}/g, due)
    .replace(/{dueDate}/g, o.credit_due ? new Date(o.credit_due).toLocaleDateString('en-IN') : '')
    ;
}
const waLink = (phone, text) =>
  'https://wa.me/' + String(phone || '').replace(/\D/g, '').replace(/^0+/, '').replace(/^(?!91)/, '91') +
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
const intlNumber = phone => {
  const n = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
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
  const to = String(user.whatsapp || user.phone || '');
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

  if (!r.ok) notifyAdmin('verify', purpose[0].toUpperCase() + purpose.slice(1) + ' code — ' + (user.company || user.name),
    (user.name || '') + ' (' + to + ') needs their ' + purpose + ' code: ' + code + '.' +
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
      waLink: waLink(r.phone, reminderText({ ...r.order, contact_name: r.contact.name }, r.user, r.dueDays)),
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
    paid: ['💰 Payment confirmed', 'We have confirmed your payment. Your order is being prepared.'],
    confirmed: ['✅ Order confirmed', 'Your order is confirmed and is being packed.'],
    shipped: ['🚚 Order dispatched', 'Your order has left our facility. Open the order to see the dispatch details.'],
    delivered: ['📦 Order delivered', 'Your order is marked delivered. Thank you for your business!'],
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
    .run(id, name, cat, cat.toLowerCase().includes('bracket') ? '❄️' : '🧺', mrp, dealer, Math.max(1, parseInt(b.moq) || 50), sort);
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
  if (o.user_id) notify(o.user_id, 'order', '🚚 Order ' + o.id + ' dispatched',
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
