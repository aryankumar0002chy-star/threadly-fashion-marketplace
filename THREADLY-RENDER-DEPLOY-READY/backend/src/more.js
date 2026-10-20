import { scryptSync, randomBytes, createHash } from 'node:crypto';
import { HttpError } from './extra.js';
export const SCHEMA3 = `
CREATE TABLE IF NOT EXISTS addresses(id INTEGER PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT, phone TEXT, line1 TEXT, line2 TEXT, landmark TEXT, city TEXT, state TEXT, pin TEXT, is_default INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, product_id INT NOT NULL REFERENCES products(id), user_id INT NOT NULL REFERENCES users(id), order_no TEXT, rating INT NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title TEXT, body TEXT, verified INT NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','APPROVED','REJECTED','ARCHIVED')), created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id,user_id));
CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), expires_at INT NOT NULL, used INT NOT NULL DEFAULT 0);`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ADDR = ['name', 'phone', 'line1', 'line2', 'landmark', 'city', 'state', 'pin'];
const cleanAddr = (b) => {
  const a = Object.fromEntries(ADDR.map((k) => [k, String(b[k] ?? '').trim().slice(0, 120)]));
  if (!a.name || !a.line1 || !a.city || !/^\d{10}$/.test(a.phone) || !/^[1-9]\d{5}$/.test(a.pin)) throw new HttpError(400, 'Please check the address fields');
  return a;
};
const LISTS = {
  customers: 'SELECT u.id,u.email,u.name,u.role,u.created_at,(SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders,(SELECT COALESCE(SUM(grand_total),0) FROM orders o WHERE o.user_id=u.id AND o.status!=\'CANCELLED\') spend FROM users u ORDER BY u.id DESC',
  payments: 'SELECT p.id,p.order_no,p.provider,p.amount,p.status,p.created_at,o.payment_method FROM payments p JOIN orders o ON o.order_no=p.order_no ORDER BY p.id DESC LIMIT 200',
  shipments: 'SELECT * FROM shipments', refunds: 'SELECT * FROM refunds ORDER BY id DESC',
  returns: 'SELECT r.id,r.order_no,u.email,r.reason,r.status FROM returns r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id DESC',
  reviews: 'SELECT r.id,p.title product,u.email customer,r.rating,r.title,r.body,r.verified,r.status FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.user_id ORDER BY r.id DESC',
};
export async function moreRoutes({ db, query, p, m, body, user, isAdmin, demo }) {
  const need = () => user || (() => { throw new HttpError(401, 'Login required'); })();
  const nf = () => { throw new HttpError(404, 'Not found'); };
  let r;
  if (m === 'GET' && (r = p.match(/^\/api\/products\/([\w-]+)\/reviews$/))) {
    const pr = db.prepare('SELECT id FROM products WHERE slug=?').get(r[1]) ?? nf();
    const rows = db.prepare("SELECT r.id,r.rating,r.title,r.body,r.verified,u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? AND r.status='APPROVED' ORDER BY r.id DESC").all(pr.id);
    const dist = {}; let s = 0; for (const x of rows) { dist[x.rating] = (dist[x.rating] || 0) + 1; s += x.rating; }
    return { reviews: rows, count: rows.length, avg: rows.length ? s / rows.length : 0, dist };
  }
  if (p === '/api/reviews' && m === 'POST') {
    const u = need(), pid = Number(body.productId), rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !String(body.title || '').trim() || !String(body.body || '').trim()) throw new HttpError(400, 'Rating, title and review text are required');
    const el = db.prepare("SELECT o.order_no FROM orders o JOIN order_items oi ON oi.order_no=o.order_no JOIN variants v ON v.id=oi.variant_id WHERE o.user_id=? AND v.product_id=? AND EXISTS(SELECT 1 FROM tracking_events t WHERE t.order_no=o.order_no AND t.status='DELIVERED') LIMIT 1").get(u.id, pid);
    if (!el) throw new HttpError(403, 'Only customers with a delivered order can review this product');
    try { return { id: db.prepare('INSERT INTO reviews(product_id,user_id,order_no,rating,title,body) VALUES(?,?,?,?,?,?)').run(pid, u.id, el.order_no, rating, String(body.title).slice(0, 120), String(body.body).slice(0, 2000)).lastInsertRowid, status: 'PENDING' }; }
    catch { throw new HttpError(409, 'You already reviewed this product. Edit your review instead.'); }
  }
  if ((r = p.match(/^\/api\/reviews\/(\d+)$/)) && (m === 'PUT' || m === 'DELETE')) {
    const u = need(), rv = db.prepare('SELECT * FROM reviews WHERE id=? AND user_id=?').get(Number(r[1]), u.id) ?? nf();
    if (m === 'DELETE') { db.prepare('DELETE FROM reviews WHERE id=?').run(rv.id); return { ok: true }; }
    const rating = Number(body.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Invalid rating');
    db.prepare("UPDATE reviews SET rating=?,title=?,body=?,status='PENDING' WHERE id=?").run(rating, String(body.title || rv.title).slice(0, 120), String(body.body || rv.body).slice(0, 2000), rv.id); return { status: 'PENDING' };
  }
  if (p === '/api/addresses') {
    const u = need();
    if (m === 'GET') return db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC,id').all(u.id);
    if (m === 'POST') { const a = cleanAddr(body), first = !db.prepare('SELECT 1 FROM addresses WHERE user_id=?').get(u.id);
      return { id: db.prepare('INSERT INTO addresses(user_id,name,phone,line1,line2,landmark,city,state,pin,is_default) VALUES(?,?,?,?,?,?,?,?,?,?)').run(u.id, ...ADDR.map((k) => a[k]), first ? 1 : 0).lastInsertRowid }; }
  }
  if ((r = p.match(/^\/api\/addresses\/(\d+)(\/default)?$/))) {
    const u = need(), row = db.prepare('SELECT * FROM addresses WHERE id=? AND user_id=?').get(Number(r[1]), u.id) ?? nf();
    if (m === 'DELETE') { db.prepare('DELETE FROM addresses WHERE id=?').run(row.id); return { ok: true }; }
    if (m === 'PUT' && !r[2]) { const a = cleanAddr(body); db.prepare('UPDATE addresses SET name=?,phone=?,line1=?,line2=?,landmark=?,city=?,state=?,pin=? WHERE id=?').run(...ADDR.map((k) => a[k]), row.id); return { ok: true }; }
    if (m === 'POST' && r[2]) { db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(u.id); db.prepare('UPDATE addresses SET is_default=1 WHERE id=?').run(row.id); return { ok: true }; }
  }
  if (m === 'GET' && p === '/api/delivery/check') {
    return checkPin(query.get('pin'));
  }
  if (m === 'POST' && p === '/api/auth/forgot') {
    const u = db.prepare('SELECT id,role FROM users WHERE email=?').get(String(body.email || '').toLowerCase()), token = randomBytes(24).toString('hex');
    // Security: staff accounts (ADMIN/SUPPORT/SUPPLIER) can never be reset through this public flow. In demo mode the token is returned in the
    // response, so allowing it would let anyone take over the admin account. The response shape stays identical (no account/role leak).
    if (u && u.role === 'CUSTOMER') db.prepare('INSERT INTO password_resets VALUES(?,?,?,0)').run(sha(token), u.id, Date.now() + 30 * 6e4);
    // Same response whether or not the account exists. No email provider is configured: in demo mode the token is returned so the flow can be exercised.
    return demo ? { ok: true, demo: true, demoResetToken: token } : { ok: true };
  }
  if (m === 'POST' && p === '/api/auth/reset') {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used=0 AND expires_at>?').get(sha(String(body.token || '')), Date.now());
    if (!row || String(body.password || '').length < 8) throw new HttpError(400, 'Reset link is invalid or expired, or the password is too short');
    const salt = randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(`${salt}:${scryptSync(body.password, salt, 64).toString('hex')}`, row.user_id);
    db.prepare('UPDATE password_resets SET used=1 WHERE token_hash=?').run(row.token_hash);
    db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(row.user_id); return { ok: true };
  }
  if (p.startsWith('/api/admin/') && isAdmin) {
    if (m === 'GET' && LISTS[p.slice(11)]) return db.prepare(LISTS[p.slice(11)]).all();
    if (m === 'POST' && (r = p.match(/^\/api\/admin\/reviews\/(\d+)\/status$/))) {
      if (!['APPROVED', 'REJECTED', 'ARCHIVED'].includes(body.status)) throw new HttpError(400, 'Bad status');
      if (!db.prepare('UPDATE reviews SET status=? WHERE id=?').run(body.status, Number(r[1])).changes) nf(); return { ok: true };
    }
  }
}
export function checkPin(pin) {
  if (!/^[1-9]\d{5}$/.test(pin || '')) throw new HttpError(400, 'Enter a valid 6-digit PIN code');
  const days = 3 + ([...pin].reduce((a, c) => a + +c, 0) % 4);
  return { deliverable: true, cod: pin[5] !== '0', days, eta: new Date(Date.now() + days * 864e5).toISOString().slice(0, 10), demo: true, note: 'Estimate from a deterministic DEMO rule. No courier API was queried.' };
}
