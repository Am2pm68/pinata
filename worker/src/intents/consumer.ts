import type { Repo } from '../db/repo';
import type { Config, Env } from '../env';
import type { OutboundIntent, OutboundMessage, SendResult } from '../types';
import { forwardToBroadcaster } from '../channels/broadcaster';
import { sendToBluesky } from '../channels/bluesky';
import { queueManualHandoff } from '../channels/manual';
import { sendToTelegram } from '../channels/telegram';
import { sendToX } from '../channels/x';
import { resolvePublicAsset } from '../content/assets';
import { channelGate, evaluateSendGates } from '../lib/guards';
import { idempotencyKey, newId } from '../lib/ids';
import { log } from '../lib/log';
import { nowSec } from '../lib/time';

export const MAX_ATTEMPTS = 5;

export type ConsumeOutcome =
  | { action: 'sent'; intent_id: string }
  | { action: 'awaiting_manual'; intent_id: string }
  | { action: 'skipped'; intent_id: string; reason: string }
  | { action: 'retry'; intent_id: string; reason: string }
  | { action: 'failed'; intent_id: string; reason: string }
  | { action: 'noop'; reason: string };

/**
 * Deliver one intent.
 *
 * The gate sequence runs again here, and this run is the one that counts: a
 * creator who switches auto-post off in the minute between queueing and sending
 * must not have the post go out anyway.
 */
export async function consumeIntent(
  repo: Repo,
  env: Env,
  cfg: Config,
  message: OutboundMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ConsumeOutcome> {
  // Conditional claim. A redelivered message finds the row already in flight and
  // does nothing -- this is what makes at-least-once queue delivery safe.
  const intent = await repo.claimIntentForSend(message.intent_id);
  if (!intent) {
    log('info', 'consumer.already_claimed', { intent_id: message.intent_id });
    return { action: 'noop', reason: 'already_claimed_or_terminal' };
  }

  const creator = intent.creator_id ? await repo.getCreator(intent.creator_id) : null;
  const session = intent.session_id ? await repo.getSession(intent.session_id) : null;

  if (intent.creator_id && !creator) {
    await repo.markIntentSkipped(intent.intent_id, 'creator_missing');
    return { action: 'skipped', intent_id: intent.intent_id, reason: 'creator_missing' };
  }

  if (creator) {
    const decision = await evaluateSendGates(repo, env, cfg, {
      creator,
      channel: intent.channel,
      event: intent.event,
      session,
      estimatedCostUsd: intent.estimated_cost_usd,
      now: nowSec(),
      excludeIntentId: intent.intent_id,
    });
    if (!decision.allowed) {
      await repo.markIntentSkipped(intent.intent_id, decision.reason);
      await repo.appendEvent({
        event_type: 'NEEDS_ATTENTION',
        creator_id: intent.creator_id,
        session_id: intent.session_id,
        intent_id: intent.intent_id,
        channel: intent.channel,
        detail: { stage: 'send', reason: decision.reason },
      });
      return { action: 'skipped', intent_id: intent.intent_id, reason: decision.reason };
    }
  }

  // Re-validate the asset at send time; approval can be withdrawn after queueing.
  let assetUrl: string | null = null;
  if (intent.public_asset_ref && intent.creator_id) {
    const asset = await resolvePublicAsset(repo, cfg, intent.creator_id, intent.public_asset_ref);
    if (asset.ok) {
      assetUrl = asset.url;
    } else {
      log('warn', 'consumer.asset_dropped', {
        intent_id: intent.intent_id,
        reason: asset.reason,
      });
    }
  }

  const result = await dispatch(repo, env, cfg, intent, assetUrl, fetchImpl);

  if (result.ok) {
    if (intent.channel === 'manual_x') {
      await repo.markIntentAwaitingManual(intent.intent_id, 'x_api_unavailable_manual_handoff');
      await repo.appendEvent({
        event_type: 'LIVE_POST_QUEUED',
        creator_id: intent.creator_id,
        session_id: intent.session_id,
        intent_id: intent.intent_id,
        channel: intent.channel,
        detail: { handoff: 'manual_x' },
      });
      return { action: 'awaiting_manual', intent_id: intent.intent_id };
    }

    await repo.markIntentSent(intent.intent_id, result.provider_post_id, result.cost_usd);
    await repo.appendEvent({
      event_type: 'LIVE_POSTED',
      creator_id: intent.creator_id,
      session_id: intent.session_id,
      intent_id: intent.intent_id,
      channel: intent.channel,
      detail: { provider_post_id: result.provider_post_id, cost_usd: result.cost_usd },
    });
    return { action: 'sent', intent_id: intent.intent_id };
  }

  // An X auth or budget wall is not a retry: it is a standing condition. Park the
  // announcement with a human instead of burning attempts against it.
  const isXWall =
    intent.channel === 'x' &&
    (result.error_class === 'x_auth_unavailable' ||
      result.error_class === 'x_http_401' ||
      result.error_class === 'x_http_402' ||
      result.error_class === 'x_http_403');

  if (isXWall && channelGate(env, 'manual_x').allowed) {
    await repo.markIntentSkipped(intent.intent_id, `escalated_to_manual:${result.error_class}`);
    const escalated = await escalateToManual(repo, env, intent);
    await repo.appendEvent({
      event_type: 'POST_FAILED',
      creator_id: intent.creator_id,
      session_id: intent.session_id,
      intent_id: intent.intent_id,
      channel: intent.channel,
      detail: { reason: result.error_class, escalated_intent_id: escalated },
    });
    return {
      action: 'skipped',
      intent_id: intent.intent_id,
      reason: `escalated_to_manual:${result.error_class}`,
    };
  }

  const canRetry = result.retryable && intent.attempts < MAX_ATTEMPTS;
  await repo.markIntentFailed(intent.intent_id, result.error_class, result.message, !canRetry);
  await repo.appendEvent({
    event_type: canRetry ? 'POST_FAILED' : 'NEEDS_ATTENTION',
    creator_id: intent.creator_id,
    session_id: intent.session_id,
    intent_id: intent.intent_id,
    channel: intent.channel,
    detail: { error_class: result.error_class, attempts: intent.attempts, retrying: canRetry },
  });

  return canRetry
    ? { action: 'retry', intent_id: intent.intent_id, reason: result.error_class }
    : { action: 'failed', intent_id: intent.intent_id, reason: result.error_class };
}

async function dispatch(
  repo: Repo,
  env: Env,
  cfg: Config,
  intent: OutboundIntent,
  assetUrl: string | null,
  fetchImpl: typeof fetch,
): Promise<SendResult> {
  if (intent.channel === 'manual_x') {
    return queueManualHandoff(
      env,
      { intent, assetUrl, reason: intent.skip_reason ?? 'manual_fallback' },
      fetchImpl,
    );
  }

  if (cfg.broadcasterMode === 'broadcaster') {
    return forwardToBroadcaster(env, cfg, intent, assetUrl, fetchImpl);
  }

  switch (intent.channel) {
    case 'x':
      return sendToX(
        repo,
        env,
        cfg,
        {
          creatorId: intent.creator_id,
          caption: intent.caption,
          assetUrl,
          assetKind: null,
          costUsd: intent.estimated_cost_usd,
        },
        fetchImpl,
      );
    case 'telegram':
      return sendToTelegram(env, { caption: intent.caption, assetUrl }, fetchImpl);
    case 'bluesky':
      return sendToBluesky(env, { caption: intent.caption, assetUrl }, fetchImpl);
  }
}

/**
 * Mirror a blocked X intent onto the manual channel, keeping the same copy and
 * link. The manual channel gets its own idempotency key, so the hand-off itself
 * can only ever be created once.
 */
async function escalateToManual(
  repo: Repo,
  env: Env,
  intent: OutboundIntent,
): Promise<string | null> {
  if (!intent.creator_id) return null;

  const session = intent.session_id ? await repo.getSession(intent.session_id) : null;
  const manualId = newId('int');
  const key = idempotencyKey({
    creatorId: intent.creator_id,
    providerRoomId: intent.provider_room_id,
    sessionStartEpoch: session?.session_start_epoch ?? null,
    scheduleId: intent.schedule_id,
    event: intent.event,
    channel: 'manual_x',
  });

  const created = await repo.insertIntentIfAbsent({
    intent_id: manualId,
    idempotency_key: key,
    type: intent.type,
    creator_id: intent.creator_id,
    provider_room_id: intent.provider_room_id,
    session_id: intent.session_id,
    schedule_id: intent.schedule_id,
    campaign_id: intent.campaign_id,
    event: intent.event,
    channel: 'manual_x',
    scheduled_at: intent.scheduled_at,
    caption: intent.caption,
    caption_hash: intent.caption_hash,
    variant_id: intent.variant_id,
    public_link: intent.public_link,
    public_asset_ref: intent.public_asset_ref,
    approval_mode: 'manual',
    status: 'queued',
    estimated_cost_usd: 0,
  });

  if (!created) return null;

  try {
    await env.OUTBOUND.send({ intent_id: manualId, idempotency_key: key, attempt_hint: 0 });
  } catch (err) {
    log('warn', 'consumer.manual_publish_failed', { intent_id: manualId, error: String(err) });
  }
  return manualId;
}
