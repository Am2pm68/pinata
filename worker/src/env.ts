import type { OutboundMessage } from './types';

export interface Env {
  DB: D1Database;
  OUTBOUND: Queue<OutboundMessage>;

  // Channel gates -- only the exact string "1" enables a channel.
  TOIAF_ALLOW_AUTO_LIVE_X?: string;
  TOIAF_ALLOW_AUTO_LIVE_TELEGRAM?: string;
  TOIAF_ALLOW_AUTO_LIVE_BLUESKY?: string;
  TOIAF_ALLOW_MANUAL_X_FALLBACK?: string;

  // Live detection / flap suppression
  LIVE_CONFIRM_CHECKS?: string;
  LIVE_CONFIRM_SECONDS?: string;
  OFFLINE_CONFIRM_CHECKS?: string;
  OFFLINE_GRACE_SECONDS?: string;

  // Scheduling
  REMINDER_LEAD_MINUTES?: string;
  ANNOUNCE_LEAD_MINUTES?: string;
  SCHEDULE_DUE_TOLERANCE_SECONDS?: string;
  MIN_SESSION_INTERVAL_MINUTES?: string;
  DEDUPE_WINDOW_DAYS?: string;

  // Public surfaces
  PUBLIC_ORIGIN?: string;
  STREAM_ORIGIN?: string;
  GO_LINK_ORIGIN?: string;
  PUBLIC_ASSET_ALLOWED_HOSTS?: string;

  // Provider
  PROVIDER_NAME?: string;
  PROVIDER_API_BASE?: string;
  PROVIDER_PAGE_LIMIT?: string;
  PROVIDER_API_KEY?: string;

  // X budget guard
  X_COST_PER_POST_USD?: string;
  X_COST_PER_POST_WITH_URL_USD?: string;
  X_MONTHLY_BUDGET_USD?: string;

  // Broadcaster hand-off
  BROADCASTER_MODE?: string;
  BROADCASTER_INTENT_URL?: string;
  BROADCASTER_HMAC_SECRET?: string;

  // Secrets
  TOIAF_API_HMAC_SECRET?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  BLUESKY_SERVICE?: string;
  BLUESKY_IDENTIFIER?: string;
  BLUESKY_APP_PASSWORD?: string;
  ADMIN_NOTIFY_WEBHOOK?: string;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Gates are deliberately strict: anything that is not exactly "1" is OFF.
 * A typo in a var can only ever close a channel, never open one.
 */
export function gateOn(raw: string | undefined): boolean {
  return raw === '1';
}

export interface Config {
  liveConfirmChecks: number;
  liveConfirmSeconds: number;
  offlineConfirmChecks: number;
  offlineGraceSeconds: number;
  reminderLeadMinutes: number;
  announceLeadMinutes: number;
  scheduleDueToleranceSeconds: number;
  minSessionIntervalMinutes: number;
  dedupeWindowDays: number;
  publicOrigin: string;
  streamOrigin: string;
  goLinkOrigin: string;
  publicAssetAllowedHosts: string[];
  providerName: string;
  providerApiBase: string;
  providerPageLimit: number;
  xCostPerPostUsd: number;
  xCostPerPostWithUrlUsd: number;
  xMonthlyBudgetUsd: number;
  broadcasterMode: 'direct' | 'broadcaster';
  broadcasterIntentUrl: string;
}

export function config(env: Env): Config {
  return {
    liveConfirmChecks: num(env.LIVE_CONFIRM_CHECKS, 2),
    liveConfirmSeconds: num(env.LIVE_CONFIRM_SECONDS, 90),
    offlineConfirmChecks: num(env.OFFLINE_CONFIRM_CHECKS, 3),
    offlineGraceSeconds: num(env.OFFLINE_GRACE_SECONDS, 300),
    reminderLeadMinutes: num(env.REMINDER_LEAD_MINUTES, 60),
    announceLeadMinutes: num(env.ANNOUNCE_LEAD_MINUTES, 0),
    scheduleDueToleranceSeconds: num(env.SCHEDULE_DUE_TOLERANCE_SECONDS, 900),
    minSessionIntervalMinutes: num(env.MIN_SESSION_INTERVAL_MINUTES, 180),
    dedupeWindowDays: num(env.DEDUPE_WINDOW_DAYS, 14),
    publicOrigin: env.PUBLIC_ORIGIN ?? 'https://toiaf.com',
    streamOrigin: env.STREAM_ORIGIN ?? 'https://stream.npntoi.com',
    goLinkOrigin: env.GO_LINK_ORIGIN ?? env.PUBLIC_ORIGIN ?? 'https://toiaf.com',
    publicAssetAllowedHosts: (env.PUBLIC_ASSET_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    providerName: env.PROVIDER_NAME ?? 'stripcash',
    providerApiBase: env.PROVIDER_API_BASE ?? '',
    providerPageLimit: num(env.PROVIDER_PAGE_LIMIT, 500),
    xCostPerPostUsd: num(env.X_COST_PER_POST_USD, 0.015),
    xCostPerPostWithUrlUsd: num(env.X_COST_PER_POST_WITH_URL_USD, 0.2),
    xMonthlyBudgetUsd: num(env.X_MONTHLY_BUDGET_USD, 0),
    broadcasterMode: env.BROADCASTER_MODE === 'broadcaster' ? 'broadcaster' : 'direct',
    broadcasterIntentUrl: env.BROADCASTER_INTENT_URL ?? '',
  };
}
