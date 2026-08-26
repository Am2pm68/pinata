import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/routes';
import { Repo } from '../src/db/repo';
import { hmacSha256Hex } from '../src/lib/hmac';
import { runCron } from '../src/schedule/cron';
import { rosterPayload, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';
import { restoreClock, setClock, useFixedClock } from './helpers/clock';

const app = buildApp();
const SECRET = 'test-secret';

async function signed(
  env: ReturnType<typeof makeHarness>['env'],
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await hmacSha256Hex(SECRET, `${ts}.${method.toUpperCase()}.${path}.${raw}`);

  return app.fetch(
    new Request(`https://toiaf.com${path}`, {
      method,
      headers: {
        'x-toiaf-signature': signature,
        'x-toiaf-timestamp': ts,
        'content-type': 'application/json',
      },
      ...(raw ? { body: raw } : {}),
    }),
    env,
  );
}

describe('RichGirls API', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('rejects an unsigned request', async () => {
    const h = makeHarness();
    const response = await app.fetch(
      new Request('https://toiaf.com/api/v1/creators/cr_gemmi/live-promotion'),
      h.env,
    );
    expect(response.status).toBe(401);
  });

  it('rejects a tampered body', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const path = '/api/v1/creators/cr_gemmi/live-promotion';
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await hmacSha256Hex(SECRET, `${ts}.PUT.${path}.{"live_promotion":false}`);

    const response = await app.fetch(
      new Request(`https://toiaf.com${path}`, {
        method: 'PUT',
        headers: { 'x-toiaf-signature': signature, 'x-toiaf-timestamp': ts },
        body: JSON.stringify({ live_promotion: true }),
      }),
      h.env,
    );
    expect(response.status).toBe(401);
  });

  it('rejects a replayed request outside the skew window', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const path = '/api/v1/creators/cr_gemmi/live-promotion';
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const signature = await hmacSha256Hex(SECRET, `${stale}.GET.${path}.`);

    const response = await app.fetch(
      new Request(`https://toiaf.com${path}`, {
        headers: { 'x-toiaf-signature': signature, 'x-toiaf-timestamp': stale },
      }),
      h.env,
    );
    expect(response.status).toBe(401);
  });

  it('returns the LIVE PROMOTION panel state', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const response = await signed(h.env, 'GET', '/api/v1/creators/cr_gemmi/live-promotion');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.live_promotion).toBe(true);
    expect(body.auto_post).toMatchObject({ x: true, telegram: false, bluesky: false });
    expect(body.public_link).toBe('https://toiaf.com/go/live/cr_gemmi');
    expect(body.currently_live).toBe(false);
  });

  it('updates channel toggles', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const response = await signed(h.env, 'PUT', '/api/v1/creators/cr_gemmi/live-promotion', {
      auto_post: { telegram: true, x: false },
    });
    expect(response.status).toBe(200);

    const creator = await new Repo(h.env.DB).getCreator('cr_gemmi');
    expect(creator!.auto_post_telegram).toBe(1);
    expect(creator!.auto_post_x).toBe(0);
  });

  it('revokes immediately and cancels queued intents', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder((url) =>
      url.startsWith('https://provider.test')
        ? jsonResponse(rosterPayload([{ id: 'room_1', username: 'gemmikakes', started: T0 }]))
        : jsonResponse({ data: { id: 'x1' } }, 201),
    );
    for (const offset of [0, 60, 120]) {
      setClock(T0 + offset);
      await runCron(h.env, h.fetch, T0 + offset);
    }
    expect(h.sent).toHaveLength(1);

    setClock(T0 + 130);
    const response = await signed(h.env, 'POST', '/api/v1/creators/cr_gemmi/revoke', {
      reason: 'creator_request',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, cancelled_intents: 1 });

    const repo = new Repo(h.env.DB);
    expect((await repo.getIntent(h.sent[0]!.intent_id))!.status).toBe('cancelled');
    expect((await repo.getCreator('cr_gemmi'))!.revoked_at).not.toBeNull();
  });

  it('accepts a creator-entered schedule and rejects one with no start time', async () => {
    const h = makeHarness();
    await seedCreator(h.env);

    const ok = await signed(h.env, 'POST', '/api/v1/creators/cr_gemmi/schedule', {
      starts_at_utc: T0 + 7200,
      source_timezone: 'America/New_York',
      show_text: 'Late show',
    });
    expect(ok.status).toBe(200);
    const created = (await ok.json()) as { schedule_id: string };
    expect(created.schedule_id).toMatch(/^sch_/);

    const bad = await signed(h.env, 'POST', '/api/v1/creators/cr_gemmi/schedule', {
      show_text: 'no time',
    });
    expect(bad.status).toBe(400);
  });

  it('rejects an unrecognised schedule source', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const response = await signed(h.env, 'POST', '/api/v1/creators/cr_gemmi/schedule', {
      starts_at_utc: T0 + 7200,
      source: 'inferred_from_history',
    });
    expect(response.status).toBe(400);
  });

  it('renders a post preview without queueing anything', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const response = await signed(h.env, 'POST', '/api/v1/creators/cr_gemmi/preview', {
      event: 'live_now',
      channel: 'x',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { caption: string };
    expect(body.caption).toContain('@gemmikakes');
    expect(h.sent).toHaveLength(0);
  });

  it('engages and clears the kill switch', async () => {
    const h = makeHarness();
    const repo = new Repo(h.env.DB);

    await signed(h.env, 'POST', '/api/v1/admin/kill-switch', { engaged: true, actor: 'owner' });
    expect(await repo.getFlag('KILL_SWITCH')).toBe('1');

    await signed(h.env, 'POST', '/api/v1/admin/kill-switch', { engaged: false, actor: 'owner' });
    expect(await repo.getFlag('KILL_SWITCH')).toBe('0');
  });

  it('reports gate and spend status', async () => {
    const h = makeHarness({ TOIAF_ALLOW_AUTO_LIVE_BLUESKY: '0' });
    const response = await signed(h.env, 'GET', '/api/v1/admin/status');
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.gates).toMatchObject({ x: true, bluesky: false });
    expect(body.x_monthly_budget_usd).toBe(50);
    expect(body.x_spend_month_to_date_usd).toBe(0);
  });

  it('records a conversion once, ignoring a replayed callback', async () => {
    const h = makeHarness();
    await seedCreator(h.env);

    const payload = {
      external_ref: 'order_1',
      creator_id: 'cr_gemmi',
      kind: 'signup',
      value_usd: 25,
    };
    const first = await signed(h.env, 'POST', '/api/v1/webhooks/conversion', payload);
    expect(await first.json()).toMatchObject({ recorded: true });

    const second = await signed(h.env, 'POST', '/api/v1/webhooks/conversion', payload);
    expect(await second.json()).toMatchObject({ recorded: false });
  });

  it('reports only measured results, with no invented impressions', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder((url) =>
      url.startsWith('https://provider.test')
        ? jsonResponse(rosterPayload([{ id: 'room_1', username: 'gemmikakes', started: T0 }]))
        : jsonResponse({ data: { id: 'x1' } }, 201),
    );
    for (const offset of [0, 60, 120]) {
      setClock(T0 + offset);
      await runCron(h.env, h.fetch, T0 + offset);
    }

    setClock(T0 + 130);
    const response = await signed(h.env, 'GET', '/api/v1/creators/cr_gemmi/results');
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };

    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ event: 'live_now', channel: 'x', clicks: 0, conversions: 0 });
    expect(Object.keys(body.results[0]!)).not.toContain('impressions');
  });

  it('answers the health check without a signature', async () => {
    const h = makeHarness();
    const response = await app.fetch(new Request('https://toiaf.com/healthz'), h.env);
    expect(response.status).toBe(200);
  });
});
