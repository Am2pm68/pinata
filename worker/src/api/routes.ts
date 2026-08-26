import { Hono } from 'hono';
import { Repo } from '../db/repo';
import { config, type Env } from '../env';
import type { Channel, IntentEvent } from '../types';
import { parseCopyDefaults, renderCaption, type PublicSafeContext } from '../content/templates';
import { buildGoLink, resolveLiveDestination } from '../links/resolver';
import { KILL_SWITCH_KEY, killSwitchKeyFor } from '../lib/guards';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { formatLocalDateTime, isValidTimeZone, nowSec } from '../lib/time';
import { enabledChannelsFor, planIntent, publish } from '../intents/planner';
import { runCron } from '../schedule/cron';
import { verifySignature } from './auth';

type App = Hono<{ Bindings: Env; Variables: { body: unknown; raw: string } }>;

const CHANNEL_VALUES: Channel[] = ['x', 'telegram', 'bluesky', 'manual_x'];

export function buildApp(): App {
  const app = new Hono<{ Bindings: Env; Variables: { body: unknown; raw: string } }>();

  app.get('/healthz', (c) => c.json({ ok: true, service: 'toiaf-live-autopost' }));

  // ------------------------------------------------------------------ public
  //
  // The one unauthenticated route. It resolves a promotional click at click
  // time so that a post which outlives its show still lands somewhere real.
  app.get('/go/live/:slug', async (c) => {
    const cfg = config(c.env);
    const repo = new Repo(c.env.DB);
    const slug = c.req.param('slug');

    let destination;
    try {
      destination = await resolveLiveDestination(repo, cfg, slug);
    } catch (err) {
      log('error', 'go.resolve_failed', { slug, error: String(err) });
      return c.redirect(`${cfg.publicOrigin}/live/`, 302);
    }

    const target = new URL(destination.url);
    const campaignId = c.req.query('c');
    const intentId = c.req.query('i');
    target.searchParams.set('utm_source', 'toiaf_live_autopost');
    if (campaignId) target.searchParams.set('utm_campaign', campaignId);

    let refererHost: string | null = null;
    const referer = c.req.header('referer');
    if (referer) {
      try {
        refererHost = new URL(referer).hostname;
      } catch {
        refererHost = null;
      }
    }

    // Recording the click must never be able to break the redirect itself.
    try {
      await repo.recordLinkResolution({
        creator_id: destination.creator_id,
        session_id: destination.session_id,
        intent_id: intentId ?? null,
        campaign_id: campaignId ?? null,
        requested_slug: slug,
        resolved_url: destination.url,
        resolution_step: destination.step,
        was_corrected: destination.was_corrected ? 1 : 0,
        referer_host: refererHost,
      });
    } catch (err) {
      log('warn', 'go.record_failed', { slug, error: String(err) });
    }

    return c.redirect(target.toString(), 302);
  });

  // ----------------------------------------------------------------- signed
  app.use('/api/v1/*', async (c, next) => {
    const raw = c.req.method === 'GET' ? '' : await c.req.text();
    const auth = await verifySignature(c.env, c.req.raw, raw);
    if (!auth.ok) return c.json({ ok: false, error: auth.reason }, 401);

    c.set('raw', raw);
    if (raw) {
      try {
        c.set('body', JSON.parse(raw));
      } catch {
        return c.json({ ok: false, error: 'invalid_json' }, 400);
      }
    } else {
      c.set('body', {});
    }
    await next();
  });

  // --------------------------------------------------- RichGirls: settings
  app.get('/api/v1/creators/:id/live-promotion', async (c) => {
    const cfg = config(c.env);
    const repo = new Repo(c.env.DB);
    const creatorId = c.req.param('id');
    const creator = await repo.getCreator(creatorId);
    if (!creator) return c.json({ ok: false, error: 'creator_not_found' }, 404);

    const now = nowSec();
    const next = await repo.nextActiveSchedule(creatorId, now);
    const session = await repo.getConfirmedSessionForCreator(creatorId);
    const recent = await repo.listIntentsForCreator(creatorId, 5);
    const last = recent[0];

    return c.json({
      ok: true,
      creator: {
        creator_id: creator.creator_id,
        display_name: creator.display_name,
        timezone: creator.timezone,
        niche: creator.niche,
        approval_status: creator.approval_status,
        mapping_status: creator.mapping_status,
      },
      live_promotion: creator.live_promotion_enabled === 1,
      auto_post: {
        x: creator.auto_post_x === 1,
        telegram: creator.auto_post_telegram === 1,
        bluesky: creator.auto_post_bluesky === 1,
      },
      next_live: next
        ? {
            schedule_id: next.schedule_id,
            starts_at_utc: next.starts_at_utc,
            local: formatLocalDateTime(next.starts_at_utc, next.source_timezone),
            source: next.source,
            show_text: next.show_text,
          }
        : null,
      currently_live: session != null && !session.suppressed_reason,
      public_link: buildGoLink(cfg, creator.creator_id),
      last_auto_post: last
        ? {
            intent_id: last.intent_id,
            channel: last.channel,
            event: last.event,
            status: last.status,
            skip_reason: last.skip_reason,
            sent_at: last.sent_at,
          }
        : null,
      revoked_at: creator.revoked_at,
    });
  });

  app.put('/api/v1/creators/:id/live-promotion', async (c) => {
    const repo = new Repo(c.env.DB);
    const creatorId = c.req.param('id');
    const creator = await repo.getCreator(creatorId);
    if (!creator) return c.json({ ok: false, error: 'creator_not_found' }, 404);

    const body = c.get('body') as {
      live_promotion?: boolean;
      auto_post?: { x?: boolean; telegram?: boolean; bluesky?: boolean };
      copy_defaults?: unknown;
      timezone?: string;
    };

    if (body.timezone && !isValidTimeZone(body.timezone)) {
      return c.json({ ok: false, error: 'invalid_timezone' }, 400);
    }

    const patch: Record<string, unknown> = {};
    if (body.live_promotion !== undefined) {
      patch.live_promotion_enabled = body.live_promotion ? 1 : 0;
    }
    if (body.auto_post?.x !== undefined) patch.auto_post_x = body.auto_post.x ? 1 : 0;
    if (body.auto_post?.telegram !== undefined) {
      patch.auto_post_telegram = body.auto_post.telegram ? 1 : 0;
    }
    if (body.auto_post?.bluesky !== undefined) {
      patch.auto_post_bluesky = body.auto_post.bluesky ? 1 : 0;
    }
    if (body.copy_defaults !== undefined) {
      patch.copy_defaults_json = JSON.stringify(body.copy_defaults);
    }
    if (body.timezone) patch.timezone = body.timezone;

    await repo.updateCreatorSettings(creatorId, patch);
    await repo.appendEvent({
      event_type: 'NEEDS_ATTENTION',
      creator_id: creatorId,
      detail: { stage: 'settings_updated', patch: Object.keys(patch) },
    });

    return c.json({ ok: true, updated: Object.keys(patch) });
  });

  /**
   * Revoke. Immediate and retroactive: flags off, queued intents cancelled,
   * any stored creator X token invalidated in the same call.
   */
  app.post('/api/v1/creators/:id/revoke', async (c) => {
    const repo = new Repo(c.env.DB);
    const creatorId = c.req.param('id');
    const creator = await repo.getCreator(creatorId);
    if (!creator) return c.json({ ok: false, error: 'creator_not_found' }, 404);

    const body = c.get('body') as { reason?: string; revoke_x_auth?: boolean };
    const reason = body.reason ?? 'creator_revoked';
    const cancelled = await repo.revokeCreator(creatorId, reason);
    if (body.revoke_x_auth !== false) await repo.revokeChannelAuth(creatorId, 'x');

    await repo.appendEvent({
      event_type: 'NEEDS_ATTENTION',
      creator_id: creatorId,
      detail: { stage: 'revoked', reason, cancelled_intents: cancelled },
    });

    return c.json({ ok: true, cancelled_intents: cancelled });
  });

  // ------------------------------------------------- RichGirls: schedules
  app.post('/api/v1/creators/:id/schedule', async (c) => {
    const repo = new Repo(c.env.DB);
    const creatorId = c.req.param('id');
    const creator = await repo.getCreator(creatorId);
    if (!creator) return c.json({ ok: false, error: 'creator_not_found' }, 404);

    const body = c.get('body') as {
      starts_at_utc?: number;
      source_timezone?: string;
      source?: string;
      show_text?: string;
    };

    const startsAt = Number(body.starts_at_utc);
    if (!Number.isFinite(startsAt) || startsAt <= 0) {
      return c.json({ ok: false, error: 'starts_at_utc_required' }, 400);
    }
    // A schedule must come from a real source. There is no "inferred" option:
    // we do not manufacture a start time out of past behaviour.
    const source = body.source ?? 'richgirls';
    if (source !== 'toiaf' && source !== 'provider' && source !== 'richgirls') {
      return c.json({ ok: false, error: 'invalid_source' }, 400);
    }
    const timezone = body.source_timezone ?? creator.timezone;
    if (!isValidTimeZone(timezone)) return c.json({ ok: false, error: 'invalid_timezone' }, 400);

    const scheduleId = newId('sch');
    await repo.createSchedule({
      schedule_id: scheduleId,
      creator_id: creatorId,
      starts_at_utc: Math.floor(startsAt),
      source_timezone: timezone,
      source,
      show_text: body.show_text ?? null,
      status: 'active',
      session_id: null,
    });

    await repo.appendEvent({
      event_type: 'LIVE_SCHEDULED',
      creator_id: creatorId,
      schedule_id: scheduleId,
      detail: { starts_at_utc: Math.floor(startsAt), source, timezone },
    });

    return c.json({
      ok: true,
      schedule_id: scheduleId,
      local: formatLocalDateTime(Math.floor(startsAt), timezone),
    });
  });

  app.delete('/api/v1/schedules/:id', async (c) => {
    const repo = new Repo(c.env.DB);
    const scheduleId = c.req.param('id');
    const schedule = await repo.getSchedule(scheduleId);
    if (!schedule) return c.json({ ok: false, error: 'schedule_not_found' }, 404);

    await repo.setScheduleStatus(scheduleId, 'cancelled', null);
    await repo.appendEvent({
      event_type: 'NEEDS_ATTENTION',
      creator_id: schedule.creator_id,
      schedule_id: scheduleId,
      detail: { stage: 'schedule_cancelled' },
    });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------- RichGirls: preview
  app.post('/api/v1/creators/:id/preview', async (c) => {
    const cfg = config(c.env);
    const repo = new Repo(c.env.DB);
    const creatorId = c.req.param('id');
    const creator = await repo.getCreator(creatorId);
    if (!creator) return c.json({ ok: false, error: 'creator_not_found' }, 404);

    const body = c.get('body') as { event?: IntentEvent; channel?: Channel };
    const event = body.event ?? 'live_now';
    const channel = body.channel ?? 'x';

    const next = await repo.nextActiveSchedule(creatorId, nowSec());
    const ctx: PublicSafeContext = {
      display_name: creator.display_name,
      handle_x: channel === 'x' || channel === 'manual_x' ? creator.handle_x : null,
      niche: creator.niche,
      country: creator.country,
      show_text: next?.show_text ?? null,
      local_time: next
        ? formatLocalDateTime(next.starts_at_utc, next.source_timezone)
        : null,
      safe_link: buildGoLink(cfg, creator.creator_id),
    };

    const rendered = await renderCaption({
      event,
      ctx,
      defaults: parseCopyDefaults(creator),
      seed: `${creatorId}|preview|${event}|${channel}`,
    });

    return rendered
      ? c.json({ ok: true, caption: rendered.caption, variant_id: rendered.variant_id })
      : c.json({ ok: false, error: 'no_renderable_template' }, 422);
  });

  // ---------------------------------------------------- RichGirls: results
  app.get('/api/v1/creators/:id/results', async (c) => {
    const repo = new Repo(c.env.DB);
    const creatorId = c.req.param('id');
    const intents = await repo.listIntentsForCreator(creatorId, 50);

    const rows = [];
    for (const intent of intents) {
      const conversions = await repo.conversionsForIntent(intent.intent_id);
      rows.push({
        intent_id: intent.intent_id,
        type: intent.type,
        event: intent.event,
        channel: intent.channel,
        status: intent.status,
        skip_reason: intent.skip_reason,
        error_class: intent.last_error_class,
        scheduled_at: intent.scheduled_at,
        sent_at: intent.sent_at,
        provider_post_id: intent.provider_post_id,
        estimated_cost_usd: intent.estimated_cost_usd,
        // Real measurements only. No impressions are reported here because we
        // do not have a truthful source for them.
        clicks: await repo.clickCountForIntent(intent.intent_id),
        conversions: conversions.count,
        conversion_value_usd: conversions.value_usd,
      });
    }

    return c.json({ ok: true, results: rows });
  });

  // ------------------------------------------------------ conversion intake
  app.post('/api/v1/webhooks/conversion', async (c) => {
    const repo = new Repo(c.env.DB);
    const body = c.get('body') as {
      external_ref?: string;
      intent_id?: string;
      campaign_id?: string;
      creator_id?: string;
      session_id?: string;
      kind?: string;
      value_usd?: number;
    };

    if (!body.external_ref) return c.json({ ok: false, error: 'external_ref_required' }, 400);

    const recorded = await repo.recordConversion({
      external_ref: body.external_ref,
      intent_id: body.intent_id ?? null,
      campaign_id: body.campaign_id ?? null,
      creator_id: body.creator_id ?? null,
      session_id: body.session_id ?? null,
      kind: body.kind ?? 'unknown',
      value_usd: body.value_usd ?? null,
    });

    return c.json({ ok: true, recorded });
  });

  // ------------------------------------------------------------------ admin
  app.post('/api/v1/admin/kill-switch', async (c) => {
    const repo = new Repo(c.env.DB);
    const body = c.get('body') as { engaged?: boolean; channel?: Channel; actor?: string };
    const key = body.channel ? killSwitchKeyFor(body.channel) : KILL_SWITCH_KEY;
    const value = body.engaged === false ? '0' : '1';

    await repo.setFlag(key, value, body.actor ?? 'api');
    await repo.appendEvent({
      event_type: 'NEEDS_ATTENTION',
      channel: body.channel ?? null,
      detail: { stage: 'kill_switch', key, value, actor: body.actor ?? 'api' },
    });
    return c.json({ ok: true, key, value });
  });

  app.get('/api/v1/admin/status', async (c) => {
    const cfg = config(c.env);
    const repo = new Repo(c.env.DB);
    const now = nowSec();

    return c.json({
      ok: true,
      gates: {
        x: c.env.TOIAF_ALLOW_AUTO_LIVE_X === '1',
        telegram: c.env.TOIAF_ALLOW_AUTO_LIVE_TELEGRAM === '1',
        bluesky: c.env.TOIAF_ALLOW_AUTO_LIVE_BLUESKY === '1',
        manual_x: c.env.TOIAF_ALLOW_MANUAL_X_FALLBACK === '1',
      },
      kill_switch: {
        global: (await repo.getFlag(KILL_SWITCH_KEY)) === '1',
        x: (await repo.getFlag(killSwitchKeyFor('x'))) === '1',
        telegram: (await repo.getFlag(killSwitchKeyFor('telegram'))) === '1',
        bluesky: (await repo.getFlag(killSwitchKeyFor('bluesky'))) === '1',
      },
      broadcaster_mode: cfg.broadcasterMode,
      provider: cfg.providerName,
      x_spend_month_to_date_usd: await repo.channelSpendThisMonth('x', now),
      x_monthly_budget_usd: cfg.xMonthlyBudgetUsd,
      confirmed_sessions: (await repo.listSessionsByState('confirmed', 50)).length,
      detected_sessions: (await repo.listSessionsByState('detected', 50)).length,
    });
  });

  /**
   * Manual cron trigger. Used for the dry-run step of the deploy checklist:
   * with every channel gate at 0 this exercises detection, planning and the
   * fail-closed path without a single external send.
   */
  app.post('/api/v1/admin/run-cron', async (c) => {
    const summary = await runCron(c.env);
    return c.json({ ok: true, summary });
  });

  /**
   * Supervised canary. One creator, one channel, one post, all gates still in
   * force -- this does not bypass anything, it just triggers a single planned
   * send rather than waiting for a real show.
   */
  app.post('/api/v1/admin/canary', async (c) => {
    const cfg = config(c.env);
    const repo = new Repo(c.env.DB);
    const body = c.get('body') as { creator_id?: string; channel?: Channel; event?: IntentEvent };

    if (!body.creator_id) return c.json({ ok: false, error: 'creator_id_required' }, 400);
    const channel = body.channel ?? 'x';
    if (!CHANNEL_VALUES.includes(channel)) return c.json({ ok: false, error: 'bad_channel' }, 400);

    const creator = await repo.getCreator(body.creator_id);
    if (!creator) return c.json({ ok: false, error: 'creator_not_found' }, 404);

    const event = body.event ?? 'live_now';
    const session =
      event === 'live_now' ? await repo.getConfirmedSessionForCreator(creator.creator_id) : null;

    const outcome = await planIntent(repo, c.env, cfg, {
      creator,
      channel,
      event,
      session,
      schedule: null,
      scheduledAt: nowSec(),
    });

    if (outcome.status === 'queued') {
      await publish(c.env, {
        intent_id: outcome.intent_id,
        idempotency_key: outcome.idempotency_key,
        attempt_hint: 0,
      });
      await repo.touchIntentEnqueued(outcome.intent_id);
    }

    return c.json({ ok: true, outcome, enabled_channels: enabledChannelsFor(creator) });
  });

  return app;
}
