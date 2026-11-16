-- P15 next node: one outstanding server-to-local delivery per world.
-- Server stock is debited once at PREPARED; local Worker receipts use monotonic sequence.
CREATE TABLE IF NOT EXISTS p15_deliveries (
  delivery_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units>0),
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED')),
  created_at_ms INTEGER NOT NULL,
  confirmed_at_ms INTEGER,
  local_save_id TEXT,
  UNIQUE(user_id,world_id,sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS p15_one_pending_delivery_per_world
  ON p15_deliveries(user_id,world_id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS p15_delivery_world_seq
  ON p15_deliveries(user_id,world_id,sequence);
