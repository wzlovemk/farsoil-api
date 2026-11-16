-- ACCOUNT-V1-01 / v3: durable accounts are independent of short-lived demo markets.
CREATE TABLE IF NOT EXISTS account_users (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES account_users(user_id) ON DELETE RESTRICT,
  email_normalized TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_scheme TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_identities (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider,provider_subject)
);
CREATE INDEX IF NOT EXISTS account_identities_user ON account_identities(user_id);
CREATE TABLE IF NOT EXISTS account_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  access_expires_at_ms INTEGER NOT NULL,
  idle_expires_at_ms INTEGER NOT NULL,
  absolute_expires_at_ms INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('login','link')),
  initiating_user_id TEXT REFERENCES account_users(user_id) ON DELETE RESTRICT,
  return_intent TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
);
