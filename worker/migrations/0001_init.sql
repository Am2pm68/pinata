-- TOiAF LIVE auto-post control plane -- initial schema.
--
-- Design notes that matter:
--  * outbound_intents.idempotency_key carries a UNIQUE constraint. It is the
--    single hard guarantee that a retry, a reboot, a double cron fire or a
--    redelivered queue message can never produce a second social post.
--  * live_sessions is keyed on (creator_id, provider_room_id, session_start_epoch)
--    so a brief disconnect/reconnect resolves to the SAME row rather than a new
--    session, which is what keeps flapping from re-announcing a show.
--  * Nothing here stores protected media, signed URLs or customer data.

CREATE TABLE creators (
  creator_id            TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  handle_x              TEXT,
  handle_telegram       TEXT,
  handle_bluesky        TEXT,
  niche                 TEXT,                     -- primary in copy
  country               TEXT,                     -- secondary in copy
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  public_surface_url    TEXT,                     -- resolver step 2
  approval_status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK (approval_status IN ('pending','approved','suspended')),
  mapping_status        TEXT NOT NULL DEFAULT 'unmapped'
                          CHECK (mapping_status IN ('unmapped','confirmed','ambiguous')),
  live_promotion_enabled INTEGER NOT NULL DEFAULT 0,
  auto_post_x           INTEGER NOT NULL DEFAULT 0,
  auto_post_telegram    INTEGER NOT NULL DEFAULT 0,
  auto_post_bluesky     INTEGER NOT NULL DEFAULT 0,
  copy_defaults_json    TEXT,
  revoked_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- One creator may legitimately hold more than one provider room. The reverse is
-- not allowed: a room resolving to two creators is an ambiguous mapping and is
-- fail-closed at send time.
CREATE TABLE provider_identities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id            TEXT NOT NULL REFERENCES creators(creator_id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  provider_room_id      TEXT NOT NULL,
  provider_username     TEXT NOT NULL,
  is_primary            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  UNIQUE (provider, provider_room_id)
);
CREATE INDEX idx_provider_identities_creator ON provider_identities(creator_id);

-- Schedules are only ever recorded from a real source. There is deliberately no
-- 'inferred' source: we never invent a schedule from historical behaviour.
CREATE TABLE schedules (
  schedule_id           TEXT PRIMARY KEY,
  creator_id            TEXT NOT NULL REFERENCES creators(creator_id) ON DELETE CASCADE,
  starts_at_utc         INTEGER NOT NULL,
  source_timezone       TEXT NOT NULL,
  source                TEXT NOT NULL CHECK (source IN ('toiaf','provider','richgirls')),
  show_text             TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','cancelled','fulfilled')),
  session_id            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(status, starts_at_utc);
CREATE INDEX idx_schedules_creator ON schedules(creator_id, starts_at_utc);

CREATE TABLE live_sessions (
  session_id            TEXT PRIMARY KEY,
  creator_id            TEXT NOT NULL REFERENCES creators(creator_id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  provider_room_id      TEXT NOT NULL,
  provider_username     TEXT,
  session_start_epoch   INTEGER NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('detected','confirmed','ended')),
  first_seen_live       INTEGER NOT NULL,
  confirmed_live_at     INTEGER,
  last_seen_live        INTEGER NOT NULL,
  ended_at              INTEGER,
  consecutive_online    INTEGER NOT NULL DEFAULT 0,
  consecutive_offline   INTEGER NOT NULL DEFAULT 0,
  evidence_class        TEXT NOT NULL DEFAULT 'provider_api',
  show_text             TEXT,
  provider_payload_hash TEXT,
  suppressed_reason     TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (creator_id, provider_room_id, session_start_epoch)
);
CREATE INDEX idx_live_sessions_open ON live_sessions(state, last_seen_live);
CREATE INDEX idx_live_sessions_room ON live_sessions(provider, provider_room_id, state);
CREATE INDEX idx_live_sessions_creator ON live_sessions(creator_id, state);

-- The outbound intent model. Extends the existing broadcaster intent shape.
CREATE TABLE outbound_intents (
  intent_id             TEXT PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  type                  TEXT NOT NULL DEFAULT 'live_event'
                          CHECK (type IN ('live_event','promo_post')),
  creator_id            TEXT,
  provider_room_id      TEXT,
  session_id            TEXT,
  schedule_id           TEXT,
  campaign_id           TEXT,
  event                 TEXT NOT NULL
                          CHECK (event IN ('scheduled','reminder','live_now','ended','replay','promo')),
  channel               TEXT NOT NULL
                          CHECK (channel IN ('x','telegram','bluesky','manual_x')),
  scheduled_at          INTEGER NOT NULL,
  caption               TEXT NOT NULL,
  caption_hash          TEXT NOT NULL,          -- normalised, for near-duplicate detection
  variant_id            TEXT,
  public_link           TEXT,
  public_asset_ref      TEXT,
  approval_mode         TEXT NOT NULL DEFAULT 'manual'
                          CHECK (approval_mode IN ('auto_live','manual')),
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','sending','sent','failed','skipped',
                                            'awaiting_manual','needs_attention','cancelled')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error_class      TEXT,
  last_error_message    TEXT,
  skip_reason           TEXT,
  provider_post_id      TEXT,
  estimated_cost_usd    REAL NOT NULL DEFAULT 0,
  sent_at               INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_intents_due ON outbound_intents(status, scheduled_at);
CREATE INDEX idx_intents_creator ON outbound_intents(creator_id, created_at);
CREATE INDEX idx_intents_session ON outbound_intents(session_id, event, channel);
CREATE INDEX idx_intents_dedupe ON outbound_intents(creator_id, channel, caption_hash, sent_at);
CREATE INDEX idx_intents_cost ON outbound_intents(channel, sent_at);

-- Canonical event/audit log.
CREATE TABLE events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type            TEXT NOT NULL,
  creator_id            TEXT,
  session_id            TEXT,
  schedule_id           TEXT,
  intent_id             TEXT,
  channel               TEXT,
  detail_json           TEXT,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_events_creator ON events(creator_id, created_at);
CREATE INDEX idx_events_session ON events(session_id, created_at);
CREATE INDEX idx_events_type ON events(event_type, created_at);

-- Registry of public-safe promo derivatives. An asset must be present here,
-- approved and watermarked before it may be attached to any social send.
-- Paid masters, protected sources, signed URLs and raw R2/HLS never appear here.
CREATE TABLE public_assets (
  asset_ref             TEXT PRIMARY KEY,
  creator_id            TEXT NOT NULL REFERENCES creators(creator_id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('card','gif','teaser')),
  watermarked           INTEGER NOT NULL DEFAULT 0,
  approved              INTEGER NOT NULL DEFAULT 0,
  derivative_of         TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_public_assets_creator ON public_assets(creator_id, approved, watermarked);

-- Every click-time resolution of a /go/live/{creator} link, including the
-- corrections made when the exact stream destination would have dead-ended.
CREATE TABLE link_resolutions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id            TEXT,
  session_id            TEXT,
  intent_id             TEXT,
  campaign_id           TEXT,
  requested_slug        TEXT NOT NULL,
  resolved_url          TEXT NOT NULL,
  resolution_step       INTEGER NOT NULL,       -- 1 stream | 2 profile | 3 niche | 4 /live/
  was_corrected         INTEGER NOT NULL DEFAULT 0,
  referer_host          TEXT,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_link_resolutions_creator ON link_resolutions(creator_id, created_at);
CREATE INDEX idx_link_resolutions_intent ON link_resolutions(intent_id);
CREATE INDEX idx_link_resolutions_corrected ON link_resolutions(was_corrected, created_at);

-- Real conversions only, delivered by an authenticated TOiAF callback.
-- Nothing in this system fabricates impressions or viewer counts.
CREATE TABLE conversions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id           TEXT,
  intent_id             TEXT,
  creator_id            TEXT,
  session_id            TEXT,
  kind                  TEXT NOT NULL,
  value_usd             REAL,
  external_ref          TEXT UNIQUE,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_conversions_creator ON conversions(creator_id, created_at);

-- Operator-flippable runtime state (emergency kill switch, budget counters).
-- Read failures are treated as "killed" by the guard layer.
CREATE TABLE runtime_flags (
  key                   TEXT PRIMARY KEY,
  value                 TEXT NOT NULL,
  updated_by            TEXT,
  updated_at            INTEGER NOT NULL
);

-- Standalone scheduled promotion (e.g. the ToiletFeed X campaign). Runs through
-- the same gates, dedupe, budget guard and audit trail as live announcements.
CREATE TABLE promo_campaigns (
  campaign_id           TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  creator_id            TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','completed','cancelled')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE promo_posts (
  promo_post_id         TEXT PRIMARY KEY,
  campaign_id           TEXT NOT NULL REFERENCES promo_campaigns(campaign_id) ON DELETE CASCADE,
  creator_id            TEXT,
  channel               TEXT NOT NULL CHECK (channel IN ('x','telegram','bluesky','manual_x')),
  scheduled_at          INTEGER NOT NULL,
  caption               TEXT NOT NULL,
  public_link           TEXT,
  public_asset_ref      TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','queued','cancelled')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_promo_posts_due ON promo_posts(status, scheduled_at);
CREATE INDEX idx_promo_posts_campaign ON promo_posts(campaign_id, scheduled_at);

-- Creator-owned X credentials, when TOiAF posts from a creator's OWN account.
-- OAuth tokens only. Browser cookies are never accepted as credentials.
CREATE TABLE creator_channel_auth (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id            TEXT NOT NULL REFERENCES creators(creator_id) ON DELETE CASCADE,
  channel               TEXT NOT NULL,
  auth_kind             TEXT NOT NULL CHECK (auth_kind IN ('oauth2_user','oauth1_user')),
  access_token          TEXT,
  refresh_token         TEXT,
  token_expires_at      INTEGER,
  scope                 TEXT,
  external_account_id   TEXT,
  wallet_grant_ref      TEXT,                   -- e.g. NFTOI SOCIAL_PUBLISH_X_LIVE_GRANTED
  revoked_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (creator_id, channel)
);
