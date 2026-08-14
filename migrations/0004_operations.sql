CREATE TABLE rate_limits (
  scope_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (scope_hash, action, window_started_at)
);

CREATE INDEX orders_user_created_idx ON orders(user_id, created_at DESC);
CREATE INDEX payments_order_date_idx ON payments(order_id, payment_date DESC);