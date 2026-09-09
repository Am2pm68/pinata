import { isValidUsername } from './compliance';
import type { LiveModelSummary, LiveStreamsEnv } from './types';

export class StripCashNotConfiguredError extends Error {
  constructor() {
    super(
      'StripCash aggregator API is not configured (missing STRIPCASH_API_BASE, STRIPCASH_API_KEY, or STRIPCASH_MODELS_PATH).'
    );
    this.name = 'StripCashNotConfiguredError';
  }
}

function profileUrl(username: string): string {
  return `https://topnotch.toiaf.com/live/model/${username}/`;
}

// stripcash.com is not reachable from this environment, so the exact
// response field names below are unverified. Confirm against a real
// response once STRIPCASH_API_KEY is issued and adjust only this mapping.
function normalizeModel(raw: unknown): LiveModelSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const username = record.username ?? record.modelName ?? record.name;
  if (typeof username !== 'string' || !isValidUsername(username)) return null;

  const liveRaw = record.live ?? record.isLive ?? record.online ?? record.status;
  const live = liveRaw === true || liveRaw === 'online' || liveRaw === 'live';

  return { username, live, profileUrl: profileUrl(username) };
}

function extractList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const candidate = record.models ?? record.data ?? record.results;
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export async function fetchStripCashModels(env: LiveStreamsEnv): Promise<LiveModelSummary[]> {
  const { STRIPCASH_API_BASE, STRIPCASH_API_KEY, STRIPCASH_MODELS_PATH } = env;
  if (!STRIPCASH_API_BASE || !STRIPCASH_API_KEY || !STRIPCASH_MODELS_PATH) {
    throw new StripCashNotConfiguredError();
  }

  const url = new URL(STRIPCASH_MODELS_PATH, STRIPCASH_API_BASE);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${STRIPCASH_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`StripCash aggregator API responded ${response.status}`);
  }

  const body = await response.json();
  return extractList(body)
    .map(normalizeModel)
    .filter((model): model is LiveModelSummary => model !== null);
}
