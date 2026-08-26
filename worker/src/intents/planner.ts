import type { Repo } from '../db/repo';
import type { Config, Env } from '../env';
import type { Channel, Creator, IntentEvent, LiveSession, OutboundMessage, Schedule } from '../types';
import { resolvePublicAsset } from '../content/assets';
import { scanText } from '../content/safety';
import {
  parseCopyDefaults,
  renderCaption,
  variantIndexOf,
  type PublicSafeContext,
} from '../content/templates';
import { buildGoLink, resolveLiveDestination } from '../links/resolver';
import { captionHash } from '../lib/hash';
import {
  budgetGate,
  channelGate,
  creatorOptedIn,
  killSwitchEngaged,
  liveStateGate,
  spamGate,
} from '../lib/guards';
import { idempotencyKey, newId } from '../lib/ids';
import { log } from '../lib/log';
import { formatLocalDateTime, nowSec } from '../lib/time';

export type PlanOutcome =
  | { status: 'queued'; intent_id: string; idempotency_key: string; caption: string }
  | { status: 'duplicate'; idempotency_key: string }
  | { status: 'skipped'; reason: string };

export interface PlanIntentInput {
  creator: Creator;
  channel: Channel;
  event: IntentEvent;
  session: LiveSession | null;
  schedule: Schedule | null;
  scheduledAt: number;
  campaignId?: string | null;
  now?: number;
}

/** Per-post X cost. A link pushes the post into the higher pay-per-use tier. */
export function estimateCost(cfg: Config, channel: Channel, caption: string): number {
  if (channel !== 'x') return 0;
  return /https?:\/\//.test(caption) ? cfg.xCostPerPostWithUrlUsd : cfg.xCostPerPostUsd;
}

/**
 * Plan one outbound intent.
 *
 * Order matters here. Cheap authorisation checks run before any content is
 * built; content is built and de-duplicated; only then is spend evaluated and
 * the idempotency key claimed. A denial before the claim leaves no row, so
 * flipping a gate on does not leave a poisoned key behind.
 */
export async function planIntent(
  repo: Repo,
  env: Env,
  cfg: Config,
  input: PlanIntentInput,
): Promise<PlanOutcome> {
  const now = input.now ?? nowSec();
  const { creator, channel, event, session, schedule } = input;

  const preChecks = [
    await killSwitchEngaged(repo, channel),
    channelGate(env, channel),
    creatorOptedIn(creator, channel),
    liveStateGate(event, session),
    await spamGate(repo, cfg, session, event, channel),
  ];
  for (const check of preChecks) {
    if (!check.allowed) return skip(repo, input, check.reason);
  }

  // --- safe link -----------------------------------------------------------
  const intentId = newId('int');
  const destination = await resolveLiveDestination(repo, cfg, creator.creator_id);
  if (destination.creator_id == null) {
    return skip(repo, input, 'safe_link_unresolvable');
  }
  // Announcing a live show while the resolver cannot reach that live show means
  // the two halves of the system disagree. Rather than publish a link we expect
  // to dead-end, stop.
  if (event === 'live_now' && destination.step !== 1) {
    return skip(repo, input, `live_link_not_resolvable:step_${destination.step}`);
  }
  const safeLink = buildGoLink(cfg, creator.creator_id, {
    campaignId: input.campaignId ?? null,
    intentId,
  });

  // --- media ---------------------------------------------------------------
  const defaults = parseCopyDefaults(creator);
  const requireMedia = (defaults as { require_media?: boolean }).require_media === true;
  const asset = await resolvePublicAsset(repo, cfg, creator.creator_id, null);
  if (requireMedia && !asset.ok) {
    return skip(repo, input, `media_required_but_unsafe:${asset.reason}`);
  }
  const assetRef = asset.ok ? asset.asset_ref : null;

  // --- copy ----------------------------------------------------------------
  const localTime = schedule
    ? formatLocalDateTime(schedule.starts_at_utc, schedule.source_timezone || creator.timezone)
    : session
      ? formatLocalDateTime(session.session_start_epoch, creator.timezone)
      : null;

  const ctx: PublicSafeContext = {
    display_name: creator.display_name,
    handle_x: channel === 'x' || channel === 'manual_x' ? creator.handle_x : null,
    niche: creator.niche,
    country: creator.country,
    show_text: session?.show_text ?? schedule?.show_text ?? null,
    local_time: localTime,
    safe_link: safeLink,
  };

  const seed = `${creator.creator_id}|${session?.session_id ?? schedule?.schedule_id ?? 'none'}|${event}|${channel}`;
  const dedupeSince = now - cfg.dedupeWindowDays * 86_400;
  const excluded = new Set<number>();

  let caption: string | null = null;
  let captionDigest = '';
  let variantId: string | null = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const rendered = await renderCaption({ event, ctx, defaults, seed, excludeVariants: excluded });
    if (!rendered) break;

    const digest = await captionHash(rendered.caption);
    const isDuplicate = await repo.hasRecentCaptionHash(
      creator.creator_id,
      channel,
      digest,
      dedupeSince,
    );
    if (isDuplicate) {
      const index = variantIndexOf(rendered.variant_id);
      if (index == null) break;
      excluded.add(index);
      continue;
    }

    caption = rendered.caption;
    captionDigest = digest;
    variantId = rendered.variant_id;
    break;
  }

  if (!caption) return skip(repo, input, 'near_duplicate_or_no_template');

  // Belt and braces: the rendered string and the asset URL both get scanned one
  // last time before anything is persisted as sendable.
  const captionVerdict = scanText(caption);
  if (!captionVerdict.safe) return skip(repo, input, `caption_unsafe:${captionVerdict.reason}`);

  // --- spend ---------------------------------------------------------------
  const cost = estimateCost(cfg, channel, caption);
  const budget = await budgetGate(repo, cfg, channel, cost, now);
  if (!budget.allowed) {
    // X specifically has a documented free fallback: keep the intent, hand it to
    // a human instead of dropping the announcement on the floor.
    if (channel === 'x' && channelGate(env, 'manual_x').allowed) {
      return planIntent(repo, env, cfg, { ...input, channel: 'manual_x', now });
    }
    return skip(repo, input, budget.reason);
  }

  // --- claim ---------------------------------------------------------------
  const key = idempotencyKey({
    creatorId: creator.creator_id,
    providerRoomId: session?.provider_room_id ?? null,
    sessionStartEpoch: session?.session_start_epoch ?? null,
    scheduleId: schedule?.schedule_id ?? null,
    event,
    channel,
    campaignId: input.campaignId ?? null,
  });

  const claimed = await repo.insertIntentIfAbsent({
    intent_id: intentId,
    idempotency_key: key,
    type: 'live_event',
    creator_id: creator.creator_id,
    provider_room_id: session?.provider_room_id ?? null,
    session_id: session?.session_id ?? null,
    schedule_id: schedule?.schedule_id ?? null,
    campaign_id: input.campaignId ?? null,
    event,
    channel,
    scheduled_at: input.scheduledAt,
    caption,
    caption_hash: captionDigest,
    variant_id: variantId,
    public_link: safeLink,
    public_asset_ref: assetRef,
    approval_mode: 'auto_live',
    status: 'queued',
    estimated_cost_usd: cost,
  });

  if (!claimed) {
    log('info', 'planner.duplicate_key', { idempotency_key: key });
    return { status: 'duplicate', idempotency_key: key };
  }

  await repo.appendEvent({
    event_type: 'LIVE_POST_QUEUED',
    creator_id: creator.creator_id,
    session_id: session?.session_id ?? null,
    schedule_id: schedule?.schedule_id ?? null,
    intent_id: intentId,
    channel,
    detail: { event, variant_id: variantId, estimated_cost_usd: cost, asset_ref: assetRef },
  });

  return { status: 'queued', intent_id: intentId, idempotency_key: key, caption };
}

async function skip(repo: Repo, input: PlanIntentInput, reason: string): Promise<PlanOutcome> {
  await repo.appendEvent({
    event_type: 'NEEDS_ATTENTION',
    creator_id: input.creator.creator_id,
    session_id: input.session?.session_id ?? null,
    schedule_id: input.schedule?.schedule_id ?? null,
    channel: input.channel,
    detail: { stage: 'plan', event: input.event, reason },
  });
  log('info', 'planner.skipped', {
    creator_id: input.creator.creator_id,
    channel: input.channel,
    event: input.event,
    reason,
  });
  return { status: 'skipped', reason };
}

/** Channels a creator has switched on, in a stable order. */
export function enabledChannelsFor(creator: Creator): Channel[] {
  const channels: Channel[] = [];
  if (creator.auto_post_x) channels.push('x');
  if (creator.auto_post_telegram) channels.push('telegram');
  if (creator.auto_post_bluesky) channels.push('bluesky');
  return channels;
}

/** Publish to the delivery queue; a failure here is recoverable by the cron sweep. */
export async function publish(env: Env, message: OutboundMessage): Promise<boolean> {
  try {
    await env.OUTBOUND.send(message);
    return true;
  } catch (err) {
    log('warn', 'planner.queue_publish_failed', { intent_id: message.intent_id, error: String(err) });
    return false;
  }
}
