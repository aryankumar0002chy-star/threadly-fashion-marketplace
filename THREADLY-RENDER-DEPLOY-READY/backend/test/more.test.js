import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/app.js';
import { createUser } from '../src/extra.js';
const db = openDb(); const srv = createServer(db, { webDir: new URL('../../frontend/', import.meta.url) });
await new Promise((r) => srv.listen(0, r)); const base = `http://localhost:${srv.address().port}`; test.after(() => srv.close());
const mk = () => ({ sid: '' });
const call = async (jar, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: jar.sid }, body: body && JSON.stringify(body) });
  const c = r.headers.get('set-cookie'); if (c) jar.sid = c.split(';')[0]; return { s: r.status, j: await r.json() }; };
const cust = mk(), admin = mk(), anon = mk(), other = mk();
const addr = { name: 'Rahul', phone: '9876543210', pin: '823001', line1: '1 Main St', city: 'Gaya' };
await call(cust, '/api/auth/register', 'POST', { email: 'c@x.co', password: 'longenough1', name: 'Cee' });
await call(other, '/api/auth/register', 'POST', { email: 'o@x.co', password: 'longenough1' });
createUser(db, { email: 'a@x.co', password: 'adminpass1', role: 'ADMIN' }); await call(admin, '/api/auth/login', 'POST', { email: 'a@x.co', password: 'adminpass1' });
const v = db.prepare('SELECT v.id, v.product_id, p.slug FROM variants v JOIN products p ON p.id=v.product_id WHERE v.stock-v.reserved>5 LIMIT 1').get();
const deliver = async () => { const o = (await call(cust, '/api/orders', 'POST', { payment: 'COD', address: addr, items: [{ variantId: v.id, qty: 1 }] })).j.orderNo;
  for (const s of ['CONFIRMED', 'PACKED']) await call(admin, `/api/admin/orders/${o}/status`, 'POST', { status: s });
  await call(admin, `/api/admin/orders/${o}/ship`, 'POST');
  for (const s of ['OUT_FOR_DELIVERY', 'DELIVERED']) await call(admin, `/api/admin/orders/${o}/status`, 'POST', { status: s }); return o; };

test('reviews: need delivered purchase, moderation, one per product, stats from approved only', async () => {
  const rv = { productId: v.product_id, rating: 5, title: 'Great', body: 'Fits well' };
  assert.equal((await call(anon, '/api/reviews', 'POST', rv)).s, 401);
  assert.equal((await call(cust, '/api/reviews', 'POST', rv)).s, 403);
  await deliver();
  assert.equal((await call(cust, '/api/reviews', 'POST', { ...rv, rating: 9 })).s, 400);
  const made = await call(cust, '/api/reviews', 'POST', rv); assert.equal(made.s, 200);
  assert.equal((await call(cust, '/api/reviews', 'POST', rv)).s, 409);
  assert.equal((await call(anon, `/api/products/${v.slug}/reviews`)).j.count, 0);
  assert.equal((await call(cust, `/api/admin/reviews/${made.j.id}/status`, 'POST', { status: 'APPROVED' })).s, 403);
  assert.equal((await call(admin, `/api/admin/reviews/${made.j.id}/status`, 'POST', { status: 'APPROVED' })).s, 200);
  const s = (await call(anon, `/api/products/${v.slug}/reviews`)).j; assert.equal(s.count, 1); assert.equal(s.avg, 5); assert.equal(s.reviews[0].verified, 1);
  assert.equal((await call(other, `/api/reviews/${made.j.id}`, 'DELETE')).s, 404);
  assert.equal((await call(cust, `/api/reviews/${made.j.id}`, 'PUT', { rating: 4 })).j.status, 'PENDING');
  assert.equal((await call(anon, `/api/products/${v.slug}/reviews`)).j.count, 0);
});
test('addresses: validate, default handling, ownership', async () => {
  assert.equal((await call(anon, '/api/addresses')).s, 401);
  assert.equal((await call(cust, '/api/addresses', 'POST', { ...addr, pin: '12' })).s, 400);
  const a = (await call(cust, '/api/addresses', 'POST', addr)).j.id, b = (await call(cust, '/api/addresses', 'POST', { ...addr, city: 'Patna' })).j.id;
  let l = (await call(cust, '/api/addresses')).j; assert.equal(l.find((x) => x.id === a).is_default, 1); assert.equal(l.find((x) => x.id === b).is_default, 0);
  await call(cust, `/api/addresses/${b}/default`, 'POST'); l = (await call(cust, '/api/addresses')).j; assert.deepEqual(l.map((x) => x.is_default).sort(), [0, 1]);
  assert.equal((await call(cust, `/api/addresses/${a}`, 'PUT', { ...addr, city: 'Gaya2' })).s, 200);
  assert.equal((await call(other, `/api/addresses/${a}`, 'DELETE')).s, 404);
  assert.equal((await call(cust, `/api/addresses/${a}`, 'DELETE')).s, 200);
});
test('pincode checker is deterministic, validated, labeled demo', async () => {
  const x = (await call(anon, '/api/delivery/check?pin=823001')).j, y = (await call(anon, '/api/delivery/check?pin=823001')).j;
  assert.deepEqual({ ...x }, { ...y }); assert.equal(x.demo, true); assert.ok(x.days >= 3 && x.days <= 6);
  assert.equal((await call(anon, '/api/delivery/check?pin=823000')).j.cod, false);
  assert.equal((await call(anon, '/api/delivery/check?pin=abc')).s, 400);
});
test('forgot password: no account leak, single-use, expires, revokes sessions', async () => {
  const known = (await call(anon, '/api/auth/forgot', 'POST', { email: 'o@x.co' })).j, unknown = (await call(anon, '/api/auth/forgot', 'POST', { email: 'nobody@x.co' })).j;
  assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort());
  assert.notEqual(db.prepare('SELECT token_hash t FROM password_resets').get().t, known.demoResetToken);
  assert.equal((await call(anon, '/api/auth/reset', 'POST', { token: unknown.demoResetToken, password: 'newpassword1' })).s, 400);
  assert.equal((await call(anon, '/api/auth/reset', 'POST', { token: known.demoResetToken, password: 'short' })).s, 400);
  assert.equal((await call(anon, '/api/auth/reset', 'POST', { token: known.demoResetToken, password: 'newpassword1' })).s, 200);
  assert.equal((await call(anon, '/api/auth/reset', 'POST', { token: known.demoResetToken, password: 'another-pass1' })).s, 400);
  assert.equal((await call(other, '/api/me')).s, 401);
  assert.equal((await call(mk(), '/api/auth/login', 'POST', { email: 'o@x.co', password: 'newpassword1' })).s, 200);
  const t = (await call(anon, '/api/auth/forgot', 'POST', { email: 'o@x.co' })).j.demoResetToken; db.exec('UPDATE password_resets SET expires_at=1');
  assert.equal((await call(anon, '/api/auth/reset', 'POST', { token: t, password: 'newpassword2' })).s, 400);
});
test('admin lists: authorization, no password hashes', async () => {
  for (const n of ['customers', 'payments', 'shipments', 'refunds', 'returns', 'reviews']) { assert.equal((await call(cust, '/api/admin/' + n)).s, 403); assert.equal((await call(admin, '/api/admin/' + n)).s, 200); }
  const c = (await call(admin, '/api/admin/customers')).j; assert.ok(c.length >= 3); assert.ok(!('password_hash' in c[0])); assert.ok(c.some((x) => x.orders > 0 && x.spend > 0));
});
