// SFC Cafe – mobile ordering app
// Zero-dependency Node.js server (Node 18+). Run: node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// On a real host (Render sets RENDER=true) there is no default password: if ADMIN_PASSWORD
// is missing, logging in is turned off instead of falling back to a password anyone could guess.
const ON_HOST = !!process.env.RENDER || process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (ON_HOST ? '' : 'admin123');
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DAYS = { admin: 30, staff: 180 }; // the iPad board stays signed in for months
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const KEEP_DAYS = 30;
const MAX_STORED_ORDERS = 20000;   // hard cap so spam can never fill the disk
const MAX_OPEN_ORDERS = 120;       // new + making orders at once before we say "busy"
const MAX_TEXTS_PER_ORDER = 3;     // stops the Resend button running up a Twilio bill

// Twilio (optional). If not configured, texts are skipped and logged.
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TW_FROM = process.env.TWILIO_FROM_NUMBER || '';
const TW_MSG_SVC = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const TW_API = process.env.TWILIO_API_BASE || 'https://api.twilio.com';
const smsEnabled = () => !!(TW_SID && TW_TOKEN && (TW_FROM || TW_MSG_SVC));

// ---------- Storage ----------
function id(n = 8) { return crypto.randomBytes(n).toString('base64url'); }

function londonFog() {
  return { id: id(6), name: 'London Fog', description: 'Earl Grey tea, vanilla and steamed milk.', price: 4, soldOut: false,
    optionGroups: [{ id: id(4), name: 'Hot or Iced', multi: false, required: true, choices: [{ name: 'Hot', price: 0 }, { name: 'Iced', price: 0 }] }] };
}

// One-time updates applied to menus that already exist on disk.
const MIGRATIONS = {
  'add-london-fog': (st) => {
    const all = st.menu.flatMap(c => c.items);
    if (all.some(i => /london fog/i.test(i.name))) return;
    let tea = st.menu.find(c => /tea/i.test(c.name));
    if (!tea) { tea = { id: id(4), name: 'Tea', items: [] }; st.menu.push(tea); }
    tea.items.push(londonFog());
  },
  'matcha-mango-no-kiwi': (st) => {
    for (const it of st.menu.flatMap(c => c.items)) {
      if (!/matcha/i.test(it.name)) continue;
      const g = (it.optionGroups || []).find(x => /flavor/i.test(x.name));
      if (!g) continue;
      g.choices = g.choices.filter(ch => !/^kiwi$/i.test(ch.name));
      if (!g.choices.some(ch => /^mango$/i.test(ch.name))) g.choices.splice(1, 0, { name: 'Mango', price: 0 });
    }
  },
};
function migrate() {
  store.migrations = store.migrations || [];
  let changed = false;
  for (const [name, fn] of Object.entries(MIGRATIONS)) {
    if (store.migrations.includes(name)) continue;
    fn(store); store.migrations.push(name); changed = true;
  }
  if (changed) save();
}

function defaultStore() {
  const g = (name, choices, { multi = false, required = !multi } = {}) =>
    ({ id: id(4), name, multi, required: required && !multi, choices: choices.map(c => ({ name: c, price: 0 })) });
  const syrups = () => g('Add syrup', ['Vanilla', 'Caramel', 'Hazelnut', 'Brown Sugar', 'White Chocolate', 'Raspberry', 'Cherry', 'Banana'], { multi: true });
  const item = (name, description, price, groups = []) => ({ id: id(6), name, description, price, soldOut: false, optionGroups: groups });

  return {
    settings: {
      shopName: 'SFC Cafe',
      open: true,
      paused: false,
      closedMessage: 'We are closed right now. Come back soon!',
      readyMessage: 'Hi {first}! Your SFC Cafe order #{number} is ready for pickup. ☕',
      maxItems: 6,
    },
    menu: [
      { id: id(4), name: 'Coffee', items: [
        item('Americano', 'Espresso and hot water.', 4, [syrups()]),
        item('Flat White', 'Espresso with velvety steamed milk.', 4, [syrups()]),
        item('Latte', 'Espresso with steamed milk. Hot or iced.', 4, [g('Hot or Iced', ['Hot', 'Iced']), syrups()]),
        item('Cappuccino', 'Espresso, steamed milk and lots of foam.', 4, [syrups()]),
        item('Macchiato', 'Espresso marked with a little milk foam.', 4, [syrups()]),
        item('Mocha', 'Espresso, chocolate and steamed milk.', 4, [syrups()]),
        item('Espresso', 'A straight shot of espresso.', 4, [syrups()]),
      ]},
      { id: id(4), name: 'Italian Soda', items: [
        item('Italian Soda', 'Sparkling soda with your choice of flavor.', 4, [
          g('Flavor', ['Coconut', 'Green Apple', 'Kiwi', 'Peach', 'Guava', 'Blackberry', 'Blue Raspberry',
            'Mango', 'Pineapple', 'Lime', 'Watermelon', 'Strawberry', 'Raspberry'])]),
      ]},
      { id: id(4), name: 'Matcha', items: [
        item('Matcha', 'Matcha latte with your choice of flavor.', 5, [
          g('Flavor', ['Honey', 'Mango', 'Raspberry', 'Strawberry', 'Passion Fruit', 'Coconut', 'Blueberry', 'Pineapple']),
          g('Extras', ['Cold foam'], { multi: true })]),
      ]},
      { id: id(4), name: 'Tea', items: [
        item('Tea', 'Hot tea.', 0, [g('Type', ['Green', 'Black'])]),
        londonFog(),
      ]},
    ],
    orders: [],
    counter: { day: '', n: 0 },
  };
}

let store;
function load() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // Never silently wipe real data: keep a copy of an unreadable file before starting fresh.
    if (fs.existsSync(DATA_FILE)) {
      const bad = DATA_FILE + '.unreadable-' + Date.now();
      try { fs.copyFileSync(DATA_FILE, bad); console.error('store.json could not be read; saved a copy at', bad); } catch (e2) {}
    }
    store = defaultStore();
    store.migrations = Object.keys(MIGRATIONS);
    save();
  }
  migrate();
}
let saveTimer = null;
function save() {
  if (store.orders.length > MAX_STORED_ORDERS) store.orders = store.orders.slice(-MAX_STORED_ORDERS);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  store.orders = store.orders.filter(o => o.createdAt >= cutoff);
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ---------- Auth ----------
// Login cookie = role.issuedAt.signature. The signature also covers the current password,
// so changing ADMIN_PASSWORD or STAFF_PASSWORD on Render signs every device out.
function mac(role, issued) {
  const pw = role === 'admin' ? ADMIN_PASSWORD : STAFF_PASSWORD;
  return crypto.createHmac('sha256', SECRET).update(role + '.' + issued + '.' + pw).digest('base64url');
}
function sign(role) { const issued = Date.now().toString(36); return role + '.' + issued + '.' + mac(role, issued); }
function roleFromReq(req) {
  const m = /(?:^|;\s*)sfc_auth=([^;]{1,200})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [role, issued, sig] = m[1].split('.');
  if ((role !== 'admin' && role !== 'staff') || !issued || !sig) return null;
  const age = Date.now() - parseInt(issued, 36);
  if (!(age >= 0 && age < SESSION_DAYS[role] * 86400000)) return null;
  return safeEq(sig, mac(role, issued)) ? role : null;
}
function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Rate limiting (in memory, no extra services needed) ----------
// Everyone on the church Wi-Fi can share one IP address, so per-IP limits are generous
// and there are also overall limits that hold even if someone fakes their address.
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > windowMs) { b = { n: 0, t: now }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600000) buckets.delete(k); }, 600000).unref();
function clientIp(req) {
  return String(req.headers['true-client-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '?').trim().slice(0, 64);
}

// ---------- Live updates (Server-Sent Events) ----------
const clients = new Set();
const MAX_STREAMS = 40;
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (e) {} }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);

// ---------- SMS ----------
async function sendSms(order) {
  const body = (store.settings.readyMessage || '')
    .replace(/\{first\}/g, order.firstName)
    .replace(/\{last\}/g, order.lastName)
    .replace(/\{number\}/g, order.number)
    .replace(/\{shop\}/g, store.settings.shopName);
  if (!smsEnabled() || !order.phone) {
    order.sms = { status: 'skipped', note: order.phone ? 'Texting is not set up yet' : 'No phone number', at: Date.now() };
    console.log(`[sms skipped] to ${order.phone}: ${body}`);
    return;
  }
  const params = new URLSearchParams({ To: '+1' + order.phone, Body: body });
  if (TW_MSG_SVC) params.set('MessagingServiceSid', TW_MSG_SVC); else params.set('From', TW_FROM);
  try {
    const r = await fetch(`${TW_API}/2010-04-01/Accounts/${TW_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) order.sms = { status: 'sent', at: Date.now() };
    else order.sms = { status: 'failed', note: j.message || ('HTTP ' + r.status), at: Date.now() };
  } catch (e) {
    order.sms = { status: 'failed', note: e.message, at: Date.now() };
  }
  if (order.sms.status === 'failed') console.error('[sms failed]', order.sms.note);
}

// ---------- Helpers ----------
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
class UserError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
// Reads a JSON body with a size limit. Anything that is not a small JSON object is refused.
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new UserError('Bad request', 415));
    if (Number(req.headers['content-length']) > limit) return reject(new UserError('Request too large', 413));
    const chunks = []; let size = 0; let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('error', fail);
    req.on('aborted', () => fail(new UserError('Request aborted')));
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) { fail(new UserError('Request too large', 413)); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return; done = true;
      let v;
      try { v = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch (e) { return reject(new UserError('Bad request')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new UserError('Bad request'));
      resolve(v);
    });
  });
}
const cleanId = (s) => { const v = String(s ?? ''); return /^[\w-]{1,24}$/.test(v) ? v : ''; };
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const money = (n) => Math.round(Number(n) * 100) / 100;

function publicMenu() {
  return store.menu.map(cat => ({
    id: cat.id, name: cat.name,
    items: cat.items.filter(i => !i.hidden),
  })).filter(c => c.items.length);
}
function activeOrders() {
  return store.orders.filter(o => ['new', 'making', 'ready'].includes(o.status));
}
function aheadOf(order) {
  return store.orders.filter(o => (o.status === 'new' || o.status === 'making') && o.createdAt < order.createdAt).length;
}

function buildOrder(body) {
  const s = store.settings;
  if (!s.open) throw new Error(s.closedMessage || 'We are closed right now.');
  if (s.paused) throw new Error('We are very busy and have paused new orders for a few minutes. Please try again shortly!');
  const firstName = clean(body.firstName, 40);
  const lastName = clean(body.lastName, 40);
  let phone = String(body.phone || '').replace(/\D/g, '');
  if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
  if (!firstName || !lastName) throw new Error('Please enter your first and last name.');
  if (smsEnabled() && !/^[2-9]\d{2}[2-9]\d{6}$/.test(phone)) throw new Error('Please enter a valid 10-digit phone number.');
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(phone)) phone = '';
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new Error('Your cart is empty.');
  if (lines.length > 20) throw new Error('That order is too big. Please split it up.');
  const itemsById = new Map();
  store.menu.forEach(c => c.items.forEach(i => itemsById.set(i.id, i)));
  let count = 0;
  const items = lines.map(l => {
    if (!l || typeof l !== 'object') throw new Error('Bad request');
    const it = itemsById.get(String(l.itemId));
    if (!it || it.hidden) throw new Error('One of the items is no longer on the menu. Please refresh.');
    if (it.soldOut) throw new Error(`Sorry, ${it.name} just sold out.`);
    const qty = Math.max(1, Math.min(10, parseInt(l.qty, 10) || 1));
    count += qty;
    const chosen = l.options && typeof l.options === 'object' ? l.options : {};
    const options = [];
    let unit = Number(it.price) || 0;
    for (const g of it.optionGroups || []) {
      let picks = Object.prototype.hasOwnProperty.call(chosen, g.id) ? chosen[g.id] : null;
      picks = Array.isArray(picks) ? picks.slice(0, 50) : (picks != null ? [picks] : []);
      picks = picks.filter(p => g.choices.some(ch => ch.name === p));
      if (!g.multi) picks = picks.slice(0, 1);
      if (g.required && !picks.length) throw new Error(`Please choose ${g.name} for ${it.name}.`);
      for (const p of picks) {
        const ch = g.choices.find(x => x.name === p);
        unit += Number(ch.price) || 0;
        options.push({ group: g.name, choice: ch.name });
      }
    }
    return { itemId: it.id, name: it.name, qty, unitPrice: money(unit), options, note: clean(l.note, 140) };
  });
  const max = Number(s.maxItems) || 6;
  if (count > max) throw new Error(`Orders are limited to ${max} drinks. Please place a second order for more.`);
  const day = today();
  if (store.counter.day !== day) store.counter = { day, n: 0 };
  store.counter.n += 1;
  return {
    id: id(9), number: store.counter.n, day, createdAt: Date.now(),
    firstName, lastName, phone, items, note: clean(body.note, 200),
    total: money(items.reduce((a, i) => a + i.unitPrice * i.qty, 0)),
    status: 'new', history: [{ status: 'new', at: Date.now() }], sms: null,
  };
}

function validateMenu(menu) {
  if (!Array.isArray(menu) || menu.length > 30) throw new UserError('Bad menu');
  const arr = (a, max) => (Array.isArray(a) ? a : []).filter(x => x && typeof x === 'object').slice(0, max);
  return arr(menu, 30).map(cat => ({
    id: cleanId(cat.id) || id(4),
    name: clean(cat.name, 40) || 'Untitled',
    items: arr(cat.items, 100).map(it => ({
      id: cleanId(it.id) || id(6),
      name: clean(it.name, 60) || 'Untitled item',
      description: clean(it.description, 200),
      price: money(Math.min(1000, Math.max(0, Number(it.price) || 0))),
      soldOut: !!it.soldOut,
      hidden: !!it.hidden,
      image: typeof it.image === 'string' && it.image.length <= 400000 &&
        /^(https:\/\/[^\s"'<>]+|data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+)$/.test(it.image) ? it.image : '',
      optionGroups: arr(it.optionGroups, 10).map(g => ({
        id: cleanId(g.id) || id(4),
        name: clean(g.name, 40) || 'Option',
        multi: !!g.multi,
        required: !!g.required && !g.multi,
        choices: arr(g.choices, 40).map(ch => ({
          name: clean(ch.name, 40), price: money(Math.min(100, Math.max(-100, Number(ch.price) || 0))),
        })).filter(ch => ch.name),
      })).filter(g => g.choices.length),
    })),
  }));
}

function summary(day) {
  const list = store.orders.filter(o => o.day === day && o.status !== 'cancelled');
  const byItem = {};
  let drinks = 0;
  for (const o of list) for (const i of o.items) { byItem[i.name] = (byItem[i.name] || 0) + i.qty; drinks += i.qty; }
  const waits = list.filter(o => o.readyAt).map(o => (o.readyAt - o.createdAt) / 60000);
  return {
    day, orders: list.length, drinks,
    total: money(list.reduce((a, o) => a + o.total, 0)),
    avgWaitMin: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    cancelled: store.orders.filter(o => o.day === day && o.status === 'cancelled').length,
    popular: Object.entries(byItem).sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty })),
    days: [...new Set(store.orders.map(o => o.day))].sort().reverse(),
  };
}

// ---------- Security headers ----------
// Inline <script> blocks are allowed by their exact hash, so injected scripts cannot run.
function scriptHashes(html) {
  const out = [];
  html.replace(/<script>([\s\S]*?)<\/script>/g, (_, js) => { out.push(`'sha256-${crypto.createHash('sha256').update(js).digest('base64')}'`); });
  return out;
}
function baseHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (req.headers['x-forwarded-proto'] === 'https') h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}
function htmlCsp(hashes) {
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:", "connect-src 'self'", "font-src 'self'", "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

// ---------- Static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const PAGES = { '/': 'order.html', '/order': 'order.html', '/status': 'status.html', '/board': 'board.html',
  '/admin': 'admin.html', '/sign': 'sign.html', '/login': 'login.html' };

// Files are read once at startup: no disk reads per request, and only files in public/ are ever served.
const FILES = new Map();
for (const f of fs.readdirSync(PUBLIC_DIR)) {
  const ext = path.extname(f);
  if (!MIME[ext] || f.startsWith('.')) continue;
  const buf = fs.readFileSync(path.join(PUBLIC_DIR, f));
  FILES.set(f, { buf, type: MIME[ext], csp: ext === '.html' ? htmlCsp(scriptHashes(buf.toString('utf8'))) : null });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, baseHeaders(req)); return res.end(); }
  const f = FILES.get(PAGES[pathname] || pathname.slice(1));
  if (!f) { res.writeHead(404, { ...baseHeaders(req), 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const h = { ...baseHeaders(req), 'Content-Type': f.type, 'Cache-Control': f.csp ? 'no-cache' : 'public, max-age=300' };
  if (f.csp) h['Content-Security-Policy'] = f.csp;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : f.buf);
}

// ---------- Router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // "/board.html" is the same page as "/board", so it gets the same login check.
  const p = url.pathname.replace(/\.html$/, '') || '/';
  const role = roleFromReq(req);
  const isStaff = role === 'staff' || role === 'admin';
  const isAdmin = role === 'admin';
  const ip = clientIp(req);
  const J = baseHeaders(req);
  J['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'";
  const reply = (code, obj, extra = {}) => send(res, code, obj, { ...J, ...extra });

  // Protected pages redirect to login
  if ((p === '/board' && !isStaff) || ((p === '/admin' || p === '/sign') && !isAdmin)) {
    res.writeHead(302, { ...baseHeaders(req), Location: '/login?next=' + encodeURIComponent(p) });
    return res.end();
  }
  if (!p.startsWith('/api/')) return serveStatic(req, res, PAGES[p] ? p : url.pathname);

  try {
    if (limited('api:' + ip, 1200, 60000)) return reply(429, { error: 'Too many requests. Please wait a minute.' });
    // Changes must come from our own pages, not from another website.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let host = '';
        try { host = new URL(origin).host; } catch (e) {}
        if (host !== req.headers.host) return reply(403, { error: 'Bad origin' });
      }
    }

    // ---- Public ----
    if (p === '/api/health') return reply(200, { ok: true });
    if (p === '/api/menu' && req.method === 'GET') {
      const s = store.settings;
      return reply(200, { shopName: s.shopName, open: s.open, paused: s.paused, closedMessage: s.closedMessage,
        maxItems: s.maxItems, sms: smsEnabled(), menu: publicMenu(), waiting: store.orders.filter(o => o.status === 'new' || o.status === 'making').length });
    }
    if (p === '/api/orders' && req.method === 'POST') {
      if (limited('order:' + ip, 30, 10 * 60000) || limited('order:all', 40, 60000))
        return reply(429, { error: 'Lots of orders are coming in. Please wait a minute and try again.' });
      const body = await readBody(req);
      if (body.website) return reply(400, { error: 'Bad request' }); // honeypot
      if (store.orders.filter(o => o.status === 'new' || o.status === 'making').length >= MAX_OPEN_ORDERS)
        return reply(503, { error: 'We are very busy right now. Please try again in a few minutes.' });
      const order = buildOrder(body);
      store.orders.push(order);
      prune(); save();
      broadcast('order', order);
      return reply(200, { id: order.id, number: order.number });
    }
    let m;
    if ((m = /^\/api\/orders\/([\w-]{1,24})\/public$/.exec(p)) && req.method === 'GET') {
      const o = store.orders.find(x => x.id === m[1]);
      if (!o) return reply(404, { error: 'Order not found' });
      return reply(200, { number: o.number, firstName: o.firstName, status: o.status, items: o.items,
        total: o.total, note: o.note, ahead: aheadOf(o), createdAt: o.createdAt, shopName: store.settings.shopName, sms: smsEnabled() });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const tooMany = { error: 'Too many tries. Wait 10 minutes.' };
      const failKey = 'loginfail:' + ip;
      if ((buckets.get(failKey)?.n || 0) >= 10 && Date.now() - buckets.get(failKey).t < 10 * 60000) return reply(429, tooMany);
      if ((buckets.get('loginfail:all')?.n || 0) >= 60 && Date.now() - buckets.get('loginfail:all').t < 10 * 60000) return reply(429, tooMany);
      const { password } = await readBody(req, 1024);
      let r = null;
      if (ADMIN_PASSWORD && typeof password === 'string' && password) {
        if (safeEq(password, ADMIN_PASSWORD)) r = 'admin';
        else if (safeEq(password, STAFF_PASSWORD)) r = 'staff';
      }
      if (!r) {
        limited(failKey, Infinity, 10 * 60000); limited('loginfail:all', Infinity, 10 * 60000);
        return reply(401, { error: ADMIN_PASSWORD ? 'Wrong password' : 'Login is turned off until ADMIN_PASSWORD is set on the server.' });
      }
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      return reply(200, { role: r }, { 'Set-Cookie': `sfc_auth=${sign(r)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS[r] * 86400}${secure}` });
    }
    if (p === '/api/logout') return reply(200, { ok: true }, { 'Set-Cookie': 'sfc_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    if (p === '/api/me') return reply(200, { role, sms: smsEnabled() });

    // ---- Staff ----
    if (!isStaff) return reply(401, { error: 'Please log in' });

    if (p === '/api/stream') {
      if (clients.size >= MAX_STREAMS) return reply(503, { error: 'Too many open boards' });
      res.writeHead(200, { ...J, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      res.on('error', () => clients.delete(res));
      return;
    }
    if (p === '/api/board' && req.method === 'GET') {
      const s = store.settings;
      return reply(200, { orders: activeOrders(), settings: { open: s.open, paused: s.paused, shopName: s.shopName }, sms: smsEnabled() });
    }
    if ((m = /^\/api\/orders\/([\w-]{1,24})\/status$/.exec(p)) && req.method === 'POST') {
      const o = store.orders.find(x => x.id === m[1]);
      if (!o) return reply(404, { error: 'Order not found' });
      const { status, resend } = await readBody(req);
      const textsSent = () => (o.texts = (o.texts || 0) + 1) > MAX_TEXTS_PER_ORDER;
      if (resend) {
        if (textsSent()) return reply(429, { error: 'This order has already been texted several times.' });
        await sendSms(o); save(); broadcast('update', o); return reply(200, o);
      }
      if (!['new', 'making', 'ready', 'done', 'cancelled'].includes(status)) return reply(400, { error: 'Bad status' });
      const prev = o.status;
      o.status = status;
      o.history.push({ status, at: Date.now() });
      if (o.history.length > 50) o.history = o.history.slice(-50);
      if (status === 'ready' && prev !== 'ready') { o.readyAt = Date.now(); if (!textsSent()) await sendSms(o); }
      save(); broadcast('update', o);
      return reply(200, o);
    }
    if (p === '/api/history' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 60);
      const day = (url.searchParams.get('day') || today()).slice(0, 10);
      const qDigits = q.replace(/\D/g, '');
      let list = q
        ? store.orders.filter(o => (o.firstName + ' ' + o.lastName).toLowerCase().includes(q) || (qDigits.length >= 3 && String(o.phone || '').includes(qDigits)) || String(o.number) === q.replace('#', ''))
        : store.orders.filter(o => o.day === day);
      list = list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
      return reply(200, { day, q, orders: list, days: [...new Set(store.orders.map(o => o.day))].sort().reverse() });
    }
    if (p === '/api/settings/quick' && req.method === 'POST') {
      const b = await readBody(req);
      if ('open' in b) store.settings.open = !!b.open;
      if ('paused' in b) store.settings.paused = !!b.paused;
      save(); broadcast('settings', store.settings);
      return reply(200, store.settings);
    }
    if (p === '/api/soldout' && req.method === 'POST') {
      const { itemId, soldOut } = await readBody(req);
      store.menu.forEach(c => c.items.forEach(i => { if (i.id === itemId) i.soldOut = !!soldOut; }));
      save(); return reply(200, { ok: true });
    }
    if (p === '/api/admin/menu' && req.method === 'GET') return reply(200, { menu: store.menu, settings: store.settings, sms: smsEnabled(), isAdmin });

    // ---- Admin ----
    if (!isAdmin) return reply(403, { error: 'Admin only' });

    if (p === '/api/admin/menu' && req.method === 'PUT') {
      const b = await readBody(req, 3 * 1024 * 1024); // room for a few item photos
      store.menu = validateMenu(b.menu);
      save(); broadcast('menu', {});
      return reply(200, { menu: store.menu });
    }
    if (p === '/api/admin/settings' && req.method === 'PUT') {
      const b = await readBody(req);
      const s = store.settings;
      if ('shopName' in b) s.shopName = clean(b.shopName, 60) || 'SFC Cafe';
      if ('closedMessage' in b) s.closedMessage = clean(b.closedMessage, 200);
      if ('readyMessage' in b) s.readyMessage = clean(b.readyMessage, 300) || s.readyMessage;
      if ('maxItems' in b) s.maxItems = Math.max(1, Math.min(50, parseInt(b.maxItems, 10) || 6));
      if ('open' in b) s.open = !!b.open;
      if ('paused' in b) s.paused = !!b.paused;
      save(); broadcast('settings', s);
      return reply(200, s);
    }
    if (p === '/api/admin/summary') return reply(200, summary((url.searchParams.get('day') || today()).slice(0, 10)));
    if (p === '/api/admin/reset-menu' && req.method === 'POST') {
      store.menu = defaultStore().menu; save(); broadcast('menu', {});
      return reply(200, { menu: store.menu });
    }
    if (p === '/api/admin/test-sms' && req.method === 'POST') {
      if (limited('testsms', 10, 3600000)) return reply(429, { error: 'Too many test texts. Try again later.' });
      const { phone } = await readBody(req);
      const fake = { firstName: 'Test', lastName: 'Text', number: 0, phone: String(phone || '').replace(/\D/g, '').slice(-10) };
      await sendSms(fake);
      return reply(200, fake.sms);
    }
    return reply(404, { error: 'Not found' });
  } catch (e) {
    // Messages we wrote are shown to the user; anything unexpected gets a generic reply.
    if (e instanceof UserError) return reply(e.code, { error: e.message });
    if (e && e.constructor === Error && !e.code) return reply(400, { error: e.message || 'Something went wrong' });
    console.error('[request error]', req.method, url.pathname, e);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
}

// Keep running if something unexpected slips through; it is logged on Render.
process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

load();
if (!store || !Array.isArray(store.orders) || !Array.isArray(store.menu) || !store.settings) { console.error('store.json looked wrong, starting fresh'); store = { ...defaultStore(), ...(store || {}) }; }
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); else res.end(); });
});
server.requestTimeout = 30000;   // slow or stuck uploads are dropped
server.headersTimeout = 15000;
server.maxHeadersCount = 60;
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else socket.destroy(); });
server.listen(PORT, () => {
  console.log(`SFC Cafe running on http://localhost:${PORT}`);
  console.log(`Texting: ${smsEnabled() ? 'ON (Twilio)' : 'OFF (set TWILIO_* env vars to turn on)'}`);
  if (!process.env.ADMIN_PASSWORD) console.log(ON_HOST ? 'WARNING: ADMIN_PASSWORD is not set, so logging in is turned off.' : 'Local mode: admin password is "admin123". Set ADMIN_PASSWORD on your host.');
  if (STAFF_PASSWORD === ADMIN_PASSWORD) console.log('Tip: set a different STAFF_PASSWORD so iPad volunteers cannot open the admin page.');
});
