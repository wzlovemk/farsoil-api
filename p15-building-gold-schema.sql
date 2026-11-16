-- Building gold ledger: one original paid construction per world/building and one payment per
-- actual upgrade step. Currency remains the account-wide wallets.p15_gold authority.
CREATE TABLE IF NOT EXISTS p15_building_gold (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  building_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('purchase','upgrade')),
  paid_gold INTEGER NOT NULL CHECK(paid_gold>0),
  status TEXT NOT NULL CHECK(status IN ('PREPARED','ACTIVE','REVERSED','REFUNDED')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,world_id,building_id,operation_key)
);
CREATE INDEX IF NOT EXISTS p15_building_gold_world
  ON p15_building_gold(user_id,world_id,status);
