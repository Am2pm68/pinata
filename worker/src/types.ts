/** Canonical event vocabulary for the live auto-post pipeline. */
export const EVENT_TYPES = [
  'LIVE_SCHEDULED',
  'LIVE_REMINDER_DUE',
  'LIVE_DETECTED',
  'LIVE_CONFIRMED',
  'LIVE_POST_QUEUED',
  'LIVE_POSTED',
  'LIVE_ENDED',
  'REPLAY_AVAILABLE',
  'POST_FAILED',
  'NEEDS_ATTENTION',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const CHANNELS = ['x', 'telegram', 'bluesky', 'manual_x'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels that carry an automated API send. `manual_x` is a human hand-off. */
export const AUTO_CHANNELS = ['x', 'telegram', 'bluesky'] as const;
export type AutoChannel = (typeof AUTO_CHANNELS)[number];

export type IntentEvent = 'scheduled' | 'reminder' | 'live_now' | 'ended' | 'replay' | 'promo';
export type IntentType = 'live_event' | 'promo_post';
export type IntentStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'awaiting_manual'
  | 'needs_attention'
  | 'cancelled';

export type SessionState = 'detected' | 'confirmed' | 'ended';
export type ScheduleSource = 'toiaf' | 'provider' | 'richgirls';

export interface Creator {
  creator_id: string;
  display_name: string;
  handle_x: string | null;
  handle_telegram: string | null;
  handle_bluesky: string | null;
  niche: string | null;
  country: string | null;
  timezone: string;
  public_surface_url: string | null;
  approval_status: 'pending' | 'approved' | 'suspended';
  mapping_status: 'unmapped' | 'confirmed' | 'ambiguous';
  live_promotion_enabled: number;
  auto_post_x: number;
  auto_post_telegram: number;
  auto_post_bluesky: number;
  copy_defaults_json: string | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderIdentity {
  id: number;
  creator_id: string;
  provider: string;
  provider_room_id: string;
  provider_username: string;
  is_primary: number;
  created_at: number;
}

export interface Schedule {
  schedule_id: string;
  creator_id: string;
  starts_at_utc: number;
  source_timezone: string;
  source: ScheduleSource;
  show_text: string | null;
  status: 'active' | 'cancelled' | 'fulfilled';
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface LiveSession {
  session_id: string;
  creator_id: string;
  provider: string;
  provider_room_id: string;
  provider_username: string | null;
  session_start_epoch: number;
  state: SessionState;
  first_seen_live: number;
  confirmed_live_at: number | null;
  last_seen_live: number;
  ended_at: number | null;
  consecutive_online: number;
  consecutive_offline: number;
  evidence_class: string;
  show_text: string | null;
  provider_payload_hash: string | null;
  suppressed_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface OutboundIntent {
  intent_id: string;
  idempotency_key: string;
  type: IntentType;
  creator_id: string | null;
  provider_room_id: string | null;
  session_id: string | null;
  schedule_id: string | null;
  campaign_id: string | null;
  event: IntentEvent;
  channel: Channel;
  scheduled_at: number;
  caption: string;
  caption_hash: string;
  variant_id: string | null;
  public_link: string | null;
  public_asset_ref: string | null;
  approval_mode: 'auto_live' | 'manual';
  status: IntentStatus;
  attempts: number;
  last_error_class: string | null;
  last_error_message: string | null;
  skip_reason: string | null;
  provider_post_id: string | null;
  estimated_cost_usd: number;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublicAsset {
  asset_ref: string;
  creator_id: string;
  url: string;
  kind: 'card' | 'gif' | 'teaser';
  watermarked: number;
  approved: number;
  derivative_of: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreatorChannelAuth {
  id: number;
  creator_id: string;
  channel: string;
  auth_kind: 'oauth2_user' | 'oauth1_user';
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  scope: string | null;
  external_account_id: string | null;
  wallet_grant_ref: string | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

/** One model as reported by the provider aggregator API. */
export interface ProviderLiveModel {
  provider_room_id: string;
  username: string;
  is_live: boolean;
  session_start_epoch: number | null;
  show_text: string | null;
  raw_hash: string;
}

/** Queue message body. Intentionally minimal: the row in D1 is the truth. */
export interface OutboundMessage {
  intent_id: string;
  idempotency_key: string;
  attempt_hint: number;
}

/** Result of one channel adapter send. */
export type SendResult =
  | { ok: true; provider_post_id: string | null; cost_usd: number }
  | { ok: false; retryable: boolean; error_class: string; message: string };
