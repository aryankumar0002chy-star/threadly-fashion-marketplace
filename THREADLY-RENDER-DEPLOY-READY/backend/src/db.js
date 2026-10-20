import { DatabaseSync } from 'node:sqlite';
import { SCHEMA2 } from './extra.js';
import { SCHEMA3 } from './more.js';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, type TEXT, value INT, min_order INT, max_discount INT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, slug TEXT UNIQUE, title TEXT, brand TEXT, category TEXT, gender TEXT,
  mrp INT, price INT, rating REAL, reviews INT, supplier TEXT, source TEXT DEFAULT 'DEMO_SEED');
CREATE TABLE IF NOT EXISTS variants(id INTEGER PRIMARY KEY, product_id INT REFERENCES products(id), sku TEXT UNIQUE, color TEXT, size TEXT,
  stock INT NOT NULL CHECK(stock>=0), reserved INT NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=stock));
CREATE TABLE IF NOT EXISTS orders(order_no TEXT PRIMARY KEY, payment_method TEXT, payment_status TEXT, status TEXT, subtotal INT, discount INT,
  platform_fee INT, delivery_fee INT, cod_fee INT, grand_total INT, address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_no TEXT REFERENCES orders(order_no), variant_id INT, qty INT, unit_price INT,
  supplier TEXT, fulfillment_status TEXT);
CREATE INDEX IF NOT EXISTS idx_prod_cat ON products(category); CREATE INDEX IF NOT EXISTS idx_var_prod ON variants(product_id);`;
const T = [['Oversized T-Shirt','T-Shirts','men',799,499],['Relaxed Shirt','Shirts','men',1299,899],['Straight Jeans','Jeans','men',1999,1299],
  ['Cargo Pants','Trousers','men',1799,1199],['Pullover Hoodie','Hoodies','men',1999,1399],['Crew Sweatshirt','Sweatshirts','women',1599,999],
  ['Wrap Dress','Dresses','women',2199,1499],['Ribbed Top','Tops','women',699,449],['Cotton Kurta','Kurtas','women',1499,999],
  ['Bomber Jacket','Jackets','men',2999,1999],['Fleece Joggers','Joggers','men',1299,849],['Canvas Cap','Accessories','men',499,349]];
const B = ['Threadly Basics','Northline','Kaya Studio','Urban Loom','Field & Co'], C = ['Black','White','Olive','Navy'], S = ['S','M','L','XL'];
export const DEFAULT_SETTINGS_ROWS = { platformFee: 9600, deliveryFee: 4900, freeDeliveryThreshold: 99900, codEnabled: true, codFee: 3000, codMin: 0, codMax: 5000000 };
export function openDb(file = ':memory:', seed = true) {
  const db = new DatabaseSync(file); db.exec(SCHEMA); db.exec(SCHEMA2); db.exec(SCHEMA3);
  // Idempotent start-up (so a restart on a persistent DB_FILE works): the user_id column was originally an unguarded ALTER TABLE.
  if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'user_id')) db.exec('ALTER TABLE orders ADD COLUMN user_id INT');
  // INSERT OR IGNORE: never overwrite settings an admin has changed.
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS_ROWS)) db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, JSON.stringify(v));
  db.prepare("INSERT OR IGNORE INTO coupons VALUES('WELCOME10','PERCENT',10,99900,30000)").run();
  // Seed the demo catalog only into an empty products table.
  if (seed && db.prepare('SELECT COUNT(*) c FROM products').get().c === 0) {
    let n = 0;
    for (let i = 0; i < 108; i++) {
      const [name, cat, g, mrp, price] = T[i % T.length], brand = B[i % B.length], color = C[i % 4];
      const title = `${brand} ${color} ${name}`, slug = `${title}-${i}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const r = db.prepare('INSERT INTO products(slug,title,brand,category,gender,mrp,price,rating,reviews,supplier) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(slug, title, brand, cat, g, mrp * 100, (price + (i % 5) * 10) * 100, 3.5 + (i % 15) / 10, 20 + i * 11, `DEMO-SUPPLIER-${(i % 3) + 1}`);
      S.forEach((s, j) => db.prepare('INSERT INTO variants(product_id,sku,color,size,stock) VALUES(?,?,?,?,?)').run(r.lastInsertRowid, `SKU-${++n}`, color, s, j === 3 && i % 4 === 0 ? 0 : 5 + (i + j) % 12));
    }
  }
  return db;
}
export const getSettings = (db) => Object.fromEntries(db.prepare('SELECT * FROM settings').all().map((r) => [r.key, JSON.parse(r.value)]));
