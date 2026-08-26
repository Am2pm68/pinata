import type { Repo } from '../db/repo';
import type { Config } from '../env';
import type { LiveSession, ProviderLiveModel } from '../types';
import { sessionIdFor } from '../lib/ids';
import { log } from '../lib/log';

export interface DetectionResult {
  /** Sessions promoted to `confirmed` on this cycle. These, and only these, may announce. */
  confirmed: LiveSession[];
  /** Sessions closed out on this cycle. */
  ended: LiveSession[];
  /** New sessions opened on this cycle. */
  detected: LiveSession[];
  /** Rooms seen live but deliberately not eligible to post, with the reason. */
  suppressed: Array<{ session_id: string; reason: string }>;
  reconnected: string[];
}

/** Session start bucket, used only when the provider gives us no start time. */
function fallbackSessionStart(now: number): number {
  return Math.floor(now / 60) * 60;
}

/**
 * One detection cycle.
 *
 * The whole point of this function is that transitions are *sticky*: a room
 * dropping out of the roster for a tick does not end the session, and a room
 * reappearing does not open a new one. Announcements hang off `confirmed`,
 * which is reached only after the online state has held for both a minimum
 * number of consecutive checks and a minimum wall-clock duration.
 */
export async function runDetectionCycle(
  repo: Repo,
  cfg: Config,
  provider: string,
  liveModels: ProviderLiveModel[],
  now: number,
): Promise<DetectionResult> {
  const result: DetectionResult = {
    confirmed: [],
    ended: [],
    detected: [],
    suppressed: [],
    reconnected: [],
  };

  const liveByRoom = new Map<string, ProviderLiveModel>();
  for (const model of liveModels) liveByRoom.set(model.provider_room_id, model);

  const identities = await repo.listPollableIdentities(provider);
  const visitedRooms = new Set<string>();

  for (const identity of identities) {
    visitedRooms.add(identity.provider_room_id);
    try {
      await evaluateRoom(repo, cfg, provider, identity, liveByRoom, now, result);
    } catch (err) {
      // One creator's bad row must never abort detection for everyone else.
      log('error', 'detector.room_failed', {
        creator_id: identity.creator_id,
        provider_room_id: identity.provider_room_id,
        error: String(err),
      });
    }
  }

  // Sweep sessions whose identity is no longer pollable -- creator revoked or
  // un-approved mid-show. They would otherwise stay open forever.
  for (const session of await repo.listOpenSessions(provider)) {
    if (visitedRooms.has(session.provider_room_id)) continue;
    if (liveByRoom.has(session.provider_room_id)) continue;
    await repo.touchSessionOffline(session.session_id);
    const fresh = await repo.getSession(session.session_id);
    if (fresh && shouldEnd(fresh, cfg, now) && (await repo.endSession(fresh.session_id, now))) {
      const ended = await repo.getSession(fresh.session_id);
      if (ended) {
        result.ended.push(ended);
        await repo.appendEvent({
          event_type: 'LIVE_ENDED',
          creator_id: ended.creator_id,
          session_id: ended.session_id,
          detail: { reason: 'identity_no_longer_pollable' },
        });
      }
    }
  }

  return result;
}

function shouldConfirm(session: LiveSession, cfg: Config, now: number): boolean {
  return (
    session.state === 'detected' &&
    session.consecutive_online >= cfg.liveConfirmChecks &&
    now - session.first_seen_live >= cfg.liveConfirmSeconds
  );
}

function shouldEnd(session: LiveSession, cfg: Config, now: number): boolean {
  return (
    session.state !== 'ended' &&
    session.consecutive_offline >= cfg.offlineConfirmChecks &&
    now - session.last_seen_live >= cfg.offlineGraceSeconds
  );
}

async function evaluateRoom(
  repo: Repo,
  cfg: Config,
  provider: string,
  identity: { creator_id: string; provider_room_id: string; provider_username: string },
  liveByRoom: Map<string, ProviderLiveModel>,
  now: number,
  result: DetectionResult,
): Promise<void> {
  const model = liveByRoom.get(identity.provider_room_id);
  const open = await repo.getOpenSessionForRoom(provider, identity.provider_room_id);

  if (!model) {
    if (!open) return;
    await repo.touchSessionOffline(open.session_id);
    const fresh = await repo.getSession(open.session_id);
    if (!fresh) return;
    if (shouldEnd(fresh, cfg, now) && (await repo.endSession(fresh.session_id, now))) {
      const ended = await repo.getSession(fresh.session_id);
      if (ended) {
        result.ended.push(ended);
        await repo.appendEvent({
          event_type: 'LIVE_ENDED',
          creator_id: ended.creator_id,
          session_id: ended.session_id,
          detail: {
            consecutive_offline: ended.consecutive_offline,
            grace_seconds: cfg.offlineGraceSeconds,
          },
        });
      }
    }
    return;
  }

  if (open) {
    // Reconnect inside the grace window: same session, streak reset, no new post.
    if (open.consecutive_offline > 0) {
      result.reconnected.push(open.session_id);
      await repo.appendEvent({
        event_type: 'LIVE_DETECTED',
        creator_id: open.creator_id,
        session_id: open.session_id,
        detail: { reconnect: true, missed_checks: open.consecutive_offline },
      });
    }
    await repo.touchSessionOnline(open.session_id, now, model.show_text);

    const fresh = await repo.getSession(open.session_id);
    if (!fresh) return;
    if (shouldConfirm(fresh, cfg, now) && (await repo.confirmSession(fresh.session_id, now))) {
      const confirmed = await repo.getSession(fresh.session_id);
      if (confirmed) {
        if (confirmed.suppressed_reason) {
          result.suppressed.push({
            session_id: confirmed.session_id,
            reason: confirmed.suppressed_reason,
          });
        } else {
          result.confirmed.push(confirmed);
        }
        await repo.appendEvent({
          event_type: 'LIVE_CONFIRMED',
          creator_id: confirmed.creator_id,
          session_id: confirmed.session_id,
          detail: {
            evidence_class: confirmed.evidence_class,
            consecutive_online: confirmed.consecutive_online,
            suppressed_reason: confirmed.suppressed_reason,
          },
        });
      }
    }
    return;
  }

  // A brand new session.
  //
  // Two guards run before it is allowed to announce later:
  //  1. a room that maps to more than one creator is an ambiguous mapping;
  //  2. a creator already live on a different room is the same person on a
  //     second identity, and must not be announced twice.
  let suppressed: string | null = null;

  const identityCount = await repo.countIdentitiesForRoom(provider, identity.provider_room_id);
  if (identityCount > 1) suppressed = 'ambiguous_room_mapping';

  if (!suppressed) {
    const other = await repo.getOtherOpenSessionForCreator(
      identity.creator_id,
      identity.provider_room_id,
    );
    if (other) suppressed = 'duplicate_provider_identity';
  }

  const sessionStart = model.session_start_epoch ?? fallbackSessionStart(now);
  const sessionId = sessionIdFor(
    identity.creator_id,
    provider,
    identity.provider_room_id,
    sessionStart,
  );

  const created = await repo.insertSessionIfAbsent({
    session_id: sessionId,
    creator_id: identity.creator_id,
    provider,
    provider_room_id: identity.provider_room_id,
    provider_username: identity.provider_username ?? model.username,
    session_start_epoch: sessionStart,
    first_seen_live: now,
    show_text: model.show_text,
    provider_payload_hash: model.raw_hash,
    evidence_class: 'provider_api',
    suppressed_reason: suppressed,
  });

  if (!created) return;

  const session = await repo.getSession(sessionId);
  if (!session) return;

  result.detected.push(session);
  if (suppressed) result.suppressed.push({ session_id: sessionId, reason: suppressed });

  await repo.appendEvent({
    event_type: 'LIVE_DETECTED',
    creator_id: session.creator_id,
    session_id: session.session_id,
    detail: {
      session_start_epoch: sessionStart,
      provider_start: model.session_start_epoch != null,
      suppressed_reason: suppressed,
    },
  });
}
