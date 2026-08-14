CREATE TABLE idempotency_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, operation, key_hash)
);

CREATE INDEX idempotency_records_created_at_idx ON idempotency_records(created_at);