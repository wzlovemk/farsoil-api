-- v6: permanent account sessions are defined in auth-schema.sql only.
-- Wallet, inventory, auction, bid and request history are userId-owned.
CREATE TABLE IF NOT EXISTS markets (
  market_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
  is_mock_npc INTEGER NOT NULL DEFAULT 0 CHECK(is_mock_npc IN (0,1))
);
CREATE INDEX IF NOT EXISTS users_market ON users(market_id);
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  total_gold INTEGER NOT NULL CHECK(total_gold>=0),
  reserved_gold INTEGER NOT NULL CHECK(reserved_gold>=0 AND reserved_gold<=total_gold)
);
CREATE TABLE IF NOT EXISTS inventories (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units>=0),
  PRIMARY KEY(user_id,item_id)
);
CREATE TABLE IF NOT EXISTS auctions (
  auction_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
  seller_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units>0),
  start_unit_price_gold INTEGER NOT NULL CHECK(start_unit_price_gold>0),
  start_price_gold INTEGER NOT NULL CHECK(start_price_gold>0),
  highest_bid_gold INTEGER,
  highest_bidder_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  bid_count INTEGER NOT NULL DEFAULT 0,
  buyout_price_gold INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS auctions_browse ON auctions(market_id,status,expires_at_ms);
CREATE INDEX IF NOT EXISTS auctions_seller ON auctions(market_id,seller_user_id,status);
CREATE TABLE IF NOT EXISTS bids (
  bid_id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(auction_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  bid_gold INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bids_mine ON bids(user_id,created_at_ms);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(user_id,operation,idempotency_key)
);
