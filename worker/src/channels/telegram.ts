import type { Env } from '../env';
import type { SendResult } from '../types';

const API_BASE = 'https://api.telegram.org';

export interface TelegramSendInput {
  caption: string;
  assetUrl: string | null;
  chatId?: string | null;
}

export async function sendToTelegram(
  env: Env,
  input: TelegramSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = input.chatId ?? env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return {
      ok: false,
      retryable: false,
      error_class: 'telegram_auth_unavailable',
      message: 'bot token or chat id not configured',
    };
  }

  // sendPhoto renders the approved card inline; sendMessage is the text path.
  const method = input.assetUrl ? 'sendPhoto' : 'sendMessage';
  const payload: Record<string, unknown> = input.assetUrl
    ? { chat_id: chatId, photo: input.assetUrl, caption: input.caption }
    : { chat_id: chatId, text: input.caption, disable_web_page_preview: false };

  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error_class: 'telegram_network', message: String(err) };
  }

  const text = await response.text().catch(() => '');
  if (response.ok) {
    let messageId: string | null = null;
    try {
      const json = JSON.parse(text) as { result?: { message_id?: number } };
      messageId = json.result?.message_id != null ? String(json.result.message_id) : null;
    } catch {
      messageId = null;
    }
    return { ok: true, provider_post_id: messageId, cost_usd: 0 };
  }

  const retryable = response.status === 429 || response.status >= 500;
  return {
    ok: false,
    retryable,
    error_class: `telegram_http_${response.status}`,
    message: text.slice(0, 300),
  };
}
