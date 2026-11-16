-- P15 node 1: formal manufactured assets never mix with AH-V1 demo fixtures.
-- Wallet ownership remains global userId; only manufactured items have worldId.
CREATE TABLE IF NOT EXISTS p15_world_inventories (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units >= 0),
  PRIMARY KEY (user_id, world_id, item_id)
);
CREATE TABLE IF NOT EXISTS p15_machines (
  machine_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  building_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RETIRED')),
  registered_at_ms INTEGER NOT NULL,
  UNIQUE(user_id,world_id,building_id)
);
CREATE INDEX IF NOT EXISTS p15_machines_owner ON p15_machines(user_id,world_id,status);
CREATE TABLE IF NOT EXISTS p15_batches (
  batch_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES p15_machines(machine_id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ready_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS p15_one_running_batch_per_machine ON p15_batches(machine_id) WHERE status='RUNNING';
CREATE INDEX IF NOT EXISTS p15_batches_due ON p15_batches(user_id,world_id,status,ready_at_ms);
CREATE TABLE IF NOT EXISTS p15_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(user_id,operation,idempotency_key)
);
CREATE TABLE IF NOT EXISTS p15_finance_records (
  record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units > 0),
  gold_delta INTEGER NOT NULL CHECK(gold_delta > 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(record_id)
);
CREATE INDEX IF NOT EXISTS p15_finance_owner ON p15_finance_records(user_id,created_at_ms);
