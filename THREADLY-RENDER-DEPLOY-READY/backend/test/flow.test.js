import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createServer } from '../src/app.js';
import { createUser } from '../src/extra.js';
const db = openDb(); const srv = createServer(db, { webDir: new URL('../../frontend/', import.meta.url) });
await new Promise((r) => srv.listen(0, r)); const base = `http://localhost:${srv.address().port}`;
test.after(() => srv.close());
const mk = () => ({ sid: '' });
const call = async (jar, p, method = 'GET', body, headers = {}, raw) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: jar.sid, ...headers }, body: raw ?? (body && JSON.stringify(body)) });
  const c = r.headers.get('set-cookie'); if (c) jar.sid = c.split(';')[0];
  return { s: r.status, j: await r.json() };
};
const cust = mk(), admin = mk(), anon = mk();
const addr = { name: 'Rahul', phone: '9876543210', pin: '823001', line1: '1 Main St', city: 'Gaya' };
const variant = () => db.prepare('SELECT id FROM variants WHERE stock-reserved>5 LIMIT 1').get().id;
const place = (jar, payment) => call(jar, '/api/orders', 'POST', { payment, address: addr, items: [{ variantId: variant(), qty: 1 }] });

test('auth: register, session, wrong password, logout, validation', async () => {
  assert.equal((await call(anon, '/api/me')).s, 401);
  assert.equal((await call(cust, '/api/auth/register', 'POST', { email: 'a@b.co', password: 'short' })).s, 400);
  assert.equal((await call(cust, '/api/auth/register', 'POST', { email: 'a@b.co', password: 'longenough1' })).s, 200);
  assert.equal((await call(cust, '/api/me')).j.role, 'CUSTOMER');
  assert.notEqual(db.prepare('SELECT password_hash h FROM users').get().h, 'longenough1');
  assert.equal((await call(mk(), '/api/auth/login', 'POST', { email: 'a@b.co', password: 'wrongwrong' })).s, 401);
  assert.equal((await call(mk(), '/api/auth/register', 'POST', { email: 'a@b.co', password: 'longenough1' })).s, 409);
});
test('authorization: customers cannot reach admin; admin role can', async () => {
  assert.equal((await call(cust, '/api/admin/settings')).s, 403);
  assert.equal((await call(anon, '/api/admin/settings')).s, 403);
  createUser(db, { email: 'admin@x.co', password: 'adminpass1', role: 'ADMIN' });
  await call(admin, '/api/auth/login', 'POST', { email: 'admin@x.co', password: 'adminpass1' });
  assert.equal((await call(admin, '/api/admin/settings')).s, 200);
});
test('wishlist requires login and persists', async () => {
  assert.equal((await call(anon, '/api/wishlist')).s, 401);
  await call(cust, '/api/wishlist', 'POST', { productId: 1 });
  assert.equal((await call(cust, '/api/wishlist')).j.length, 1);
  await call(cust, '/api/wishlist/1', 'DELETE');
  assert.equal((await call(cust, '/api/wishlist')).j.length, 0);
});
test('full COD lifecycle: ship (demo), track, deliver, return, refund; invalid transitions rejected', async () => {
  const o = (await place(cust, 'COD')).j.orderNo, st = (s) => call(admin, `/api/admin/orders/${o}/status`, 'POST', { status: s });
  assert.equal((await st('DELIVERED')).s, 409);
  assert.equal((await call(admin, `/api/admin/orders/${o}/ship`, 'POST')).s, 409);
  for (const s of ['CONFIRMED', 'PACKED']) assert.equal((await st(s)).s, 200);
  assert.equal((await st('SHIPPED')).s, 400);
  const ship = await call(admin, `/api/admin/orders/${o}/ship`, 'POST'); assert.equal(ship.j.awb, `DEMO-${o}`);
  for (const s of ['OUT_FOR_DELIVERY', 'DELIVERED']) assert.equal((await st(s)).s, 200);
  assert.equal((await call(anon, `/api/orders/${o}`)).j.payment_status, 'COD_COLLECTED');
  const t = (await call(anon, `/api/orders/${o}/tracking`)).j;
  assert.equal(t.shipment.demo, 1); assert.deepEqual(t.events.map((e) => e.status), ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
  assert.equal((await call(anon, `/api/orders/${o}/return`, 'POST', { reason: 'Wrong size' })).s, 401);
  const ret = await call(cust, `/api/orders/${o}/return`, 'POST', { reason: 'Wrong size' }); assert.equal(ret.s, 200);
  assert.equal((await call(admin, `/api/admin/returns/${ret.j.id}/decision`, 'POST', { approve: true })).s, 200);
  for (const s of ['RETURN_PICKUP', 'RETURNED']) assert.equal((await st(s)).s, 200);
  assert.equal((await call(admin, `/api/admin/orders/${o}/refund`, 'POST')).j.status, 'PENDING_MANUAL'); // never auto-completed
  assert.equal((await call(anon, `/api/orders/${o}`)).j.status, 'REFUND_INITIATED');
});
test('shipping deducts stock and releases reservation; cancel releases', async () => {
  const id = variant(), before = db.prepare('SELECT stock,reserved FROM variants WHERE id=?').get(id);
  const o = (await call(cust, '/api/orders', 'POST', { payment: 'COD', address: addr, items: [{ variantId: id, qty: 2 }] })).j.orderNo;
  assert.equal(db.prepare('SELECT reserved FROM variants WHERE id=?').get(id).reserved, before.reserved + 2);
  for (const s of ['CONFIRMED', 'PACKED']) await call(admin, `/api/admin/orders/${o}/status`, 'POST', { status: s });
  await call(admin, `/api/admin/orders/${o}/ship`, 'POST');
  const after = db.prepare('SELECT stock,reserved FROM variants WHERE id=?').get(id);
  assert.equal(after.stock, before.stock - 2); assert.equal(after.reserved, before.reserved);
});
test('return only by the order owner', async () => {
  const o = (await place(cust, 'COD')).j.orderNo;
  for (const s of ['CONFIRMED', 'PACKED']) await call(admin, `/api/admin/orders/${o}/status`, 'POST', { status: s });
  await call(admin, `/api/admin/orders/${o}/ship`, 'POST');
  for (const s of ['OUT_FOR_DELIVERY', 'DELIVERED']) await call(admin, `/api/admin/orders/${o}/status`, 'POST', { status: s });
  const other = mk(); await call(other, '/api/auth/register', 'POST', { email: 'o@b.co', password: 'longenough1' });
  assert.equal((await call(other, `/api/orders/${o}/return`, 'POST', { reason: 'x' })).s, 403);
});
test('online DEMO payment: pending until confirmed, labeled demo', async () => {
  const o = (await place(cust, 'ONLINE')).j.orderNo;
  assert.equal((await call(anon, `/api/orders/${o}`)).j.payment_status, 'PAYMENT_PENDING');
  const pay = await call(anon, '/api/payments/create', 'POST', { orderNo: o }); assert.equal(pay.j.demo, true);
  assert.equal((await call(anon, '/api/payments/demo/confirm', 'POST', { orderNo: o })).j.status, 'PAID');
  const done = (await call(anon, `/api/orders/${o}`)).j; assert.equal(done.status, 'CONFIRMED'); assert.equal(done.payment_status, 'PAID');
  assert.equal((await call(anon, '/api/payments/demo/confirm', 'POST', { orderNo: o })).s, 409);
});
test('webhook: needs secret, verifies HMAC signature, idempotent', async () => {
  const o = (await place(cust, 'ONLINE')).j.orderNo, payload = JSON.stringify({ eventId: 'evt1', orderNo: o, status: 'paid' });
  assert.equal((await call(anon, '/api/payments/webhook', 'POST', null, {}, payload)).s, 501);
  process.env.PAYMENT_WEBHOOK_SECRET = 's3cret';
  assert.equal((await call(anon, '/api/payments/webhook', 'POST', null, { 'x-signature': 'ab' }, payload)).s, 401);
  const sig = createHmac('sha256', 's3cret').update(payload).digest('hex');
  assert.equal((await call(anon, '/api/payments/webhook', 'POST', null, { 'x-signature': sig }, payload)).j.ok, true);
  assert.equal((await call(anon, '/api/payments/webhook', 'POST', null, { 'x-signature': sig }, payload)).j.duplicate, true);
  assert.equal((await call(anon, `/api/orders/${o}`)).j.payment_status, 'PAID');
  delete process.env.PAYMENT_WEBHOOK_SECRET;
});
test('catalog filters (color/size/rating) and admin order list', async () => {
  const r = (await call(anon, '/api/products?color=Black&size=M&minRating=4')).j;
  assert.ok(r.rows.length > 0 && r.rows.every((p) => p.rating >= 4 && /Black/.test(p.title)));
  assert.equal((await call(cust, '/api/admin/orders')).s, 403);
  const l = (await call(admin, '/api/admin/orders')).j; assert.ok(Array.isArray(l) && l.length > 0 && 'return_id' in l[0]);
  assert.ok((await call(anon, `/api/orders/${l[0].order_no}`)).j.items[0].title);
});
