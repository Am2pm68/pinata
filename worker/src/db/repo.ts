import type {
  Channel,
  Creator,
  CreatorChannelAuth,
  IntentEvent,
  IntentStatus,
  IntentType,
  LiveSession,
  OutboundIntent,
  ProviderIdentity,
  PublicAsset,
  Schedule,
  SessionState,
} from '../types';
import { monthStart, nowSec } from '../lib/time';

/** A provider identity joined to the creator that owns it. */
export interface MappedIdentity extends ProviderIdentity {
  creator: Creator;
}

export class Repo {
  constructor(private readonly db: D1Database) {}

  // ---------------------------------------------------------------- creators

  async getCreator(creatorId: string): Promise<Creator | null> {
    return this.db
      .prepare('SELECT * FROM creators WHERE creator_id = ?')
      .bind(creatorId)
      .first<Creator>();
  }

  /**
   * Every identity we are willing to poll: approved, confirmed mapping, live
   * promotion on, not revoked. Anything else never even reaches detection.
   */
  async listPollableIdentities(provider: string): Promise<MappedIdentity[]> {
    const { results } = await this.db
      .prepare(
        `SELECT pi.*, c.creator_id AS c_creator_id
           FROM provider_identities pi
           JOIN creators c ON c.creator_id = pi.creator_id
          WHERE pi.provider = ?
            AND c.approval_status = 'approved'
            AND c.mapping_status = 'confirmed'
            AND c.live_promotion_enabled = 1
            AND c.revoked_at IS NULL`,
      )
      .bind(provider)
      .all<ProviderIdentity & { c_creator_id: string }>();

    const out: MappedIdentity[] = [];
    for (const row of results ?? []) {
      const creator = await this.getCreator(row.creator_id);
      if (creator) out.push({ ...row, creator });
    }
    return out;
  }

  async countIdentitiesForRoom(provider: string, providerRoomId: string): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM provider_identities WHERE provider = ? AND provider_room_id = ?',
      )
      .bind(provider, providerRoomId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Resolve a public /go/live/{slug} to a creator by id or provider username. */
  async findCreatorBySlug(slug: string): Promise<Creator | null> {
    const direct = await this.getCreator(slug);
    if (direct) return direct;
    return this.db
      .prepare(
        `SELECT c.* FROM creators c
           JOIN provider_identities pi ON pi.creator_id = c.creator_id
          WHERE lower(pi.provider_username) = lower(?)
          ORDER BY pi.is_primary DESC LIMIT 1`,
      )
      .bind(slug)
      .first<Creator>();
  }

  async updateCreatorSettings(
    creatorId: string,
    patch: Partial<
      Pick<
        Creator,
        | 'live_promotion_enabled'
        | 'auto_post_x'
        | 'auto_post_telegram'
        | 'auto_post_bluesky'
        | 'copy_defaults_json'
        | 'timezone'
        | 'niche'
        | 'public_surface_url'
      >
    >,
  ): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(nowSec(), creatorId);
    await this.db
      .prepare(`UPDATE creators SET ${fields.join(', ')} WHERE creator_id = ?`)
      .bind(...values)
      .run();
  }

  /**
   * Revoke is immediate and retroactive: the creator's flags go off AND every
   * intent still sitting in the queue for them is cancelled in the same call.
   * That is what makes "disable auto-post one minute before send" actually stop
   * the send rather than merely stop the next one.
   */
  async revokeCreator(creatorId: string, reason: string): Promise<number> {
    const ts = nowSec();
    await this.db
      .prepare(
        `UPDATE creators
            SET live_promotion_enabled = 0, auto_post_x = 0, auto_post_telegram = 0,
                auto_post_bluesky = 0, revoked_at = ?, updated_at = ?
          WHERE creator_id = ?`,
      )
      .bind(ts, ts, creatorId)
      .run();
    const res = await this.db
      .prepare(
        `UPDATE outbound_intents
            SET status = 'cancelled', skip_reason = ?, updated_at = ?
          WHERE creator_id = ? AND status IN ('queued','awaiting_manual')`,
      )
      .bind(reason, ts, creatorId)
      .run();
    return res.meta.changes ?? 0;
  }

  async getChannelAuth(creatorId: string, channel: string): Promise<CreatorChannelAuth | null> {
    return this.db
      .prepare(
        'SELECT * FROM creator_channel_auth WHERE creator_id = ? AND channel = ? AND revoked_at IS NULL',
      )
      .bind(creatorId, channel)
      .first<CreatorChannelAuth>();
  }

  async updateChannelAuthTokens(
    id: number,
    patch: { access_token: string; refresh_token: string | null; token_expires_at: number | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE creator_channel_auth
            SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(patch.access_token, patch.refresh_token, patch.token_expires_at, nowSec(), id)
      .run();
  }

  async revokeChannelAuth(creatorId: string, channel: string): Promise<void> {
    const ts = nowSec();
    await this.db
      .prepare(
        `UPDATE creator_channel_auth SET revoked_at = ?, access_token = NULL, refresh_token = NULL,
                updated_at = ? WHERE creator_id = ? AND channel = ?`,
      )
      .bind(ts, ts, creatorId, channel)
      .run();
  }

  /** Bump updated_at so the cron sweep does not republish the same intent hot. */
  async touchIntentEnqueued(intentId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE outbound_intents SET updated_at = ? WHERE intent_id = ?`)
      .bind(nowSec(), intentId)
      .run();
  }

  // --------------------------------------------------------------- schedules

  async createSchedule(s: Omit<Schedule, 'created_at' | 'updated_at'>): Promise<void> {
    const ts = nowSec();
    await this.db
      .prepare(
        `INSERT INTO schedules (schedule_id, creator_id, starts_at_utc, source_timezone, source,
                                show_text, status, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        s.schedule_id,
        s.creator_id,
        s.starts_at_utc,
        s.source_timezone,
        s.source,
        s.show_text,
        s.status,
        s.session_id,
        ts,
        ts,
      )
      .run();
  }

  async getSchedule(scheduleId: string): Promise<Schedule | null> {
    return this.db
      .prepare('SELECT * FROM schedules WHERE schedule_id = ?')
      .bind(scheduleId)
      .first<Schedule>();
  }

  /** Active schedules starting inside the window, for reminder/announce planning. */
  async listActiveSchedulesInWindow(fromUtc: number, toUtc: number): Promise<Schedule[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM schedules
          WHERE status = 'active' AND starts_at_utc >= ? AND starts_at_utc <= ?
          ORDER BY starts_at_utc ASC`,
      )
      .bind(fromUtc, toUtc)
      .all<Schedule>();
    return results ?? [];
  }

  async nextActiveSchedule(creatorId: string, afterUtc: number): Promise<Schedule | null> {
    return this.db
      .prepare(
        `SELECT * FROM schedules
          WHERE creator_id = ? AND status = 'active' AND starts_at_utc >= ?
          ORDER BY starts_at_utc ASC LIMIT 1`,
      )
      .bind(creatorId, afterUtc)
      .first<Schedule>();
  }

  async setScheduleStatus(
    scheduleId: string,
    status: Schedule['status'],
    sessionId?: string | null,
  ): Promise<void> {
    await this.db
      .prepare('UPDATE schedules SET status = ?, session_id = ?, updated_at = ? WHERE schedule_id = ?')
      .bind(status, sessionId ?? null, nowSec(), scheduleId)
      .run();
  }

  /**
   * The schedule a just-started session most plausibly fulfils: same creator,
   * active, starting within +/- tolerance of the actual start. Covers a creator
   * going live early or late without inventing a link that is not there.
   */
  async findScheduleForSession(
    creatorId: string,
    startedAt: number,
    toleranceSec: number,
  ): Promise<Schedule | null> {
    return this.db
      .prepare(
        `SELECT * FROM schedules
          WHERE creator_id = ? AND status = 'active'
            AND starts_at_utc BETWEEN ? AND ?
          ORDER BY ABS(starts_at_utc - ?) ASC LIMIT 1`,
      )
      .bind(creatorId, startedAt - toleranceSec, startedAt + toleranceSec, startedAt)
      .first<Schedule>();
  }

  // ----------------------------------------------------------- live sessions

  /** The one non-ended session for a room, if any. */
  async getOpenSessionForRoom(
    provider: string,
    providerRoomId: string,
  ): Promise<LiveSession | null> {
    return this.db
      .prepare(
        `SELECT * FROM live_sessions
          WHERE provider = ? AND provider_room_id = ? AND state != 'ended'
          ORDER BY session_start_epoch DESC LIMIT 1`,
      )
      .bind(provider, providerRoomId)
      .first<LiveSession>();
  }

  async getSession(sessionId: string): Promise<LiveSession | null> {
    return this.db
      .prepare('SELECT * FROM live_sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<LiveSession>();
  }

  async getConfirmedSessionForCreator(creatorId: string): Promise<LiveSession | null> {
    return this.db
      .prepare(
        `SELECT * FROM live_sessions
          WHERE creator_id = ? AND state = 'confirmed'
          ORDER BY confirmed_live_at DESC LIMIT 1`,
      )
      .bind(creatorId)
      .first<LiveSession>();
  }

  /** Any non-ended session on a *different* room for the same creator. */
  async getOtherOpenSessionForCreator(
    creatorId: string,
    exceptRoomId: string,
  ): Promise<LiveSession | null> {
    return this.db
      .prepare(
        `SELECT * FROM live_sessions
          WHERE creator_id = ? AND provider_room_id != ? AND state != 'ended'
          ORDER BY first_seen_live ASC LIMIT 1`,
      )
      .bind(creatorId, exceptRoomId)
      .first<LiveSession>();
  }

  /**
   * Insert-or-ignore, so two cron fires racing on the same newly-live room
   * produce one session rather than two. Returns true when this call created it.
   */
  async insertSessionIfAbsent(s: {
    session_id: string;
    creator_id: string;
    provider: string;
    provider_room_id: string;
    provider_username: string | null;
    session_start_epoch: number;
    first_seen_live: number;
    show_text: string | null;
    provider_payload_hash: string | null;
    evidence_class: string;
    suppressed_reason: string | null;
  }): Promise<boolean> {
    const ts = nowSec();
    const res = await this.db
      .prepare(
        `INSERT INTO live_sessions
           (session_id, creator_id, provider, provider_room_id, provider_username,
            session_start_epoch, state, first_seen_live, last_seen_live,
            consecutive_online, consecutive_offline, evidence_class, show_text,
            provider_payload_hash, suppressed_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'detected', ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(creator_id, provider_room_id, session_start_epoch) DO NOTHING`,
      )
      .bind(
        s.session_id,
        s.creator_id,
        s.provider,
        s.provider_room_id,
        s.provider_username,
        s.session_start_epoch,
        s.first_seen_live,
        s.first_seen_live,
        s.evidence_class,
        s.show_text,
        s.provider_payload_hash,
        s.suppressed_reason,
        ts,
        ts,
      )
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Still online: bump the online streak, clear the offline streak. */
  async touchSessionOnline(
    sessionId: string,
    seenAt: number,
    showText: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE live_sessions
            SET consecutive_online = consecutive_online + 1,
                consecutive_offline = 0,
                last_seen_live = ?,
                show_text = COALESCE(?, show_text),
                updated_at = ?
          WHERE session_id = ?`,
      )
      .bind(seenAt, showText, nowSec(), sessionId)
      .run();
  }

  /** Missing from the provider feed: bump the offline streak, keep the session. */
  async touchSessionOffline(sessionId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE live_sessions
            SET consecutive_offline = consecutive_offline + 1,
                consecutive_online = 0,
                updated_at = ?
          WHERE session_id = ?`,
      )
      .bind(nowSec(), sessionId)
      .run();
  }

  /**
   * Promote to confirmed exactly once. The `state = 'detected'` predicate is the
   * guard: a second concurrent confirm changes zero rows and sends nothing.
   */
  async confirmSession(sessionId: string, confirmedAt: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE live_sessions
            SET state = 'confirmed', confirmed_live_at = ?, updated_at = ?
          WHERE session_id = ? AND state = 'detected'`,
      )
      .bind(confirmedAt, nowSec(), sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async endSession(sessionId: string, endedAt: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE live_sessions
            SET state = 'ended', ended_at = ?, updated_at = ?
          WHERE session_id = ? AND state != 'ended'`,
      )
      .bind(endedAt, nowSec(), sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async listOpenSessions(provider: string): Promise<LiveSession[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM live_sessions WHERE provider = ? AND state != 'ended'`)
      .bind(provider)
      .all<LiveSession>();
    return results ?? [];
  }

  async listSessionsByState(state: SessionState, limit = 100): Promise<LiveSession[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM live_sessions WHERE state = ? ORDER BY first_seen_live DESC LIMIT ?')
      .bind(state, limit)
      .all<LiveSession>();
    return results ?? [];
  }

  /** Most recent completed session, used by the minimum-interval spam guard. */
  async lastEndedSessionBefore(creatorId: string, beforeEpoch: number): Promise<LiveSession | null> {
    return this.db
      .prepare(
        `SELECT * FROM live_sessions
          WHERE creator_id = ? AND state = 'ended' AND session_start_epoch < ?
          ORDER BY session_start_epoch DESC LIMIT 1`,
      )
      .bind(creatorId, beforeEpoch)
      .first<LiveSession>();
  }

  // ----------------------------------------------------------------- intents

  /**
   * Claim an idempotency key. UNIQUE + ON CONFLICT DO NOTHING means the first
   * caller wins and every subsequent caller -- retry, reboot, redelivery, a
   * second cron in the same minute -- gets `false` and posts nothing.
   */
  async insertIntentIfAbsent(i: {
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
    estimated_cost_usd: number;
  }): Promise<boolean> {
    const ts = nowSec();
    const res = await this.db
      .prepare(
        `INSERT INTO outbound_intents
           (intent_id, idempotency_key, type, creator_id, provider_room_id, session_id,
            schedule_id, campaign_id, event, channel, scheduled_at, caption, caption_hash,
            variant_id, public_link, public_asset_ref, approval_mode, status,
            estimated_cost_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(
        i.intent_id,
        i.idempotency_key,
        i.type,
        i.creator_id,
        i.provider_room_id,
        i.session_id,
        i.schedule_id,
        i.campaign_id,
        i.event,
        i.channel,
        i.scheduled_at,
        i.caption,
        i.caption_hash,
        i.variant_id,
        i.public_link,
        i.public_asset_ref,
        i.approval_mode,
        i.status,
        i.estimated_cost_usd,
        ts,
        ts,
      )
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async getIntent(intentId: string): Promise<OutboundIntent | null> {
    return this.db
      .prepare('SELECT * FROM outbound_intents WHERE intent_id = ?')
      .bind(intentId)
      .first<OutboundIntent>();
  }

  async getIntentByKey(key: string): Promise<OutboundIntent | null> {
    return this.db
      .prepare('SELECT * FROM outbound_intents WHERE idempotency_key = ?')
      .bind(key)
      .first<OutboundIntent>();
  }

  /**
   * Take ownership of an intent for one send attempt. Only a queued or
   * previously-failed intent can be claimed, and only once -- a redelivered
   * queue message finds zero rows changed and acks without sending.
   */
  async claimIntentForSend(intentId: string): Promise<OutboundIntent | null> {
    const res = await this.db
      .prepare(
        `UPDATE outbound_intents
            SET status = 'sending', attempts = attempts + 1, updated_at = ?
          WHERE intent_id = ? AND status IN ('queued','failed')`,
      )
      .bind(nowSec(), intentId)
      .run();
    if ((res.meta.changes ?? 0) === 0) return null;
    return this.getIntent(intentId);
  }

  async markIntentSent(
    intentId: string,
    providerPostId: string | null,
    costUsd: number,
  ): Promise<void> {
    const ts = nowSec();
    await this.db
      .prepare(
        `UPDATE outbound_intents
            SET status = 'sent', provider_post_id = ?, sent_at = ?,
                estimated_cost_usd = ?, last_error_class = NULL,
                last_error_message = NULL, updated_at = ?
          WHERE intent_id = ?`,
      )
      .bind(providerPostId, ts, costUsd, ts, intentId)
      .run();
  }

  async markIntentFailed(
    intentId: string,
    errorClass: string,
    message: string,
    terminal: boolean,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE outbound_intents
            SET status = ?, last_error_class = ?, last_error_message = ?, updated_at = ?
          WHERE intent_id = ?`,
      )
      .bind(
        terminal ? 'needs_attention' : 'failed',
        errorClass,
        message.slice(0, 500),
        nowSec(),
        intentId,
      )
      .run();
  }

  async markIntentSkipped(intentId: string, reason: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE outbound_intents SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE intent_id = ?`,
      )
      .bind(reason, nowSec(), intentId)
      .run();
  }

  async markIntentAwaitingManual(intentId: string, reason: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE outbound_intents SET status = 'awaiting_manual', skip_reason = ?, updated_at = ? WHERE intent_id = ?`,
      )
      .bind(reason, nowSec(), intentId)
      .run();
  }

  /**
   * True when this session/event/channel already has an announcement that is
   * alive -- queued, in flight, parked for a human, or sent. Only `skipped` and
   * `cancelled` rows are dead and therefore ignorable.
   *
   * `excludeIntentId` exists because the send path calls this while its own row
   * is already `sending`; without it every send would find itself and stop.
   */
  async hasSentForSession(
    sessionId: string,
    event: IntentEvent,
    channel: Channel,
    excludeIntentId?: string | null,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM outbound_intents
          WHERE session_id = ? AND event = ? AND channel = ?
            AND status NOT IN ('skipped','cancelled')
            AND (? IS NULL OR intent_id != ?) LIMIT 1`,
      )
      .bind(sessionId, event, channel, excludeIntentId ?? null, excludeIntentId ?? null)
      .first<{ hit: number }>();
    return row != null;
  }

  /** Near-duplicate guard: same normalised copy, same creator+channel, recently. */
  async hasRecentCaptionHash(
    creatorId: string,
    channel: Channel,
    captionHash: string,
    sinceEpoch: number,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM outbound_intents
          WHERE creator_id = ? AND channel = ? AND caption_hash = ?
            AND status = 'sent' AND sent_at >= ? LIMIT 1`,
      )
      .bind(creatorId, channel, captionHash, sinceEpoch)
      .first<{ hit: number }>();
    return row != null;
  }

  async listIntentsForCreator(creatorId: string, limit = 50): Promise<OutboundIntent[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM outbound_intents WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .bind(creatorId, limit)
      .all<OutboundIntent>();
    return results ?? [];
  }

  /** Queued intents whose scheduled time has arrived. */
  async listDueIntents(nowEpoch: number, limit = 100): Promise<OutboundIntent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM outbound_intents
          WHERE status = 'queued' AND scheduled_at <= ?
          ORDER BY scheduled_at ASC LIMIT ?`,
      )
      .bind(nowEpoch, limit)
      .all<OutboundIntent>();
    return results ?? [];
  }

  /** Month-to-date committed X spend, for the budget guard. */
  async channelSpendThisMonth(channel: Channel, nowEpoch: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
           FROM outbound_intents
          WHERE channel = ? AND status = 'sent' AND sent_at >= ?`,
      )
      .bind(channel, monthStart(nowEpoch))
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  // ------------------------------------------------------------------ events

  async appendEvent(e: {
    event_type: string;
    creator_id?: string | null;
    session_id?: string | null;
    schedule_id?: string | null;
    intent_id?: string | null;
    channel?: string | null;
    detail?: unknown;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO events (event_type, creator_id, session_id, schedule_id, intent_id,
                             channel, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        e.event_type,
        e.creator_id ?? null,
        e.session_id ?? null,
        e.schedule_id ?? null,
        e.intent_id ?? null,
        e.channel ?? null,
        e.detail === undefined ? null : JSON.stringify(e.detail),
        nowSec(),
      )
      .run();
  }

  // ---------------------------------------------------------- public assets

  async getPublicAsset(assetRef: string): Promise<PublicAsset | null> {
    return this.db
      .prepare('SELECT * FROM public_assets WHERE asset_ref = ?')
      .bind(assetRef)
      .first<PublicAsset>();
  }

  async latestApprovedAsset(creatorId: string): Promise<PublicAsset | null> {
    return this.db
      .prepare(
        `SELECT * FROM public_assets
          WHERE creator_id = ? AND approved = 1 AND watermarked = 1
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(creatorId)
      .first<PublicAsset>();
  }

  // --------------------------------------------------------- runtime flags

  async getFlag(key: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT value FROM runtime_flags WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setFlag(key: string, value: string, updatedBy: string): Promise<void> {
    const ts = nowSec();
    await this.db
      .prepare(
        `INSERT INTO runtime_flags (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_by = excluded.updated_by,
                                        updated_at = excluded.updated_at`,
      )
      .bind(key, value, updatedBy, ts)
      .run();
  }

  // ------------------------------------------------------------- analytics

  async recordLinkResolution(r: {
    creator_id: string | null;
    session_id: string | null;
    intent_id: string | null;
    campaign_id: string | null;
    requested_slug: string;
    resolved_url: string;
    resolution_step: number;
    was_corrected: number;
    referer_host: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO link_resolutions
           (creator_id, session_id, intent_id, campaign_id, requested_slug, resolved_url,
            resolution_step, was_corrected, referer_host, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.creator_id,
        r.session_id,
        r.intent_id,
        r.campaign_id,
        r.requested_slug,
        r.resolved_url,
        r.resolution_step,
        r.was_corrected,
        r.referer_host,
        nowSec(),
      )
      .run();
  }

  async recordConversion(c: {
    campaign_id: string | null;
    intent_id: string | null;
    creator_id: string | null;
    session_id: string | null;
    kind: string;
    value_usd: number | null;
    external_ref: string;
  }): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO conversions
           (campaign_id, intent_id, creator_id, session_id, kind, value_usd, external_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_ref) DO NOTHING`,
      )
      .bind(
        c.campaign_id,
        c.intent_id,
        c.creator_id,
        c.session_id,
        c.kind,
        c.value_usd,
        c.external_ref,
        nowSec(),
      )
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async clickCountForIntent(intentId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM link_resolutions WHERE intent_id = ?')
      .bind(intentId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async conversionsForIntent(intentId: string): Promise<{ count: number; value_usd: number }> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS v FROM conversions WHERE intent_id = ?',
      )
      .bind(intentId)
      .first<{ n: number; v: number }>();
    return { count: row?.n ?? 0, value_usd: row?.v ?? 0 };
  }

  // ------------------------------------------------------------ promo posts

  async listDuePromoPosts(nowEpoch: number, limit = 50): Promise<
    Array<{
      promo_post_id: string;
      campaign_id: string;
      creator_id: string | null;
      channel: Channel;
      scheduled_at: number;
      caption: string;
      public_link: string | null;
      public_asset_ref: string | null;
    }>
  > {
    const { results } = await this.db
      .prepare(
        `SELECT p.promo_post_id, p.campaign_id, p.creator_id, p.channel, p.scheduled_at,
                p.caption, p.public_link, p.public_asset_ref
           FROM promo_posts p
           JOIN promo_campaigns c ON c.campaign_id = p.campaign_id
          WHERE p.status = 'pending' AND p.scheduled_at <= ? AND c.status = 'active'
          ORDER BY p.scheduled_at ASC LIMIT ?`,
      )
      .bind(nowEpoch, limit)
      .all<{
        promo_post_id: string;
        campaign_id: string;
        creator_id: string | null;
        channel: Channel;
        scheduled_at: number;
        caption: string;
        public_link: string | null;
        public_asset_ref: string | null;
      }>();
    return results ?? [];
  }

  async markPromoPostQueued(promoPostId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE promo_posts SET status = 'queued', updated_at = ? WHERE promo_post_id = ?`)
      .bind(nowSec(), promoPostId)
      .run();
  }
}
