import type { Channel, IntentEvent } from '../types';

/**
 * Deterministic session identity. Built from the provider room and the session
 * start epoch so that the same live show always resolves to the same row, even
 * across Worker restarts or overlapping cron fires.
 */
export function sessionIdFor(
  creatorId: string,
  provider: string,
  providerRoomId: string,
  sessionStartEpoch: number,
): string {
  return `${creatorId}:${provider}:${providerRoomId}:${sessionStartEpoch}`;
}

/**
 * The exactly-once key from the build contract:
 *   creator + provider room + live session + event + channel.
 *
 * Schedule-driven events fire before any session exists, so they anchor on the
 * schedule id instead -- still one row, still unique, still un-repeatable.
 */
export function idempotencyKey(parts: {
  creatorId: string;
  providerRoomId: string | null;
  sessionStartEpoch: number | null;
  scheduleId: string | null;
  event: IntentEvent;
  channel: Channel;
  campaignId?: string | null;
  promoPostId?: string | null;
}): string {
  const anchor =
    parts.promoPostId != null
      ? `promo:${parts.promoPostId}`
      : parts.sessionStartEpoch != null
        ? `ses:${parts.sessionStartEpoch}`
        : parts.scheduleId != null
          ? `sch:${parts.scheduleId}`
          : 'none';
  const room = parts.providerRoomId ?? 'noroom';
  return `${parts.creatorId}|${room}|${anchor}|${parts.event}|${parts.channel}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
