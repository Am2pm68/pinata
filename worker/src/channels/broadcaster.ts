import type { Config, Env } from '../env';
import type { OutboundIntent, SendResult } from '../types';
import { hmacSha256Hex } from '../lib/hmac';

/**
 * Hand an intent to the existing toiaf-drop-broadcaster instead of sending from
 * here.
 *
 * This exists so the network keeps ONE outbound social authority. When
 * BROADCASTER_MODE is "broadcaster", this Worker stays the scheduler, the live
 * detector and the idempotency owner, and the broadcaster remains the thing
 * that actually talks to channels -- including its existing approval gates,
 * watermark checks and link validation, which are not duplicated here.
 */
export async function forwardToBroadcaster(
  env: Env,
  cfg: Config,
  intent: OutboundIntent,
  assetUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!cfg.broadcasterIntentUrl) {
    return {
      ok: false,
      retryable: false,
      error_class: 'broadcaster_not_configured',
      message: 'BROADCASTER_INTENT_URL is empty',
    };
  }

  const body = JSON.stringify({
    type: intent.type,
    creator_id: intent.creator_id,
    provider_room_id: intent.provider_room_id,
    session_id: intent.session_id,
    event: intent.event,
    scheduled_at: intent.scheduled_at,
    channel: intent.channel,
    caption: intent.caption,
    public_link: intent.public_link,
    public_asset_ref: intent.public_asset_ref,
    public_asset_url: assetUrl,
    approval_mode: intent.approval_mode,
    idempotency_key: intent.idempotency_key,
    status: intent.status,
  });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.BROADCASTER_HMAC_SECRET) {
    headers['x-toiaf-signature'] = await hmacSha256Hex(env.BROADCASTER_HMAC_SECRET, body);
  }

  let response: Response;
  try {
    response = await fetchImpl(cfg.broadcasterIntentUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error_class: 'broadcaster_network', message: String(err) };
  }

  const text = await response.text().catch(() => '');
  if (response.ok) {
    let postId: string | null = null;
    try {
      postId = (JSON.parse(text) as { provider_post_id?: string }).provider_post_id ?? null;
    } catch {
      postId = null;
    }
    return { ok: true, provider_post_id: postId, cost_usd: 0 };
  }

  return {
    ok: false,
    retryable: response.status === 429 || response.status >= 500,
    error_class: `broadcaster_http_${response.status}`,
    message: text.slice(0, 300),
  };
}
