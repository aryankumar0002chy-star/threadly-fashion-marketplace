// Supplier adapter interface: { name, demo, createOrder(order) -> { status, ref } }
export class MockSupplierAdapter {
  name = 'mock'; demo = true;
  async createOrder() { return { status: 'DEMO_FULFILLMENT_PENDING', ref: null }; } // never claims real acceptance
}
export class UnconfiguredSupplierAdapter {
  name = 'none'; demo = false;
  async createOrder() { return { status: 'FULFILLMENT_PENDING', ref: null, note: 'Supplier integration not configured' }; }
}
export const supplierAdapter = () => (process.env.SUPPLIER_MODE === 'mock' || !process.env.SUPPLIER_MODE ? new MockSupplierAdapter() : new UnconfiguredSupplierAdapter());
