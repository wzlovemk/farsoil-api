-- PROFILE-01 / SQLite v11. Non-destructive account-owned profile and verified-email ledger.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES account_users(user_id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  name_source TEXT NOT NULL CHECK(name_source IN ('default','google','player')),
  avatar_source TEXT NOT NULL CHECK(avatar_source IN ('default','google')),
  avatar_url TEXT,
  avatar_user_selected INTEGER NOT NULL DEFAULT 0 CHECK(avatar_user_selected IN (0,1)),
  email_conflict_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_emails (
  email_normalized TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('password','google','steam')),
  verified INTEGER NOT NULL CHECK(verified IN (0,1)),
  verification_provider TEXT CHECK(verification_provider IN ('google','steam')),
  provider_subject TEXT,
  verified_at_ms INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(verified=0 OR verified_at_ms IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS account_emails_owner_idx ON account_emails(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_emails_single_primary ON account_emails(user_id) WHERE is_primary=1;
-- Keep legacy password sign-in and old email verification facts exactly as they were.
INSERT OR IGNORE INTO account_emails(
  email_normalized,user_id,source,verified,verification_provider,
  provider_subject,verified_at_ms,is_primary,created_at_ms,updated_at_ms
)
SELECT email_normalized,user_id,'password',email_verified,NULL,NULL,
  CASE WHEN email_verified=1 THEN updated_at_ms ELSE NULL END,
  1,updated_at_ms,updated_at_ms FROM account_password_credentials;
