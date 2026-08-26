import type { Env } from '../env';
import type { OutboundIntent, SendResult } from '../types';
import { log } from '../lib/log';

/**
 * The free X fallback.
 *
 * When the API path is unavailable -- no credits, no budget, no credentials --
 * the announcement is not silently dropped. The intent survives, a human is
 * notified, and they post from an already-authenticated browser with one tap.
 *
 * What this deliberately does NOT do is drive that browser for them. Automating
 * clicks or replaying session cookies to dodge API billing is against X's rules
 * and turns a creator's session into another secret we would have to defend.
 */
export function composerUrl(caption: string): string {
  const url = new URL('https://x.com/intent/post');
  url.searchParams.set('text', caption);
  return url.toString();
}

export interface ManualHandoffInput {
  intent: OutboundIntent;
  assetUrl: string | null;
  reason: string;
}

export async function queueManualHandoff(
  env: Env,
  input: ManualHandoffInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const composer = composerUrl(input.intent.caption);

  const payload = {
    kind: 'manual_x_handoff',
    intent_id: input.intent.intent_id,
    creator_id: input.intent.creator_id,
    event: input.intent.event,
    scheduled_at: input.intent.scheduled_at,
    caption: input.intent.caption,
    public_link: input.intent.public_link,
    asset_url: input.assetUrl,
    composer_url: composer,
    reason: input.reason,
  };

  if (env.ADMIN_NOTIFY_WEBHOOK) {
    try {
      const response = await fetchImpl(env.ADMIN_NOTIFY_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return {
          ok: false,
          retryable: response.status >= 500,
          error_class: `manual_notify_http_${response.status}`,
          message: 'admin notify webhook rejected the hand-off',
        };
      }
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error_class: 'manual_notify_network',
        message: String(err),
      };
    }
  } else if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `POST TO X (${input.reason})\n\n${input.intent.caption}\n\n${composer}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log('warn', 'manual.telegram_notify_failed', { error: String(err) });
    }
  } else {
    log('warn', 'manual.no_notify_channel', { intent_id: input.intent.intent_id });
  }

  // Not an error: the intent is parked awaiting a human, and the consumer marks
  // it `awaiting_manual` rather than `sent`.
  return { ok: true, provider_post_id: null, cost_usd: 0 };
}
