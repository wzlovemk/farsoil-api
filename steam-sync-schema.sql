-- ACH-07 / schema v8: Steam delivery is a durable server-only side effect.
-- Steam ID comes exclusively from verified account_identities(provider='steam').
CREATE TABLE IF NOT EXISTS steam_achievement_sync (
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  achievement_id TEXT NOT NULL,
  steam_id TEXT NOT NULL,
  api_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(state IN ('PENDING','IN_FLIGHT','RETRY','SYNCED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  last_error_code TEXT,
  synced_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,achievement_id,steam_id)
);
CREATE INDEX IF NOT EXISTS steam_achievement_due
  ON steam_achievement_sync(state,next_attempt_at_ms,lease_until_ms);
