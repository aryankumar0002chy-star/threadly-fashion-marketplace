import { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
export class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
export const TRANSITIONS = { PLACED: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['PROCESSING', 'PACKED', 'CANCELLED'], PROCESSING: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'], SHIPPED: ['OUT_FOR_DELIVERY'], OUT_FOR_DELIVERY: ['DELIVERED'], DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURN_APPROVED', 'DELIVERED'], RETURN_APPROVED: ['RETURN_PICKUP'], RETURN_PICKUP: ['RETURNED'],
  RETURNED: ['REFUND_INITIATED'], REFUND_INITIATED: ['REFUNDED'], REFUNDED: [], CANCELLED: [] };
export const SCHEMA2 = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK(role IN('CUSTOMER','ADMIN','SUPPORT','SUPPLIER')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS user_sessions(token_hash TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), expires_at INT NOT NULL);
CREATE TABLE IF NOT EXISTS wishlist_items(user_id INT REFERENCES users(id), product_id INT REFERENCES products(id), PRIMARY KEY(user_id, product_id));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, order_no TEXT, provider TEXT, amount INT, status TEXT, event_id TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS shipments(order_no TEXT PRIMARY KEY, courier TEXT, awb TEXT, demo INT, status TEXT);
CREATE TABLE IF NOT EXISTS tracking_events(id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, source TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY, order_no TEXT, user_id INT, reason TEXT, description TEXT, status TEXT DEFAULT 'REQUESTED');
CREATE TABLE IF NOT EXISTS refunds(id INTEGER PRIMARY KEY, order_no TEXT, method TEXT, amount INT, status TEXT, provider TEXT);`;

const sha = (s) => createHash('sha256').update(s).digest('hex');
export function createUser(db, { email, name = '', password, role = 'CUSTOMER' }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '') || (password || '').length < 8) throw new HttpError(400, 'Valid email and a password of 8+ characters required');
  const salt = randomBytes(16).toString('hex');
  try { return db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run(email.toLowerCase(), name, `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, role).lastInsertRowid; }
  catch { throw new HttpError(409, 'Email already registered'); }
}
const startSession = (db, res, id) => {
  const t = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO user_sessions VALUES(?,?,?)').run(sha(t), id, Date.now() + 7 * 864e5);
  res.setHeader('set-cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
};
export function currentUser(db, req) {
  const t = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  return t ? db.prepare('SELECT u.id,u.email,u.name,u.role FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(sha(t), Date.now()) : undefined;
}
const hits = new Map();
const limited = (ip) => { const n = Date.now(), a = (hits.get(ip) || []).filter((t) => n - t < 6e4); a.push(n); hits.set(ip, a); return a.length > 20; };

// Shipping adapter: DEMO only. Real courier adapters (Shiprocket/Delhivery) implement the same createShipment().
const demoShipping = { createShipment: (o) => ({ courier: 'DEMO-COURIER', awb: `DEMO-${o.order_no}`, demo: true }) };

export async function extraRoutes({ db, req, p, m, body, res, user, isAdmin, demo }) {
  const need = () => user || (() => { throw new HttpError(401, 'Login required'); })();
  const order = (no) => db.prepare('SELECT * FROM orders WHERE order_no=?').get(no) ?? (() => { throw new HttpError(404, 'Not found'); })();
  const move = (o, to) => {
    if (!TRANSITIONS[o.status]?.includes(to)) throw new HttpError(409, `Invalid transition ${o.status} -> ${to}`);
    db.prepare('UPDATE orders SET status=? WHERE order_no=?').run(to, o.order_no);
  };
  let r;
  if (p.startsWith('/api/auth/') && m === 'POST' && limited(req.socket.remoteAddress)) throw new HttpError(429, 'Too many attempts. Try again shortly.');
  if (m === 'POST' && p === '/api/auth/register') { const id = createUser(db, body); startSession(db, res, id); return { id, email: body.email }; }
  if (m === 'POST' && p === '/api/auth/login') {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email || '').toLowerCase());
    const [salt, h] = (u?.password_hash || ':').split(':'), ok = u && timingSafeEqual(scryptSync(String(body.password || ''), salt, 64), Buffer.from(h, 'hex'));
    if (!ok) throw new HttpError(401, 'Incorrect email or password');
    startSession(db, res, u.id); return { id: u.id, role: u.role };
  }
  if (m === 'POST' && p === '/api/auth/logout') {
    const t = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    if (t) db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(sha(t));
    res.setHeader('set-cookie', 'sid=; Max-Age=0; Path=/'); return { ok: true };
  }
  if (m === 'GET' && p === '/api/me') return need();
  if (m === 'GET' && p === '/api/orders') return db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(need().id);
  if (p === '/api/wishlist') {
    const u = need();
    if (m === 'GET') return db.prepare('SELECT p.* FROM wishlist_items w JOIN products p ON p.id=w.product_id WHERE w.user_id=?').all(u.id);
    if (m === 'POST') { db.prepare('INSERT OR IGNORE INTO wishlist_items VALUES(?,?)').run(u.id, Number(body.productId)); return { ok: true }; }
  }
  if (m === 'DELETE' && (r = p.match(/^\/api\/wishlist\/(\d+)$/))) { db.prepare('DELETE FROM wishlist_items WHERE user_id=? AND product_id=?').run(need().id, Number(r[1])); return { ok: true }; }

  // Payments: DEMO adapter only unless a real provider is configured (not implemented here).
  if (m === 'POST' && p === '/api/payments/create') {
    const o = order(body.orderNo);
    if (o.payment_method !== 'ONLINE' || o.payment_status !== 'PAYMENT_PENDING') throw new HttpError(409, 'Order is not awaiting online payment');
    if (!demo) throw new HttpError(501, 'Online payment gateway not configured');
    db.prepare('INSERT INTO payments(order_no,provider,amount,status) VALUES(?,?,?,?)').run(o.order_no, 'DEMO', o.grand_total, 'PENDING');
    return { provider: 'DEMO', demo: true, amount: o.grand_total, note: 'DEMO/SANDBOX payment: no real money moves' };
  }
  if (m === 'POST' && p === '/api/payments/demo/confirm') {
    if (!demo) throw new HttpError(404, 'Not found');
    const o = order(body.orderNo);
    if (!db.prepare("SELECT 1 FROM payments WHERE order_no=? AND provider='DEMO' AND status='PENDING'").get(o.order_no)) throw new HttpError(409, 'No pending demo payment');
    db.prepare("UPDATE payments SET status='PAID' WHERE order_no=?").run(o.order_no);
    db.prepare("UPDATE orders SET payment_status='PAID' WHERE order_no=?").run(o.order_no); move(o, 'CONFIRMED');
    return { status: 'PAID', demo: true };
  }
  if (m === 'POST' && p === '/api/payments/webhook') {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET; if (!secret) throw new HttpError(501, 'Webhook secret not configured');
    const want = createHmac('sha256', secret).update(req.rawBody || '').digest(), got = Buffer.from(String(req.headers['x-signature'] || ''), 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Bad signature');
    const o = order(body.orderNo), paid = body.status === 'paid';
    if (db.prepare('INSERT OR IGNORE INTO payments(order_no,provider,amount,status,event_id) VALUES(?,?,?,?,?)').run(o.order_no, 'WEBHOOK', o.grand_total, paid ? 'PAID' : 'FAILED', String(body.eventId)).changes === 0) return { duplicate: true };
    if (paid && o.payment_status === 'PAYMENT_PENDING') { db.prepare("UPDATE orders SET payment_status='PAID' WHERE order_no=?").run(o.order_no); move(o, 'CONFIRMED'); }
    if (!paid) db.prepare("UPDATE orders SET payment_status='FAILED' WHERE order_no=?").run(o.order_no);
    return { ok: true };
  }
  if (m === 'GET' && (r = p.match(/^\/api\/orders\/([\w-]+)\/tracking$/))) {
    const o = order(r[1]); const s = db.prepare('SELECT * FROM shipments WHERE order_no=?').get(o.order_no);
    return { orderStatus: o.status, shipment: s ?? null, events: db.prepare('SELECT status,source,at FROM tracking_events WHERE order_no=? ORDER BY id').all(o.order_no) };
  }
  if (m === 'POST' && (r = p.match(/^\/api\/orders\/([\w-]+)\/return$/))) {
    const o = order(r[1]), u = need();
    if (o.user_id !== u.id) throw new HttpError(403, 'Forbidden');
    if (!body.reason) throw new HttpError(400, 'Reason required');
    move(o, 'RETURN_REQUESTED');
    return { id: db.prepare('INSERT INTO returns(order_no,user_id,reason,description) VALUES(?,?,?,?)').run(o.order_no, u.id, String(body.reason), String(body.description || '')).lastInsertRowid };
  }
  if (!isAdmin) return undefined;
  if (m === 'GET' && p === '/api/admin/orders') return db.prepare('SELECT o.*, u.email, (SELECT id FROM returns r WHERE r.order_no=o.order_no ORDER BY id DESC LIMIT 1) AS return_id, (SELECT demo FROM shipments s WHERE s.order_no=o.order_no) AS ship_demo FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.rowid DESC LIMIT 200').all();
  if (m === 'POST' && (r = p.match(/^\/api\/admin\/orders\/([\w-]+)\/status$/))) {
    const o = order(r[1]), to = body.status;
    if (to === 'SHIPPED' || to === 'REFUND_INITIATED') throw new HttpError(400, 'Use the dedicated ship/refund endpoint');
    move(o, to);
    if (to === 'CANCELLED') for (const i of db.prepare('SELECT * FROM order_items WHERE order_no=?').all(o.order_no)) db.prepare('UPDATE variants SET reserved=reserved-? WHERE id=?').run(i.qty, i.variant_id);
    if (to === 'DELIVERED' && o.payment_method === 'COD') db.prepare("UPDATE orders SET payment_status='COD_COLLECTED' WHERE order_no=?").run(o.order_no);
    if (['OUT_FOR_DELIVERY', 'DELIVERED'].includes(to)) db.prepare("INSERT INTO tracking_events(order_no,status,source) VALUES(?,?,'DEMO')").run(o.order_no, to);
    return { status: to };
  }
  if (m === 'POST' && (r = p.match(/^\/api\/admin\/orders\/([\w-]+)\/ship$/))) {
    const o = order(r[1]);
    if (!demo) throw new HttpError(501, 'Shipping integration not configured');
    move(o, 'SHIPPED'); const s = demoShipping.createShipment(o);
    db.prepare('INSERT INTO shipments VALUES(?,?,?,?,?)').run(o.order_no, s.courier, s.awb, 1, 'SHIPPED');
    db.prepare("INSERT INTO tracking_events(order_no,status,source) VALUES(?,'SHIPPED','DEMO')").run(o.order_no);
    for (const i of db.prepare('SELECT * FROM order_items WHERE order_no=?').all(o.order_no)) db.prepare('UPDATE variants SET stock=stock-?, reserved=reserved-? WHERE id=?').run(i.qty, i.qty, i.variant_id);
    return { ...s, note: 'DEMO shipment: no real courier booking was made' };
  }
  if (m === 'POST' && (r = p.match(/^\/api\/admin\/returns\/(\d+)\/decision$/))) {
    const ret = db.prepare('SELECT * FROM returns WHERE id=?').get(Number(r[1])); if (!ret) throw new HttpError(404, 'Not found');
    const o = order(ret.order_no); move(o, body.approve ? 'RETURN_APPROVED' : 'DELIVERED');
    db.prepare('UPDATE returns SET status=? WHERE id=?').run(body.approve ? 'APPROVED' : 'REJECTED', ret.id); return { ok: true };
  }
  if (m === 'POST' && (r = p.match(/^\/api\/admin\/orders\/([\w-]+)\/refund$/))) {
    const o = order(r[1]); move(o, 'REFUND_INITIATED');
    // Never marked completed here: a real provider callback (or manual confirmation) must do that.
    const cod = o.payment_method === 'COD';
    db.prepare('INSERT INTO refunds(order_no,method,amount,status,provider) VALUES(?,?,?,?,?)').run(o.order_no, cod ? 'COD_BANK_OR_UPI' : 'ORIGINAL_PAYMENT', o.grand_total, cod ? 'PENDING_MANUAL' : 'DEMO_SIMULATED', cod ? 'MANUAL' : 'DEMO');
    return { status: cod ? 'PENDING_MANUAL' : 'DEMO_SIMULATED' };
  }
  return undefined;
}
