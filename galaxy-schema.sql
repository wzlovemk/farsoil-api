-- GAL-01B / SQLite v18: sovereign star systems, equal planets, hidden resource profiles, and registration idempotency.
-- V1 enforces one sovereign star system per formal userId, one formal owner per starId, and one system per worldId.
-- No permanent main_planet_id exists; active_planet_id is the current active planet pointer only.
CREATE TABLE IF NOT EXISTS galaxy_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS galaxy_systems (
  system_id TEXT PRIMARY KEY,
  star_id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL UNIQUE,
  star_name TEXT NOT NULL,
  system_seed INTEGER NOT NULL CHECK(system_seed >= 0 AND system_seed <= 4294967295),
  generation_version INTEGER NOT NULL CHECK(generation_version >= 1),
  x_ly REAL NOT NULL,
  y_ly REAL NOT NULL,
  sector_x INTEGER NOT NULL,
  sector_y INTEGER NOT NULL,
  star_visual_json TEXT NOT NULL,
  active_planet_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS galaxy_systems_sector_idx ON galaxy_systems(sector_x, sector_y);
CREATE INDEX IF NOT EXISTS galaxy_systems_created_idx ON galaxy_systems(created_at_ms, system_id);

CREATE TABLE IF NOT EXISTS galaxy_planets (
  planet_id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES galaxy_systems(system_id) ON DELETE RESTRICT,
  orbit_index INTEGER NOT NULL CHECK(orbit_index >= 1),
  display_name TEXT NOT NULL,
  orbit_radius_normalized REAL NOT NULL CHECK(orbit_radius_normalized > 0 AND orbit_radius_normalized <= 1),
  orbit_phase REAL NOT NULL CHECK(orbit_phase >= 0 AND orbit_phase < 6.283185307179587),
  planet_seed INTEGER NOT NULL CHECK(planet_seed >= 0 AND planet_seed <= 4294967295),
  visual_json TEXT NOT NULL,
  hidden_resource_profile_json TEXT NOT NULL,
  exploration_status TEXT NOT NULL CHECK(exploration_status IN ('unexplored', 'explored')),
  survey_status TEXT NOT NULL CHECK(survey_status IN ('unknown', 'scanned')),
  survey_result_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(system_id, orbit_index),
  CHECK(survey_status = 'unknown' OR survey_result_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS galaxy_planets_system_idx ON galaxy_planets(system_id, orbit_index);

CREATE TABLE IF NOT EXISTS galaxy_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(user_id, operation, idempotency_key)
);
