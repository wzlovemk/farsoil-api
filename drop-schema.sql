-- DROP-01 / schema v9: immutable draw outcomes, including losses; no shadow inventory.
CREATE TABLE IF NOT EXISTS game_drop_rolls (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  roll_index INTEGER NOT NULL,
  won INTEGER NOT NULL CHECK(won IN (0,1)),
  item_id TEXT NOT NULL,
  reward_units TEXT NOT NULL,
  issued INTEGER NOT NULL DEFAULT 0 CHECK(issued IN (0,1)),
  rolled_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,world_id,source_event_type,source_operation_id,rule_id,rule_version,roll_index)
);
CREATE INDEX IF NOT EXISTS game_drop_rolls_by_user ON game_drop_rolls(user_id,rolled_at_ms DESC);
