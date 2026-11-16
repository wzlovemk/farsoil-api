-- One irrevocable account charge per Worker service identity; records stay scoped to the owning account/world.
CREATE TABLE IF NOT EXISTS p15_respec_charges (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  farmer_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  paid_gold INTEGER NOT NULL CHECK(paid_gold>0),
  record_id TEXT NOT NULL UNIQUE REFERENCES p15_finance_records(record_id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,world_id,service_id)
);
CREATE INDEX IF NOT EXISTS p15_respec_owner ON p15_respec_charges(user_id,world_id,farmer_id);
