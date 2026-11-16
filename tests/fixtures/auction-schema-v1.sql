CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wallets (
  session_id TEXT NOT NULL, account_id TEXT NOT NULL,
  total_gold INTEGER NOT NULL CHECK(total_gold>=0),
  reserved_gold INTEGER NOT NULL CHECK(reserved_gold>=0 AND reserved_gold<=total_gold),
  PRIMARY KEY(session_id,account_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS inventories (
  session_id TEXT NOT NULL, account_id TEXT NOT NULL, item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units>=0),
  PRIMARY KEY(session_id,account_id,item_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS auctions (
  auction_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  seller_account_id TEXT NOT NULL, item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units>0),
  start_unit_price_gold INTEGER NOT NULL CHECK(start_unit_price_gold>0),
  start_price_gold INTEGER NOT NULL CHECK(start_price_gold>0),
  highest_bid_gold INTEGER, highest_bidder_id TEXT,
  bid_count INTEGER NOT NULL DEFAULT 0,
  buyout_price_gold INTEGER, created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
  status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS auctions_browse ON auctions(session_id,status,expires_at_ms);
CREATE INDEX IF NOT EXISTS auctions_seller ON auctions(session_id,seller_account_id,status);
CREATE TABLE IF NOT EXISTS bids (
  bid_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, auction_id TEXT NOT NULL,
  account_id TEXT NOT NULL, bid_gold INTEGER NOT NULL,
  state TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(auction_id) REFERENCES auctions(auction_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bids_mine ON bids(session_id,account_id,created_at_ms);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL, status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(session_id,operation,idempotency_key),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
