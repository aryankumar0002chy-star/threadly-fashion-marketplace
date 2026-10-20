import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTotals, DEFAULT_SETTINGS, PricingError } from '../src/pricing.js';
const rs = (n) => n * 100;
const tee = [{ unitPrice: rs(799), qty: 1 }];
const coupon = { type: 'FIXED', value: rs(100) };

test('default platform fee is Rs 96', () => assert.equal(DEFAULT_SETTINGS.platformFee, rs(96)));
test('online: 799-100+96+49 = 844', () =>
  assert.equal(calculateTotals({ items: tee, paymentMethod: 'ONLINE', coupon }).grandTotal, rs(844)));
test('COD: adds Rs 30 -> 874', () => {
  const t = calculateTotals({ items: tee, paymentMethod: 'COD', coupon });
  assert.equal(t.codFee, rs(30)); assert.equal(t.grandTotal, rs(874));
});
test('cart example: 1198-200+96+49+30 = 1173', () =>
  assert.equal(calculateTotals({ items: [{ unitPrice: rs(599), qty: 2 }], paymentMethod: 'COD',
    coupon: { type: 'FIXED', value: rs(200) } }).grandTotal, rs(1173)));
test('free delivery at/above Rs 999', () =>
  assert.equal(calculateTotals({ items: [{ unitPrice: rs(999), qty: 1 }], paymentMethod: 'ONLINE' }).deliveryFee, 0));
test('platform fee follows admin setting', () =>
  assert.equal(calculateTotals({ items: tee, paymentMethod: 'ONLINE',
    settings: { ...DEFAULT_SETTINGS, platformFee: rs(79) } }).platformFee, rs(79)));
test('percent coupon respects cap and minimum', () => {
  const c = { type: 'PERCENT', value: 10, maxDiscount: rs(300), minOrder: rs(999) };
  assert.equal(calculateTotals({ items: [{ unitPrice: rs(5000), qty: 1 }], paymentMethod: 'ONLINE', coupon: c }).discount, rs(300));
  assert.throws(() => calculateTotals({ items: tee, paymentMethod: 'ONLINE', coupon: c }), PricingError);
});
test('COD disabled / bad input rejected', () => {
  assert.throws(() => calculateTotals({ items: tee, paymentMethod: 'COD', settings: { ...DEFAULT_SETTINGS, codEnabled: false } }));
  assert.throws(() => calculateTotals({ items: [{ unitPrice: 1.5, qty: 1 }], paymentMethod: 'ONLINE' }));
});
