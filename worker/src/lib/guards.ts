import type { Repo } from '../db/repo';
import type { Config, Env } from '../env';
import { gateOn } from '../env';
import type { Channel, Creator, IntentEvent, LiveSession } from '../types';
import { log } from './log';

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOW = { allowed: true } as const;
const deny = (reason: string): GateDecision => ({ allowed: false, reason });

export const KILL_SWITCH_KEY = 'KILL_SWITCH';
export const killSwitchKeyFor = (channel: Channel) => `KILL_SWITCH_${channel.toUpperCase()}`;

/**
 * Emergency kill switch.
 *
 * Note the catch: if the flag cannot be read at all, we treat the system as
 * killed. An operator who trips the switch during an incident must not be
 * defeated by a database blip re-opening the floodgates.
 */
export async function killSwitchEngaged(repo: Repo, channel: Channel): Promise<GateDecision> {
  try {
    if ((await repo.getFlag(KILL_SWITCH_KEY)) === '1') return deny('kill_switch_global');
    if ((await repo.getFlag(killSwitchKeyFor(channel))) === '1') {
      return deny(`kill_switch_channel:${channel}`);
    }
    return ALLOW;
  } catch (err) {
    log('error', 'guards.kill_switch_unreadable', { channel, error: String(err) });
    return deny('kill_switch_unreadable');
  }
}

/** Per-channel deployment gate. Only the exact string "1" opens a channel. */
export function channelGate(env: Env, channel: Channel): GateDecision {
  switch (channel) {
    case 'x':
      return gateOn(env.TOIAF_ALLOW_AUTO_LIVE_X) ? ALLOW : deny('channel_gate_off:x');
    case 'telegram':
      return gateOn(env.TOIAF_ALLOW_AUTO_LIVE_TELEGRAM)
        ? ALLOW
        : deny('channel_gate_off:telegram');
    case 'bluesky':
      return gateOn(env.TOIAF_ALLOW_AUTO_LIVE_BLUESKY) ? ALLOW : deny('channel_gate_off:bluesky');
    case 'manual_x':
      return gateOn(env.TOIAF_ALLOW_MANUAL_X_FALLBACK)
        ? ALLOW
        : deny('channel_gate_off:manual_x');
  }
}

export function creatorOptedIn(creator: Creator, channel: Channel): GateDecision {
  if (creator.revoked_at != null) return deny('creator_revoked');
  if (creator.approval_status !== 'approved') return deny('creator_not_approved');
  if (creator.mapping_status !== 'confirmed') return deny(`creator_mapping_${creator.mapping_status}`);
  if (!creator.live_promotion_enabled) return deny('live_promotion_disabled');

  const perChannel =
    channel === 'telegram'
      ? creator.auto_post_telegram
      : channel === 'bluesky'
        ? creator.auto_post_bluesky
        : creator.auto_post_x;

  return perChannel ? ALLOW : deny(`creator_channel_off:${channel}`);
}

/** A LIVE NOW post requires confirmed provider live state, never merely detected. */
export function liveStateGate(event: IntentEvent, session: LiveSession | null): GateDecision {
  if (event !== 'live_now') return ALLOW;
  if (!session) return deny('no_session');
  if (session.state !== 'confirmed') return deny(`live_not_confirmed:${session.state}`);
  if (session.suppressed_reason) return deny(`session_suppressed:${session.suppressed_reason}`);
  return ALLOW;
}

/**
 * X is pay-per-use. A misfiring loop is therefore a billing incident as well as
 * a spam incident, so spend is capped per calendar month and an unset budget
 * means "not provisioned" -- which fails closed rather than open.
 */
export async function budgetGate(
  repo: Repo,
  cfg: Config,
  channel: Channel,
  estimatedCostUsd: number,
  now: number,
): Promise<GateDecision> {
  if (channel !== 'x') return ALLOW;
  if (cfg.xMonthlyBudgetUsd <= 0) return deny('x_budget_not_provisioned');

  const override = await repo.getFlag('X_MONTHLY_BUDGET_USD_OVERRIDE');
  const budget = override != null && Number.isFinite(Number(override))
    ? Number(override)
    : cfg.xMonthlyBudgetUsd;

  const spent = await repo.channelSpendThisMonth('x', now);
  if (spent + estimatedCostUsd > budget) {
    return deny(`x_budget_exceeded:${spent.toFixed(3)}/${budget.toFixed(2)}`);
  }
  return ALLOW;
}

/**
 * A session may announce at most once per channel, and two sessions cannot be
 * announced back to back inside the configured minimum interval.
 */
export async function spamGate(
  repo: Repo,
  cfg: Config,
  session: LiveSession | null,
  event: IntentEvent,
  channel: Channel,
  excludeIntentId?: string | null,
): Promise<GateDecision> {
  if (!session || event !== 'live_now') return ALLOW;

  if (await repo.hasSentForSession(session.session_id, event, channel, excludeIntentId)) {
    return deny('already_announced_this_session');
  }

  const previous = await repo.lastEndedSessionBefore(
    session.creator_id,
    session.session_start_epoch,
  );
  if (previous) {
    const gapMinutes = (session.session_start_epoch - previous.session_start_epoch) / 60;
    if (gapMinutes < cfg.minSessionIntervalMinutes) {
      return deny(`min_session_interval:${Math.round(gapMinutes)}m`);
    }
  }
  return ALLOW;
}

export interface SendGateInput {
  creator: Creator;
  channel: Channel;
  event: IntentEvent;
  session: LiveSession | null;
  estimatedCostUsd: number;
  now: number;
  /** The intent being sent, so the spam gate does not trip on its own row. */
  excludeIntentId?: string | null;
}

/**
 * The full fail-closed sequence, in the order the contract lists it. Every
 * caller -- planner and queue consumer alike -- runs this; the consumer's run is
 * the authoritative one, because a creator can revoke in the minute between
 * queueing and sending.
 */
export async function evaluateSendGates(
  repo: Repo,
  env: Env,
  cfg: Config,
  input: SendGateInput,
): Promise<GateDecision> {
  const checks: GateDecision[] = [
    await killSwitchEngaged(repo, input.channel),
    channelGate(env, input.channel),
    creatorOptedIn(input.creator, input.channel),
    liveStateGate(input.event, input.session),
    await spamGate(repo, cfg, input.session, input.event, input.channel, input.excludeIntentId),
    await budgetGate(repo, cfg, input.channel, input.estimatedCostUsd, input.now),
  ];
  for (const check of checks) {
    if (!check.allowed) return check;
  }
  return ALLOW;
}
