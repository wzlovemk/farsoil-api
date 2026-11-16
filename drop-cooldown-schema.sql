-- DROP-01 / SQLite v12: one real-time cooldown per permanent account.
CREATE TABLE IF NOT EXISTS game_drop_last_wins (
  user_id TEXT PRIMARY KEY REFERENCES account_users(user_id) ON DELETE RESTRICT,
  last_win_at_ms INTEGER NOT NULL CHECK(last_win_at_ms>=0)
);
-- A skipped action is terminal: no delayed lottery after cooldown.
CREATE TABLE IF NOT EXISTS game_drop_cooldown_skips (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  skipped_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,world_id,action_id)
);
CREATE INDEX IF NOT EXISTS game_drop_cooldown_skips_by_user ON game_drop_cooldown_skips(user_id,skipped_at_ms DESC);
