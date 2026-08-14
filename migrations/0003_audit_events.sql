CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'order.created',
    'order.updated',
    'payment.recorded',
    'order.locked',
    'order.paid'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX audit_events_user_order_created_idx
  ON audit_events(user_id, order_id, created_at);

CREATE TRIGGER audit_events_prevent_update
BEFORE UPDATE ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENTS_ARE_IMMUTABLE');
END;

CREATE TRIGGER audit_events_prevent_delete
BEFORE DELETE ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_EVENTS_ARE_IMMUTABLE');
END;