import type { Config, Env } from '../env';
import type { ProviderLiveModel } from '../types';
import { sha256Hex } from '../lib/hash';
import { log } from '../lib/log';

/**
 * Provider live-state source.
 *
 * This reads the StripCash Aggregators API through the Worker, which is the
 * same authoritative path the existing TOiAF Live Aggregator uses. It does not
 * and must not parse stream.npntoi HTML: a markup change would silently turn
 * into false live/offline transitions and, downstream, into wrong posts.
 */
export interface ProviderFetchOk {
  ok: true;
  models: ProviderLiveModel[];
  evidence_class: 'provider_api';
}
export interface ProviderFetchFailed {
  ok: false;
  error: string;
}
export type ProviderFetchResult = ProviderFetchOk | ProviderFetchFailed;

interface RawModel {
  id?: number | string;
  username?: string;
  name?: string;
  status?: string;
  isLive?: boolean;
  online?: boolean;
  broadcastStartedAt?: string | number;
  startedAt?: string | number;
  streamStartedAt?: string | number;
  subject?: string;
  topic?: string;
  goal?: string;
}

function asEpochSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Tolerate both second and millisecond precision from the provider.
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

/**
 * The aggregator feed is a public listing, so field names vary by account and
 * by API revision. Normalising defensively here means a renamed field degrades
 * to "no show text" rather than to a crash mid-cycle.
 */
export async function normaliseModel(raw: RawModel): Promise<ProviderLiveModel | null> {
  const roomId = raw.id != null ? String(raw.id) : null;
  const username = raw.username ?? raw.name ?? null;
  if (!roomId || !username) return null;

  const isLive =
    raw.isLive === true ||
    raw.online === true ||
    (typeof raw.status === 'string' && raw.status.toLowerCase() === 'public');

  const showText = raw.subject ?? raw.topic ?? raw.goal ?? null;

  return {
    provider_room_id: roomId,
    username,
    is_live: isLive,
    session_start_epoch:
      asEpochSeconds(raw.broadcastStartedAt) ??
      asEpochSeconds(raw.startedAt) ??
      asEpochSeconds(raw.streamStartedAt),
    show_text: showText,
    raw_hash: await sha256Hex(`${roomId}|${isLive}|${showText ?? ''}`),
  };
}

/**
 * Fetch the live roster.
 *
 * On any failure this returns `ok: false` rather than an empty roster. That
 * distinction matters: an empty roster would look like "everybody went offline"
 * and would end every open session at once. A failed fetch must leave live
 * state exactly as it was.
 */
export async function fetchLiveModels(
  env: Env,
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderFetchResult> {
  if (!cfg.providerApiBase) {
    return { ok: false, error: 'provider_api_base_not_configured' };
  }

  const models: ProviderLiveModel[] = [];
  const limit = cfg.providerPageLimit;
  let offset = 0;

  // Bounded pagination: a runaway `total` from the provider must not turn one
  // cron tick into an unbounded fetch loop.
  for (let page = 0; page < 20; page++) {
    const url = new URL(cfg.providerApiBase);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    if (env.PROVIDER_API_KEY) url.searchParams.set('userId', env.PROVIDER_API_KEY);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, error: `provider_fetch_failed:${String(err)}` };
    }

    if (!response.ok) {
      return { ok: false, error: `provider_http_${response.status}` };
    }

    let body: { models?: RawModel[]; total?: number };
    try {
      body = (await response.json()) as { models?: RawModel[]; total?: number };
    } catch (err) {
      return { ok: false, error: `provider_bad_json:${String(err)}` };
    }

    const batch = body.models ?? [];
    for (const raw of batch) {
      const model = await normaliseModel(raw);
      if (model?.is_live) models.push(model);
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  log('info', 'provider.roster', { live_count: models.length });
  return { ok: true, models, evidence_class: 'provider_api' };
}
