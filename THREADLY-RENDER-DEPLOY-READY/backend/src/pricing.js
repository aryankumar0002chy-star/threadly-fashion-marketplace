// Single authoritative pricing function. All money is integer paise. Never trust client totals.
export const DEFAULT_SETTINGS = Object.freeze({
  platformFee: 9600, deliveryFee: 4900, freeDeliveryThreshold: 99900,
  codEnabled: true, codFee: 3000, codMin: 0, codMax: 5000000,
});

export function applyCoupon(coupon, subtotal, { isFirstOrder = false, now = new Date() } = {}) {
  if (!coupon) return 0;
  if (coupon.startsAt && now < new Date(coupon.startsAt)) throw new PricingError('COUPON_NOT_ACTIVE');
  if (coupon.endsAt && now > new Date(coupon.endsAt)) throw new PricingError('COUPON_EXPIRED');
  if (coupon.firstOrderOnly && !isFirstOrder) throw new PricingError('COUPON_FIRST_ORDER_ONLY');
  if (subtotal < (coupon.minOrder ?? 0)) throw new PricingError('COUPON_MIN_ORDER');
  const raw = coupon.type === 'PERCENT' ? Math.floor((subtotal * coupon.value) / 100) : coupon.value;
  return Math.min(raw, coupon.maxDiscount ?? raw, subtotal);
}

/** items: [{ unitPrice, qty }] priced from the DB by the caller, not from the browser. */
export function calculateTotals({ items, paymentMethod, coupon = null, settings = DEFAULT_SETTINGS, couponCtx = {} }) {
  if (!items?.length) throw new PricingError('EMPTY_CART');
  const subtotal = items.reduce((s, i) => {
    if (!Number.isInteger(i.unitPrice) || !Number.isInteger(i.qty) || i.qty < 1) throw new PricingError('BAD_ITEM');
    return s + i.unitPrice * i.qty;
  }, 0);
  const discount = applyCoupon(coupon, subtotal, couponCtx);
  const taxable = subtotal - discount;
  const deliveryFee = taxable >= settings.freeDeliveryThreshold ? 0 : settings.deliveryFee;
  let codFee = 0;
  if (paymentMethod === 'COD') {
    if (!settings.codEnabled) throw new PricingError('COD_DISABLED');
    if (taxable < settings.codMin || taxable > settings.codMax) throw new PricingError('COD_AMOUNT_OUT_OF_RANGE');
    codFee = settings.codFee;
  } else if (paymentMethod !== 'ONLINE') throw new PricingError('BAD_PAYMENT_METHOD');
  const platformFee = settings.platformFee;
  return { subtotal, discount, platformFee, deliveryFee, codFee,
    grandTotal: taxable + platformFee + deliveryFee + codFee };
}

export class PricingError extends Error {
  constructor(code) { super(code); this.code = code; }
}
