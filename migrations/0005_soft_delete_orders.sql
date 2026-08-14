ALTER TABLE orders ADD COLUMN deleted_at TEXT;

CREATE INDEX orders_user_deleted_created_idx
  ON orders(user_id, deleted_at, created_at DESC);