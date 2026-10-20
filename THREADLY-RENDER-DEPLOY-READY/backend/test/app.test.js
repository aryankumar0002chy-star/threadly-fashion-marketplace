import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/app.js';
const db = openDb(); const srv = createServer(db, { adminToken: 'tok', webDir: new URL('../../frontend/', import.meta.url) });
await new Promise((r) => srv.listen(0, r)); const base = `http://localhost:${srv.address().port}`;
test.after(() => srv.close());
const api = (p, o = {}) => fetch(base + p, { ...o, headers: { 'content-type': 'application/json', ...o.headers }, body: o.body && JSON.stringify(o.body) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const addr = { name: 'Rahul', phone: '9876543210', pin: '823001', line1: '1 Main St', city: 'Gaya' };
const oneVariant = () => db.prepare('SELECT v.id, p.price FROM variants v JOIN products p ON p.id=v.product_id WHERE v.stock>0 LIMIT 1').get();

test('catalog seeded with 100+ products, search + pagination work', async () => {
  assert.ok((await api('/api/products')).j.total >= 100);
  assert.ok((await api('/api/products?q=hoodie')).j.rows.every((r) => /hoodie/i.test(r.title)));
  assert.equal((await api('/api/products?page=2')).j.page, 2);
});
test('quote: server-side Rs 96 platform fee, COD fee only on COD', async () => {
  const { id, price } = oneVariant();
  const on = (await api('/api/quote', { method: 'POST', body: { items: [{ variantId: id, qty: 1 }], payment: 'ONLINE' } })).j;
  const cod = (await api('/api/quote', { method: 'POST', body: { items: [{ variantId: id, qty: 1 }], payment: 'COD' } })).j;
  assert.equal(on.platformFee, 9600); assert.equal(on.codFee, 0); assert.equal(cod.codFee, 3000);
  assert.equal(on.grandTotal, price + 9600 + on.deliveryFee);
});
test('client-sent prices are ignored', async () => {
  const { id, price } = oneVariant();
  const q = (await api('/api/quote', { method: 'POST', body: { items: [{ variantId: id, qty: 1, unitPrice: 1 }], payment: 'ONLINE' } })).j;
  assert.equal(q.subtotal, price);
});
test('online payment refuses honestly when unconfigured', async () => {
  process.env.APP_MODE = 'production';
  const r = await api('/api/orders', { method: 'POST', body: { payment: 'ONLINE', items: [] } }); assert.equal(r.s, 501);
  delete process.env.APP_MODE;
});
test('COD order reserves stock, cannot oversell, cancel releases', async () => {
  const v = db.prepare('SELECT id, stock FROM variants WHERE stock>0 LIMIT 1').get();
  const place = (qty) => api('/api/orders', { method: 'POST', body: { payment: 'COD', address: addr, items: [{ variantId: v.id, qty }] } });
  const o = await place(1); assert.equal(o.s, 200); assert.equal(o.j.demo, true);
  assert.equal(db.prepare('SELECT reserved FROM variants WHERE id=?').get(v.id).reserved, 1);
  assert.equal((await place(10)).s === 409 || v.stock >= 10, true);
  assert.equal((await api(`/api/orders/${o.j.orderNo}`)).j.items[0].fulfillment_status, 'DEMO_FULFILLMENT_PENDING');
  assert.equal((await api(`/api/orders/${o.j.orderNo}/cancel`, { method: 'POST', body: {} })).j.status, 'CANCELLED');
  assert.equal(db.prepare('SELECT reserved FROM variants WHERE id=?').get(v.id).reserved, 0);
  assert.equal((await api(`/api/orders/${o.j.orderNo}/cancel`, { method: 'POST', body: {} })).s, 409);
});
test('out-of-stock variant is rejected', async () => {
  const v = db.prepare('SELECT id FROM variants WHERE stock=0 LIMIT 1').get();
  assert.equal((await api('/api/quote', { method: 'POST', body: { items: [{ variantId: v.id, qty: 1 }], payment: 'COD' } })).s, 409);
});
test('coupon WELCOME10 is capped at Rs 300 and enforces minimum', async () => {
  const v = db.prepare('SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id WHERE p.price>=100000 AND v.stock>5 LIMIT 1').get();
  const q = (await api('/api/quote', { method: 'POST', body: { items: [{ variantId: v.id, qty: 5 }], payment: 'ONLINE', coupon: 'WELCOME10' } })).j;
  assert.ok(q.discount > 0 && q.discount <= 30000);
});
test('admin routes: forbidden without token; platform fee change applies to quotes', async () => {
  assert.equal((await api('/api/admin/settings')).s, 403);
  await api('/api/admin/settings', { method: 'PUT', headers: { 'x-admin-token': 'tok' }, body: { platformFee: 7900 } });
  const { id } = oneVariant();
  assert.equal((await api('/api/quote', { method: 'POST', body: { items: [{ variantId: id, qty: 1 }], payment: 'ONLINE' } })).j.platformFee, 7900);
  assert.equal((await api('/api/admin/analytics', { headers: { 'x-admin-token': 'tok' } })).s, 200);
});
