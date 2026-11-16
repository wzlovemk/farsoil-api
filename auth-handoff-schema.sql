-- ACCOUNT OAuth desktop handoff v10.  Never store tokens or raw client secrets.
CREATE TABLE IF NOT EXISTS auth_handoffs (
  login_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','steam')),
  proof_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  user_id TEXT REFERENCES account_users(user_id) ON DELETE RESTRICT,
  redeemed_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS auth_handoffs_expiry ON auth_handoffs(expires_at_ms);
