import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSettings } from './db.js';
import { calculateTotals, PricingError } from './pricing.js';
import { supplierAdapter } from './suppliers.js';

import { HttpError, TRANSITIONS, extraRoutes, currentUser } from './extra.js';
import { moreRoutes } from './more.js';

export function createServer(db, { adminToken = process.env.ADMIN_TOKEN, webDir } = {}) {
  const supplier = supplierAdapter();
  // Prices always come from the DB, never from the client.
  function priceItems(items, couponCode, payment) {
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Cart is empty');
    const lines = items.map((it) => {
      const qty = Number(it.qty);
      const v = db.prepare('SELECT v.*, p.price, p.title, p.supplier FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?').get(Number(it.variantId));
      if (!v || !Number.isInteger(qty) || qty < 1 || qty > 10) throw new HttpError(400, 'Invalid item');
      if (v.stock - v.reserved < qty) throw new HttpError(409, `Out of stock: ${v.title} ${v.size}`);
      return { variant: v, unitPrice: v.price, qty };
    });
    const c = couponCode && db.prepare('SELECT * FROM coupons WHERE code=?').get(String(couponCode).toUpperCase());
    if (couponCode && !c) throw new HttpError(400, 'Invalid coupon');
    const coupon = c && { type: c.type, value: c.value, minOrder: c.min_order, maxDiscount: c.max_discount };
    return { lines, totals: calculateTotals({ items: lines, paymentMethod: payment, coupon, settings: getSettings(db) }) };
  }
  const listProducts = (q) => {
    const w = ['1=1'], a = [];
    if (q.q) { w.push('(title LIKE ? OR brand LIKE ? OR category LIKE ? OR id IN (SELECT product_id FROM variants WHERE sku=?))'); a.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, q.q); }
    if (q.category) { w.push('category=?'); a.push(q.category); }
    if (q.gender) { w.push('gender=?'); a.push(q.gender); }
    if (q.color) { w.push('id IN (SELECT product_id FROM variants WHERE color=?)'); a.push(q.color); }
    if (q.size) { w.push('id IN (SELECT product_id FROM variants WHERE size=? AND stock>reserved)'); a.push(q.size); }
    if (q.minRating) { w.push('rating>=?'); a.push(Number(q.minRating)); }
    if (q.maxPrice) { w.push('price<=?'); a.push(Number(q.maxPrice) * 100); }
    const order = { low: 'price ASC', high: 'price DESC', rating: 'rating DESC', discount: '(mrp-price)*1.0/mrp DESC', newest: 'id DESC' }[q.sort] || 'reviews DESC';
    const page = Math.max(1, Number(q.page) || 1), limit = 24;
    const total = db.prepare(`SELECT COUNT(*) c FROM products WHERE ${w.join(' AND ')}`).get(...a).c;
    const rows = db.prepare(`SELECT * FROM products WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`).all(...a);
    return { total, page, rows };
  };
  async function route(req, url, body, res) {
    const q = Object.fromEntries(url.searchParams), p = url.pathname, m = req.method;
    const user = currentUser(db, req), demo = process.env.APP_MODE !== 'production';
    const isAdmin = user?.role === 'ADMIN' || (!!adminToken && req.headers['x-admin-token'] === adminToken);
    if (m === 'GET' && p === '/api/products') return listProducts(q);
    let r;
    if (m === 'GET' && (r = p.match(/^\/api\/products\/([\w-]+)$/))) {
      const prod = db.prepare('SELECT * FROM products WHERE slug=?').get(r[1]); if (!prod) throw new HttpError(404, 'Not found');
      return { ...prod, variants: db.prepare('SELECT id,color,size,stock-reserved AS available FROM variants WHERE product_id=?').all(prod.id) };
    }
    if (m === 'GET' && p === '/api/settings/public') { const s = getSettings(db); return { codEnabled: s.codEnabled, paymentMode: 'COD_ONLY_ONLINE_NOT_CONFIGURED' }; }
    if (m === 'POST' && p === '/api/quote') return priceItems(body.items, body.coupon, body.payment || 'ONLINE').totals;
    if (m === 'POST' && p === '/api/orders') {
      if (body.payment !== 'COD' && !(body.payment === 'ONLINE' && demo)) throw new HttpError(501, 'Online payment gateway not configured');
      const a = body.address || {};
      if (!a.name || !/^\d{10}$/.test(a.phone || '') || !/^[1-9]\d{5}$/.test(a.pin || '') || !a.line1 || !a.city) throw new HttpError(400, 'Invalid address');
      db.exec('BEGIN IMMEDIATE'); // serialises writers: prevents overselling
      try {
        const { lines, totals } = priceItems(body.items, body.coupon, body.payment);
        const no = `ORD-${new Date().getFullYear()}-${randomUUID().slice(0, 6).toUpperCase()}`;
        db.prepare('INSERT INTO orders(order_no,payment_method,payment_status,status,subtotal,discount,platform_fee,delivery_fee,cod_fee,grand_total,address) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(no, body.payment, body.payment === 'COD' ? 'COD_PENDING' : 'PAYMENT_PENDING', 'PLACED', totals.subtotal, totals.discount, totals.platformFee, totals.deliveryFee, totals.codFee, totals.grandTotal, JSON.stringify(a));
        for (const l of lines) {
          db.prepare('UPDATE variants SET reserved=reserved+? WHERE id=?').run(l.qty, l.variant.id);
          const f = await supplier.createOrder({ no, sku: l.variant.sku, qty: l.qty });
          db.prepare('INSERT INTO order_items(order_no,variant_id,qty,unit_price,supplier,fulfillment_status) VALUES(?,?,?,?,?,?)').run(no, l.variant.id, l.qty, l.unitPrice, l.variant.supplier, f.status);
        }
        if (user) db.prepare('UPDATE orders SET user_id=? WHERE order_no=?').run(user.id, no);
        db.exec('COMMIT'); return { orderNo: no, totals, demo: supplier.demo, paymentPending: body.payment === 'ONLINE' };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    if ((r = p.match(/^\/api\/orders\/([\w-]+)(\/cancel)?$/))) {
      const o = db.prepare('SELECT * FROM orders WHERE order_no=?').get(r[1]); if (!o) throw new HttpError(404, 'Not found');
      const items = db.prepare('SELECT oi.*, p.title, v.size, v.color FROM order_items oi JOIN variants v ON v.id=oi.variant_id JOIN products p ON p.id=v.product_id WHERE oi.order_no=?').all(o.order_no);
      if (m === 'GET') return { ...o, items, tracking: [] }; // no tracking until a real/demo shipment exists
      if (m === 'POST' && r[2]) {
        if (!TRANSITIONS[o.status].includes('CANCELLED')) throw new HttpError(409, `Cannot cancel an order that is ${o.status}`);
        db.exec('BEGIN IMMEDIATE');
        for (const i of items) db.prepare('UPDATE variants SET reserved=reserved-? WHERE id=?').run(i.qty, i.variant_id);
        db.prepare("UPDATE orders SET status='CANCELLED' WHERE order_no=?").run(o.order_no); db.exec('COMMIT');
        return { status: 'CANCELLED' };
      }
    }
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin) throw new HttpError(403, 'Forbidden');
      if (m === 'GET' && p === '/api/admin/settings') return getSettings(db);
      if (m === 'PUT' && p === '/api/admin/settings') {
        for (const [k, v] of Object.entries(body)) {
          if (!(k in getSettings(db)) || (typeof v === 'number' && (!Number.isInteger(v) || v < 0))) throw new HttpError(400, `Bad setting ${k}`);
          db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(v), k);
        }
        return getSettings(db);
      }
      if (m === 'GET' && p === '/api/admin/analytics') return db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(grand_total),0) gross, COALESCE(SUM(platform_fee),0) platformFeeRevenue,
        COALESCE(SUM(delivery_fee),0) deliveryRevenue, COALESCE(SUM(cod_fee),0) codRevenue FROM orders WHERE status!='CANCELLED'`).get();
    }
    const x = await extraRoutes({ db, req, p, m, body, res, user, isAdmin, demo }); if (x !== undefined) return x;
    const y = await moreRoutes({ db, query: url.searchParams, p, m, body, user, isAdmin, demo }); if (y !== undefined) return y;
    throw new HttpError(404, 'Not found');
  }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), send = (s, b, t = 'application/json') => { res.writeHead(s, { 'content-type': t, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', ...(t === 'application/json' ? { 'cache-control': 'no-store' } : {}) }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    try {
      if (url.pathname === '/healthz') { db.prepare('SELECT 1').get(); return send(200, { ok: true }); } // Render health check; also proves the DB answers
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname, webDir);
      let body = {}; if (req.method !== 'GET') { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) throw new HttpError(413, 'Too large'); } req.rawBody = raw; body = raw ? JSON.parse(raw) : {}; }
      send(200, await route(req, url, body, res));
    } catch (e) {
      if (e instanceof PricingError) return send(400, { error: e.code });
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e); send(e instanceof SyntaxError ? 400 : 500, { error: 'Something went wrong. Please try again.' });
    }
  });
}

// ---- Static storefront (served from the same process as the API) ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
async function serveStatic(req, res, pathname, webDir) {
  const headers = (type, cache) => ({ 'content-type': type, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'cache-control': cache });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
  let rel; try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  const root = path.resolve(fileURLToPath(webDir)), file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  let target = file, fallback = false;
  if (rel.includes('\0') || (file !== root && !file.startsWith(root + path.sep))) { res.writeHead(403); return res.end('Forbidden'); } // path traversal guard
  try { if (!(await stat(target)).isFile()) throw 0; }
  catch {
    if (path.extname(rel)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); } // missing asset: real 404
    target = path.join(root, 'index.html'); fallback = true; // client-side routes: serve the app shell
  }
  const ext = path.extname(target), isHtml = ext === '.html';
  const data = await readFile(target);
  res.writeHead(200, headers(MIME[ext] || 'application/octet-stream', isHtml ? 'no-cache' : 'public, max-age=3600'));
  res.end(req.method === 'HEAD' ? undefined : data);
  return fallback;
}
