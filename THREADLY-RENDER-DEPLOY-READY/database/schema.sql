-- PostgreSQL. Money columns are integer paise.
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE, phone TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (role IN ('CUSTOMER','ADMIN','SUPPORT','SUPPLIER')),
  created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ);
CREATE TABLE suppliers (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE','PAUSED','DISABLED')), api_endpoint TEXT, fulfillment_method TEXT, authorization_notes TEXT);
CREATE TABLE categories (id BIGSERIAL PRIMARY KEY, parent_id BIGINT REFERENCES categories(id), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL);
CREATE TABLE products (id BIGSERIAL PRIMARY KEY, supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  external_product_id TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT, license_metadata JSONB,
  category_id BIGINT REFERENCES categories(id), brand TEXT, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  description TEXT, mrp INT NOT NULL, status TEXT DEFAULT 'DRAFT', seo_title TEXT, seo_description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ, UNIQUE (supplier_id, external_product_id));
CREATE TABLE product_variants (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id),
  sku TEXT UNIQUE NOT NULL, color TEXT, size TEXT, price INT NOT NULL CHECK (price >= 0),
  supplier_variant_id TEXT, supplier_price INT,
  stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0), reserved INT NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= stock));
CREATE INDEX ON product_variants (product_id);
CREATE TABLE orders (id BIGSERIAL PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, user_id BIGINT REFERENCES users(id),
  subtotal INT NOT NULL, discount INT NOT NULL, platform_fee INT NOT NULL, delivery_fee INT NOT NULL, cod_fee INT NOT NULL,
  grand_total INT NOT NULL, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL, order_status TEXT NOT NULL,
  shipping_address JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE order_items (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id),
  variant_id BIGINT NOT NULL REFERENCES product_variants(id), supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  qty INT NOT NULL CHECK (qty > 0), unit_price INT NOT NULL, supplier_order_ref TEXT,
  fulfillment_status TEXT NOT NULL DEFAULT 'FULFILLMENT_PENDING');
CREATE TABLE payments (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id), provider TEXT,
  provider_payment_id TEXT UNIQUE, amount INT NOT NULL, status TEXT NOT NULL, webhook_verified_at TIMESTAMPTZ);
CREATE TABLE shipments (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id), courier TEXT,
  tracking_no TEXT, status TEXT NOT NULL DEFAULT 'PENDING');
CREATE TABLE tracking_events (id BIGSERIAL PRIMARY KEY, shipment_id BIGINT NOT NULL REFERENCES shipments(id),
  status TEXT NOT NULL, source TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL);
CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO platform_settings VALUES ('platform_fee','{"fee_type":"FIXED","fee_value":9600}'), ('brand_name','"THREADLY"');
CREATE TABLE audit_logs (id BIGSERIAL PRIMARY KEY, admin_id BIGINT REFERENCES users(id), action TEXT NOT NULL,
  old_value JSONB, new_value JSONB, created_at TIMESTAMPTZ DEFAULT now());
-- Remaining tables (addresses, carts, wishlists, coupons, reviews, returns, refunds, notifications, support_tickets)
-- follow in the next phase.
