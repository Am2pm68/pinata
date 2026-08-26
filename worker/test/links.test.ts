import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo';
import { config } from '../src/env';
import { buildApp } from '../src/api/routes';
import { buildGoLink, resolveLiveDestination } from '../src/links/resolver';
import { runCron } from '../src/schedule/cron';
import { rosterPayload, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';
import { restoreClock, setClock, useFixedClock } from './helpers/clock';

const app = buildApp();

function responder() {
  return (url: string) => {
    if (url.startsWith('https://provider.test')) {
      return jsonResponse(rosterPayload([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));
    }
    return jsonResponse({ data: { id: 'x1' } }, 201);
  };
}

async function goLive(h: ReturnType<typeof makeHarness>) {
  for (const offset of [0, 60, 120]) {
    setClock(T0 + offset);
    await runCron(h.env, h.fetch, T0 + offset);
  }
}

async function get(env: ReturnType<typeof makeHarness>['env'], path: string): Promise<Response> {
  return app.fetch(new Request(`https://toiaf.com${path}`), env);
}

describe('safe link resolution', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('sends a click to the exact live stream while the show is confirmed live', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder());
    await goLive(h);

    const destination = await resolveLiveDestination(new Repo(h.env.DB), config(h.env), 'cr_gemmi');
    expect(destination.step).toBe(1);
    expect(destination.url).toBe('https://stream.npntoi.com/gemmikakes');
    expect(destination.was_corrected).toBe(false);
  });

  it('falls back to the creator surface when nothing is live', async () => {
    const h = makeHarness();
    await seedCreator(h.env);

    const destination = await resolveLiveDestination(new Repo(h.env.DB), config(h.env), 'cr_gemmi');
    expect(destination.step).toBe(2);
    expect(destination.url).toBe('https://toiaf.com/model/gemmikakes/');
    expect(destination.was_corrected).toBe(true);
  });

  it('falls back to same-niche discovery when the creator has no surface', async () => {
    const h = makeHarness();
    await seedCreator(h.env, { surfaceUrl: null });

    const destination = await resolveLiveDestination(new Repo(h.env.DB), config(h.env), 'cr_gemmi');
    expect(destination.step).toBe(3);
    expect(destination.url).toContain('/live/?niche=Human+Toilet');
  });

  it('falls back to /live/ rather than dead-ending on an unknown creator', async () => {
    const h = makeHarness();
    const destination = await resolveLiveDestination(new Repo(h.env.DB), config(h.env), 'nobody');
    expect(destination.step).toBe(4);
    expect(destination.url).toBe('https://toiaf.com/live/');
  });

  it('resolves a provider username as well as a creator id', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const destination = await resolveLiveDestination(
      new Repo(h.env.DB),
      config(h.env),
      'gemmikakes',
    );
    expect(destination.creator_id).toBe('cr_gemmi');
  });
});

describe('/go/live redirect', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('redirects and records the resolution', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder());
    await goLive(h);

    const response = await get(h.env, '/go/live/cr_gemmi?c=aug_campaign&i=int_1');
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://stream.npntoi.com/gemmikakes');
    expect(location.searchParams.get('utm_campaign')).toBe('aug_campaign');

    const row = await h.env.DB.prepare(
      'SELECT * FROM link_resolutions ORDER BY id DESC LIMIT 1',
    ).first<{ resolution_step: number; was_corrected: number; intent_id: string }>();
    expect(row?.resolution_step).toBe(1);
    expect(row?.was_corrected).toBe(0);
    expect(row?.intent_id).toBe('int_1');
  });

  it('records a correction when the exact stream is no longer up', async () => {
    const h = makeHarness();
    await seedCreator(h.env);

    const response = await get(h.env, '/go/live/cr_gemmi?c=aug_campaign');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://toiaf.com/model/gemmikakes/');

    const row = await h.env.DB.prepare(
      'SELECT * FROM link_resolutions ORDER BY id DESC LIMIT 1',
    ).first<{ resolution_step: number; was_corrected: number }>();
    expect(row?.resolution_step).toBe(2);
    expect(row?.was_corrected).toBe(1);
  });

  it('never publishes a raw stream URL in the post itself', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder());
    await goLive(h);

    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent!.caption).not.toContain('stream.npntoi.com');
    expect(intent!.caption).toContain('https://toiaf.com/go/live/cr_gemmi');
    expect(intent!.public_link).toBe(buildGoLink(config(h.env), 'cr_gemmi', { intentId: intent!.intent_id }));
  });
});
