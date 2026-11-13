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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('sfc:' + ADMIN_PASSWORD + ':' + STAFF_PASSWORD).digest('hex');
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const KEEP_DAYS = 30;

// Twilio (optional). If not configured, texts are skipped and logged.
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TW_FROM = process.env.TWILIO_FROM_NUMBER || '';
const TW_MSG_SVC = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const TW_API = process.env.TWILIO_API_BASE || 'https://api.twilio.com';
const smsEnabled = () => !!(TW_SID && TW_TOKEN && (TW_FROM || TW_MSG_SVC));

// ---------- Storage ----------
function id(n = 8) { return crypto.randomBytes(n).toString('base64url'); }

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
          g('Flavor', ['Honey', 'Kiwi', 'Raspberry', 'Strawberry', 'Passion Fruit', 'Coconut', 'Blueberry', 'Pineapple']),
          g('Extras', ['Cold foam'], { multi: true })]),
      ]},
      { id: id(4), name: 'Tea', items: [
        item('Tea', 'Hot tea.', 0, [g('Type', ['Green', 'Black'])]),
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
    store = defaultStore();
    save();
  }
}
let saveTimer = null;
function save() {
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
function sign(role) { return role + '.' + crypto.createHmac('sha256', SECRET).update(role).digest('base64url'); }
function roleFromReq(req) {
  const m = /(?:^|;\s*)sfc_auth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const val = decodeURIComponent(m[1]);
  const role = val.split('.')[0];
  if ((role === 'admin' || role === 'staff') && safeEq(val, sign(role))) return role;
  return null;
}
function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const loginAttempts = new Map();

// ---------- Live updates (Server-Sent Events) ----------
const clients = new Set();
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
  if (!smsEnabled()) {
    order.sms = { status: 'skipped', note: 'Texting is not set up yet', at: Date.now() };
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}
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
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(phone)) throw new Error('Please enter a valid 10-digit phone number.');
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new Error('Your cart is empty.');
  const itemsById = new Map();
  store.menu.forEach(c => c.items.forEach(i => itemsById.set(i.id, i)));
  let count = 0;
  const items = lines.map(l => {
    const it = itemsById.get(l.itemId);
    if (!it || it.hidden) throw new Error('One of the items is no longer on the menu. Please refresh.');
    if (it.soldOut) throw new Error(`Sorry, ${it.name} just sold out.`);
    const qty = Math.max(1, Math.min(10, parseInt(l.qty, 10) || 1));
    count += qty;
    const chosen = l.options || {};
    const options = [];
    let unit = Number(it.price) || 0;
    for (const g of it.optionGroups || []) {
      let picks = chosen[g.id];
      picks = Array.isArray(picks) ? picks : (picks != null ? [picks] : []);
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
  if (!Array.isArray(menu)) throw new Error('Bad menu');
  return menu.map(cat => ({
    id: clean(cat.id, 20) || id(4),
    name: clean(cat.name, 40) || 'Untitled',
    items: (Array.isArray(cat.items) ? cat.items : []).map(it => ({
      id: clean(it.id, 20) || id(6),
      name: clean(it.name, 60) || 'Untitled item',
      description: clean(it.description, 200),
      price: money(Math.max(0, Number(it.price) || 0)),
      soldOut: !!it.soldOut,
      hidden: !!it.hidden,
      image: typeof it.image === 'string' && /^(https:\/\/|data:image\/)/.test(it.image) ? it.image.slice(0, 400000) : '',
      optionGroups: (Array.isArray(it.optionGroups) ? it.optionGroups : []).map(g => ({
        id: clean(g.id, 20) || id(4),
        name: clean(g.name, 40) || 'Option',
        multi: !!g.multi,
        required: !!g.required && !g.multi,
        choices: (Array.isArray(g.choices) ? g.choices : []).map(ch => ({
          name: clean(ch.name, 40), price: money(Number(ch.price) || 0),
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

// ---------- Static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const PAGES = { '/': 'order.html', '/order': 'order.html', '/status': 'status.html', '/board': 'board.html',
  '/admin': 'admin.html', '/sign': 'sign.html', '/login': 'login.html' };

function serveStatic(req, res, pathname) {
  let file = PAGES[pathname] || pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': full.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
    res.end(buf);
  });
}

// ---------- Router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const role = roleFromReq(req);
  const isStaff = role === 'staff' || role === 'admin';
  const isAdmin = role === 'admin';

  // Protected pages redirect to login
  if ((p === '/board' && !isStaff) || ((p === '/admin' || p === '/sign') && !isAdmin)) {
    res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(p) });
    return res.end();
  }
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    // ---- Public ----
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/menu' && req.method === 'GET') {
      const s = store.settings;
      return send(res, 200, { shopName: s.shopName, open: s.open, paused: s.paused, closedMessage: s.closedMessage,
        maxItems: s.maxItems, menu: publicMenu(), waiting: store.orders.filter(o => o.status === 'new' || o.status === 'making').length });
    }
    if (p === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.website) return send(res, 400, { error: 'Bad request' }); // honeypot
      const order = buildOrder(body);
      store.orders.push(order);
      prune(); save();
      broadcast('order', order);
      return send(res, 200, { id: order.id, number: order.number });
    }
    let m;
    if ((m = /^\/api\/orders\/([\w-]+)\/public$/.exec(p)) && req.method === 'GET') {
      const o = store.orders.find(x => x.id === m[1]);
      if (!o) return send(res, 404, { error: 'Order not found' });
      return send(res, 200, { number: o.number, firstName: o.firstName, status: o.status, items: o.items,
        total: o.total, note: o.note, ahead: aheadOf(o), createdAt: o.createdAt, shopName: store.settings.shopName, sms: smsEnabled() });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
      const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - a.t > 10 * 60000) { a.n = 0; a.t = Date.now(); }
      if (a.n >= 10) return send(res, 429, { error: 'Too many tries. Wait 10 minutes.' });
      const { password } = await readBody(req);
      let r = null;
      if (password && safeEq(String(password), ADMIN_PASSWORD)) r = 'admin';
      else if (password && safeEq(String(password), STAFF_PASSWORD)) r = 'staff';
      if (!r) { a.n++; loginAttempts.set(ip, a); return send(res, 401, { error: 'Wrong password' }); }
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      return send(res, 200, { role: r }, { 'Set-Cookie': `sfc_auth=${encodeURIComponent(sign(r))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sfc_auth=; Path=/; Max-Age=0' });
    if (p === '/api/me') return send(res, 200, { role, sms: smsEnabled() });

    // ---- Staff ----
    if (!isStaff) return send(res, 401, { error: 'Please log in' });

    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/board' && req.method === 'GET') {
      const s = store.settings;
      return send(res, 200, { orders: activeOrders(), settings: { open: s.open, paused: s.paused, shopName: s.shopName }, sms: smsEnabled() });
    }
    if ((m = /^\/api\/orders\/([\w-]+)\/status$/.exec(p)) && req.method === 'POST') {
      const o = store.orders.find(x => x.id === m[1]);
      if (!o) return send(res, 404, { error: 'Order not found' });
      const { status, resend } = await readBody(req);
      if (resend) { await sendSms(o); save(); broadcast('update', o); return send(res, 200, o); }
      if (!['new', 'making', 'ready', 'done', 'cancelled'].includes(status)) return send(res, 400, { error: 'Bad status' });
      const prev = o.status;
      o.status = status;
      o.history.push({ status, at: Date.now() });
      if (status === 'ready' && prev !== 'ready') { o.readyAt = Date.now(); await sendSms(o); }
      save(); broadcast('update', o);
      return send(res, 200, o);
    }
    if (p === '/api/settings/quick' && req.method === 'POST') {
      const b = await readBody(req);
      if ('open' in b) store.settings.open = !!b.open;
      if ('paused' in b) store.settings.paused = !!b.paused;
      save(); broadcast('settings', store.settings);
      return send(res, 200, store.settings);
    }
    if (p === '/api/soldout' && req.method === 'POST') {
      const { itemId, soldOut } = await readBody(req);
      store.menu.forEach(c => c.items.forEach(i => { if (i.id === itemId) i.soldOut = !!soldOut; }));
      save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/menu' && req.method === 'GET') return send(res, 200, { menu: store.menu, settings: store.settings, sms: smsEnabled(), isAdmin });

    // ---- Admin ----
    if (!isAdmin) return send(res, 403, { error: 'Admin only' });

    if (p === '/api/admin/menu' && req.method === 'PUT') {
      const b = await readBody(req);
      store.menu = validateMenu(b.menu);
      save(); broadcast('menu', {});
      return send(res, 200, { menu: store.menu });
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
      return send(res, 200, s);
    }
    if (p === '/api/admin/summary') return send(res, 200, summary(url.searchParams.get('day') || today()));
    if (p === '/api/admin/reset-menu' && req.method === 'POST') {
      store.menu = defaultStore().menu; save(); broadcast('menu', {});
      return send(res, 200, { menu: store.menu });
    }
    if (p === '/api/admin/test-sms' && req.method === 'POST') {
      const { phone } = await readBody(req);
      const fake = { firstName: 'Test', lastName: 'Text', number: 0, phone: String(phone || '').replace(/\D/g, '').slice(-10) };
      await sendSms(fake);
      return send(res, 200, fake.sms);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 400, { error: e.message || 'Something went wrong' });
  }
}

load();
http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
}).listen(PORT, () => {
  console.log(`SFC Cafe running on http://localhost:${PORT}`);
  console.log(`Texting: ${smsEnabled() ? 'ON (Twilio)' : 'OFF (set TWILIO_* env vars to turn on)'}`);
  if (!process.env.ADMIN_PASSWORD) console.log('WARNING: using default admin password "admin123". Set ADMIN_PASSWORD.');
});
