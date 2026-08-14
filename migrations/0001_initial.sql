PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer TEXT NOT NULL,
  due_date TEXT NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX orders_user_id_idx ON orders(user_id);
CREATE INDEX orders_user_due_date_idx ON orders(user_id, due_date);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 1),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents = quantity * unit_price_cents),
  position INTEGER NOT NULL CHECK (position >= 0)
);

CREATE INDEX order_items_order_id_idx ON order_items(order_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 1),
  payment_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX payments_order_id_idx ON payments(order_id);

CREATE TRIGGER payments_prevent_overpayment
BEFORE INSERT ON payments
FOR EACH ROW
WHEN COALESCE((SELECT SUM(amount_cents) FROM payments WHERE order_id = NEW.order_id), 0)
  + NEW.amount_cents
  > (SELECT total_cents FROM orders WHERE id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_EXCEEDS_ORDER_BALANCE');
END;

CREATE TRIGGER orders_lock_after_payment
BEFORE UPDATE ON orders
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LOCKED_AFTER_PAYMENT');
END;

CREATE TRIGGER orders_prevent_paid_delete
BEFORE DELETE ON orders
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LOCKED_AFTER_PAYMENT');
END;

CREATE TRIGGER order_items_prevent_paid_insert
BEFORE INSERT ON order_items
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM payments WHERE order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LOCKED_AFTER_PAYMENT');
END;

CREATE TRIGGER order_items_prevent_paid_update
BEFORE UPDATE ON order_items
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.order_id)
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LOCKED_AFTER_PAYMENT');
END;

CREATE TRIGGER order_items_prevent_paid_delete
BEFORE DELETE ON order_items
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.order_id)
BEGIN
  SELECT RAISE(ABORT, 'ORDER_LOCKED_AFTER_PAYMENT');
END;