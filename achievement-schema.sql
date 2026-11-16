-- ACH-02 / schema v7: permanent account-owned achievement records.
CREATE TABLE IF NOT EXISTS user_achievement_progress (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  achievement_id TEXT NOT NULL,
  condition_path TEXT NOT NULL,
  value_micro TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY(user_id,achievement_id,condition_path)
);
CREATE TABLE IF NOT EXISTS user_achievement_distinct (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  achievement_id TEXT NOT NULL,
  condition_path TEXT NOT NULL,
  distinct_value TEXT NOT NULL,
  PRIMARY KEY(user_id,achievement_id,condition_path,distinct_value)
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  achievement_id TEXT NOT NULL,
  unlocked_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,achievement_id)
);
CREATE INDEX IF NOT EXISTS user_achievements_recent ON user_achievements(user_id,unlocked_at_ms DESC);
CREATE TABLE IF NOT EXISTS achievement_event_receipts (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at_ms INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(user_id,event_id)
);
CREATE TABLE IF NOT EXISTS achievement_event_sources (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY(user_id,world_id,event_type,source_operation_id)
);
CREATE TABLE IF NOT EXISTS achievement_batch_receipts (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  processed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,idempotency_key)
);
