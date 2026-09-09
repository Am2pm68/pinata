import { isCountryAllowed, isFresh, isValidUsername, parseBannedCountries, REFRESH_INTERVAL_MS } from './compliance';
import { createTtlCache } from './cache';
import { fetchStripCashModels } from './stripcash';
import type { LiveFeedResponse, LiveModelSummary, LiveStreamsEnv } from './types';

const feedCache = createTtlCache<LiveModelSummary[]>(REFRESH_INTERVAL_MS);

async function getFeed(env: LiveStreamsEnv, nowMs: number) {
  const cached = feedCache.read(nowMs);
  if (cached) return cached;

  const models = await fetchStripCashModels(env);
  feedCache.write(models, nowMs);
  return { value: models, fetchedAtMs: nowMs };
}

export async function listLiveModels(
  env: LiveStreamsEnv,
  viewerCountry: string | undefined,
  nowMs: number = Date.now()
): Promise<LiveFeedResponse> {
  const banned = parseBannedCountries(env.STRIPCASH_BANNED_COUNTRIES);
  if (!isCountryAllowed(viewerCountry, banned)) {
    return { models: [], fetchedAt: new Date(nowMs).toISOString(), stale: false };
  }

  const { value: models, fetchedAtMs } = await getFeed(env, nowMs);
  return {
    models: models.filter((model) => model.live),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    stale: !isFresh(fetchedAtMs, nowMs),
  };
}

export async function getModelStatus(
  env: LiveStreamsEnv,
  username: string,
  viewerCountry: string | undefined,
  nowMs: number = Date.now()
): Promise<LiveModelSummary | null> {
  if (!isValidUsername(username)) return null;

  const banned = parseBannedCountries(env.STRIPCASH_BANNED_COUNTRIES);
  if (!isCountryAllowed(viewerCountry, banned)) return null;

  const { value: models } = await getFeed(env, nowMs);
  return models.find((model) => model.username.toLowerCase() === username.toLowerCase()) ?? null;
}
