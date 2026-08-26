import { Repo } from '../db/repo';
import { config, type Config, type Env } from '../env';
import type { Channel, Creator, LiveSession, Schedule } from '../types';
import { runDetectionCycle } from '../live/detector';
import { fetchLiveModels } from '../live/provider';
import { enabledChannelsFor, planIntent, publish } from '../intents/planner';
import { captionHash } from '../lib/hash';
import { idempotencyKey, newId } from '../lib/ids';
import { log } from '../lib/log';
import { nowSec } from '../lib/time';

export interface CronSummary {
  provider_ok: boolean;
  provider_error?: string;
  live_count: number;
  detected: number;
  confirmed: number;
  ended: number;
  suppressed: number;
  reconnected: number;
  live_now_queued: number;
  reminders_queued: number;
  announcements_queued: number;
  promo_queued: number;
  resweept: number;
}

/**
 * One control-plane tick.
 *
 * Order is deliberate: read live truth first, then announce from it. Every
 * stage is wrapped so that a failure in social sending can never propagate back
 * into live-state tracking -- a broken X credential must not stop the system
 * from knowing who is on air.
 */
export async function runCron(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now: number = nowSec(),
): Promise<CronSummary> {
  const cfg = config(env);
  const repo = new Repo(env.DB);

  const summary: CronSummary = {
    provider_ok: false,
    live_count: 0,
    detected: 0,
    confirmed: 0,
    ended: 0,
    suppressed: 0,
    reconnected: 0,
    live_now_queued: 0,
    reminders_queued: 0,
    announcements_queued: 0,
    promo_queued: 0,
    resweept: 0,
  };

  // --- 1. authoritative live state ----------------------------------------
  const roster = await fetchLiveModels(env, cfg, fetchImpl);
  if (!roster.ok) {
    // Critically, we do NOT proceed to detection on a failed fetch. Treating an
    // API outage as "everyone offline" would end every open session and, later,
    // re-announce all of them as new shows.
    summary.provider_error = roster.error;
    log('error', 'cron.provider_unavailable', { error: roster.error });
    await repo.appendEvent({
      event_type: 'NEEDS_ATTENTION',
      detail: { stage: 'provider_fetch', error: roster.error },
    });
  } else {
    summary.provider_ok = true;
    summary.live_count = roster.models.length;

    const detection = await runDetectionCycle(repo, cfg, cfg.providerName, roster.models, now);
    summary.detected = detection.detected.length;
    summary.confirmed = detection.confirmed.length;
    summary.ended = detection.ended.length;
    summary.suppressed = detection.suppressed.length;
    summary.reconnected = detection.reconnected.length;

    for (const session of detection.confirmed) {
      try {
        summary.live_now_queued += await announceLiveNow(repo, env, cfg, session, now);
      } catch (err) {
        log('error', 'cron.announce_failed', {
          session_id: session.session_id,
          error: String(err),
        });
      }
    }
  }

  // --- 2. schedule-driven pre-live posts ----------------------------------
  try {
    const planned = await planScheduledPosts(repo, env, cfg, now);
    summary.reminders_queued = planned.reminders;
    summary.announcements_queued = planned.announcements;
  } catch (err) {
    log('error', 'cron.schedule_plan_failed', { error: String(err) });
  }

  // --- 3. standalone scheduled promo ---------------------------------------
  try {
    summary.promo_queued = await planPromoPosts(repo, env, cfg, now);
  } catch (err) {
    log('error', 'cron.promo_plan_failed', { error: String(err) });
  }

  // --- 4. recover intents whose queue publish was lost ----------------------
  try {
    summary.resweept = await resweepStuckIntents(repo, env, now);
  } catch (err) {
    log('error', 'cron.resweep_failed', { error: String(err) });
  }

  log('info', 'cron.tick', { ...summary });
  return summary;
}

/**
 * Announce a confirmed session on every channel the creator has switched on.
 * The schedule that predicted this show, if there is one, is closed out here so
 * its reminder cannot fire after the fact.
 */
async function announceLiveNow(
  repo: Repo,
  env: Env,
  cfg: Config,
  session: LiveSession,
  now: number,
): Promise<number> {
  const creator = await repo.getCreator(session.creator_id);
  if (!creator) return 0;

  const schedule = await repo.findScheduleForSession(
    session.creator_id,
    session.session_start_epoch,
    cfg.scheduleDueToleranceSeconds,
  );
  if (schedule) {
    await repo.setScheduleStatus(schedule.schedule_id, 'fulfilled', session.session_id);
  }

  return planAndPublish(repo, env, cfg, {
    creator,
    channels: enabledChannelsFor(creator),
    event: 'live_now',
    session,
    schedule,
    scheduledAt: now,
    now,
  });
}

interface PlanAndPublishInput {
  creator: Creator;
  channels: Channel[];
  event: 'live_now' | 'reminder' | 'scheduled';
  session: LiveSession | null;
  schedule: Schedule | null;
  scheduledAt: number;
  now: number;
}

async function planAndPublish(
  repo: Repo,
  env: Env,
  cfg: Config,
  input: PlanAndPublishInput,
): Promise<number> {
  let queued = 0;
  for (const channel of input.channels) {
    const outcome = await planIntent(repo, env, cfg, {
      creator: input.creator,
      channel,
      event: input.event,
      session: input.session,
      schedule: input.schedule,
      scheduledAt: input.scheduledAt,
      now: input.now,
    });
    if (outcome.status !== 'queued') continue;

    const published = await publish(env, {
      intent_id: outcome.intent_id,
      idempotency_key: outcome.idempotency_key,
      attempt_hint: 0,
    });
    if (published) await repo.touchIntentEnqueued(outcome.intent_id);
    queued++;
  }
  return queued;
}

/**
 * Pre-live posts.
 *
 * Both the optional announcement and the reminder hang off a real schedule row.
 * With no schedule there is no reminder -- we never synthesise a start time from
 * how a creator behaved last week.
 */
export async function planScheduledPosts(
  repo: Repo,
  env: Env,
  cfg: Config,
  now: number,
): Promise<{ reminders: number; announcements: number }> {
  let reminders = 0;
  let announcements = 0;

  const horizon = Math.max(cfg.reminderLeadMinutes, cfg.announceLeadMinutes) * 60;
  const schedules = await repo.listActiveSchedulesInWindow(now, now + horizon + 60);

  for (const schedule of schedules) {
    const creator = await repo.getCreator(schedule.creator_id);
    if (!creator) continue;
    const channels = enabledChannelsFor(creator);
    if (channels.length === 0) continue;

    const reminderAt = schedule.starts_at_utc - cfg.reminderLeadMinutes * 60;
    if (cfg.reminderLeadMinutes > 0 && now >= reminderAt && now < schedule.starts_at_utc) {
      reminders += await planAndPublish(repo, env, cfg, {
        creator,
        channels,
        event: 'reminder',
        session: null,
        schedule,
        scheduledAt: now,
        now,
      });
    }

    const announceAt = schedule.starts_at_utc - cfg.announceLeadMinutes * 60;
    if (cfg.announceLeadMinutes > 0 && now >= announceAt && now < reminderAt) {
      announcements += await planAndPublish(repo, env, cfg, {
        creator,
        channels,
        event: 'scheduled',
        session: null,
        schedule,
        scheduledAt: now,
        now,
      });
    }
  }

  return { reminders, announcements };
}

/**
 * Standalone scheduled promotion (the ToiletFeed X campaign and anything like
 * it). Same queue, same gates, same dedupe, same budget guard as live posts.
 */
export async function planPromoPosts(
  repo: Repo,
  env: Env,
  cfg: Config,
  now: number,
): Promise<number> {
  const due = await repo.listDuePromoPosts(now);
  let queued = 0;

  for (const post of due) {
    const key = idempotencyKey({
      creatorId: post.creator_id ?? 'network',
      providerRoomId: null,
      sessionStartEpoch: null,
      scheduleId: null,
      event: 'promo',
      channel: post.channel,
      promoPostId: post.promo_post_id,
    });

    const intentId = newId('int');
    const cost =
      post.channel === 'x'
        ? /https?:\/\//.test(post.caption)
          ? cfg.xCostPerPostWithUrlUsd
          : cfg.xCostPerPostUsd
        : 0;

    const created = await repo.insertIntentIfAbsent({
      intent_id: intentId,
      idempotency_key: key,
      type: 'promo_post',
      creator_id: post.creator_id,
      provider_room_id: null,
      session_id: null,
      schedule_id: null,
      campaign_id: post.campaign_id,
      event: 'promo',
      channel: post.channel,
      scheduled_at: post.scheduled_at,
      caption: post.caption,
      caption_hash: await captionHash(post.caption),
      variant_id: null,
      public_link: post.public_link,
      public_asset_ref: post.public_asset_ref,
      approval_mode: 'manual',
      status: 'queued',
      estimated_cost_usd: cost,
    });

    await repo.markPromoPostQueued(post.promo_post_id);
    if (!created) continue;

    if (await publish(env, { intent_id: intentId, idempotency_key: key, attempt_hint: 0 })) {
      await repo.touchIntentEnqueued(intentId);
    }
    queued++;
  }

  return queued;
}

/**
 * Re-publish intents that are due but still sitting in `queued` -- the case
 * where the row was written and the queue publish failed. Only rows untouched
 * for two minutes are swept, so a merely-busy queue is not amplified.
 */
export async function resweepStuckIntents(repo: Repo, env: Env, now: number): Promise<number> {
  const due = await repo.listDueIntents(now, 50);
  let republished = 0;

  for (const intent of due) {
    if (now - intent.updated_at < 120) continue;
    if (
      await publish(env, {
        intent_id: intent.intent_id,
        idempotency_key: intent.idempotency_key,
        attempt_hint: intent.attempts,
      })
    ) {
      await repo.touchIntentEnqueued(intent.intent_id);
      republished++;
    }
  }
  return republished;
}
