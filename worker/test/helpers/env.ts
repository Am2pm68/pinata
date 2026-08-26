import type { Env } from '../../src/env';
import type { OutboundMessage } from '../../src/types';
import { makeD1 } from './d1';

export interface TestHarness {
  env: Env;
  sent: OutboundMessage[];
  /** Requests the code attempted to make, in order. */
  calls: Array<{ url: string; init?: RequestInit }>;
  fetch: typeof fetch;
  setResponder(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): void;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function makeHarness(overrides: Partial<Env> = {}): TestHarness {
  const sent: OutboundMessage[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  let responder: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    jsonResponse({ ok: true });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;

  const env: Env = {
    DB: makeD1(),
    OUTBOUND: {
      send: async (message: OutboundMessage) => {
        sent.push(message);
      },
      sendBatch: async () => {},
    } as unknown as Queue<OutboundMessage>,

    // Gates default ON in tests unless a case turns them off; the fail-closed
    // defaults themselves are covered by their own test.
    TOIAF_ALLOW_AUTO_LIVE_X: '1',
    TOIAF_ALLOW_AUTO_LIVE_TELEGRAM: '1',
    TOIAF_ALLOW_AUTO_LIVE_BLUESKY: '1',
    TOIAF_ALLOW_MANUAL_X_FALLBACK: '1',

    LIVE_CONFIRM_CHECKS: '2',
    LIVE_CONFIRM_SECONDS: '90',
    OFFLINE_CONFIRM_CHECKS: '3',
    OFFLINE_GRACE_SECONDS: '300',

    REMINDER_LEAD_MINUTES: '60',
    ANNOUNCE_LEAD_MINUTES: '0',
    SCHEDULE_DUE_TOLERANCE_SECONDS: '900',
    MIN_SESSION_INTERVAL_MINUTES: '180',
    DEDUPE_WINDOW_DAYS: '14',

    PUBLIC_ORIGIN: 'https://toiaf.com',
    STREAM_ORIGIN: 'https://stream.npntoi.com',
    GO_LINK_ORIGIN: 'https://toiaf.com',
    PUBLIC_ASSET_ALLOWED_HOSTS: 'cdn.toiaf.com',

    PROVIDER_NAME: 'stripcash',
    PROVIDER_API_BASE: 'https://provider.test/api/models',
    PROVIDER_PAGE_LIMIT: '500',

    X_COST_PER_POST_USD: '0.015',
    X_COST_PER_POST_WITH_URL_USD: '0.200',
    X_MONTHLY_BUDGET_USD: '50',

    X_API_KEY: 'ck',
    X_API_SECRET: 'cs',
    X_ACCESS_TOKEN: 'at',
    X_ACCESS_SECRET: 'as',
    TELEGRAM_BOT_TOKEN: 'tg',
    TELEGRAM_CHAT_ID: '-100',
    BLUESKY_IDENTIFIER: 'toiaf.bsky.social',
    BLUESKY_APP_PASSWORD: 'pw',
    TOIAF_API_HMAC_SECRET: 'test-secret',

    ...overrides,
  };

  return {
    env,
    sent,
    calls,
    fetch: fetchImpl,
    setResponder(fn) {
      responder = fn;
    },
  };
}
