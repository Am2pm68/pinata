import { describe, expect, it } from 'vitest';
import { runCron } from '../src/schedule/cron';
import { Repo } from '../src/db/repo';
import { addIdentity, rosterPayload, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';

function rosterResponder(models: Parameters<typeof rosterPayload>[0]) {
  return (url: string) => {
    if (url.startsWith('https://provider.test')) return jsonResponse(rosterPayload(models));
    return jsonResponse({ data: { id: '1' } }, 201);
  };
}

describe('live detection and flap suppression', () => {
  it('does not announce until the online state is stable', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(rosterResponder([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));
    const repo = new Repo(h.env.DB);

    const first = await runCron(h.env, h.fetch, T0);
    expect(first.detected).toBe(1);
    expect(first.confirmed).toBe(0);
    expect(h.sent).toHaveLength(0);

    // Two consecutive checks, but only 60s of wall clock: still not confirmed.
    const second = await runCron(h.env, h.fetch, T0 + 60);
    expect(second.confirmed).toBe(0);
    expect(h.sent).toHaveLength(0);

    const third = await runCron(h.env, h.fetch, T0 + 120);
    expect(third.confirmed).toBe(1);
    expect(third.live_now_queued).toBe(1);
    expect(h.sent).toHaveLength(1);

    const session = await repo.getConfirmedSessionForCreator('cr_gemmi');
    expect(session?.state).toBe('confirmed');
    expect(session?.evidence_class).toBe('provider_api');
  });

  it('keeps one session across a disconnect and reconnect, and posts once', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const live = rosterResponder([{ id: 'room_1', username: 'gemmikakes', started: T0 }]);
    const offline = rosterResponder([]);

    h.setResponder(live);
    await runCron(h.env, h.fetch, T0);
    await runCron(h.env, h.fetch, T0 + 60);
    await runCron(h.env, h.fetch, T0 + 120);
    expect(h.sent).toHaveLength(1);
    const sessionId = h.sent[0] ? (await new Repo(h.env.DB).getIntent(h.sent[0].intent_id))?.session_id : null;

    // Drop out for two ticks -- inside the grace window.
    h.setResponder(offline);
    await runCron(h.env, h.fetch, T0 + 180);
    const afterDrop = await runCron(h.env, h.fetch, T0 + 240);
    expect(afterDrop.ended).toBe(0);

    // Back online: same session, no second announcement.
    h.setResponder(live);
    const back = await runCron(h.env, h.fetch, T0 + 300);
    expect(back.reconnected).toBe(1);
    expect(back.detected).toBe(0);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const session = await repo.getConfirmedSessionForCreator('cr_gemmi');
    expect(session?.session_id).toBe(sessionId);
    expect(session?.consecutive_offline).toBe(0);
  });

  it('ends a session only after the offline streak and the grace period', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(rosterResponder([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));
    await runCron(h.env, h.fetch, T0);
    await runCron(h.env, h.fetch, T0 + 60);
    await runCron(h.env, h.fetch, T0 + 120);

    h.setResponder(rosterResponder([]));
    for (const offset of [180, 240, 300, 360]) {
      const tick = await runCron(h.env, h.fetch, T0 + offset);
      expect(tick.ended).toBe(0);
    }

    const final = await runCron(h.env, h.fetch, T0 + 420);
    expect(final.ended).toBe(1);

    const repo = new Repo(h.env.DB);
    const sessions = await repo.listSessionsByState('ended');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.ended_at).toBe(T0 + 420);
  });

  it('leaves live state untouched when the provider API is unavailable', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(rosterResponder([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));
    await runCron(h.env, h.fetch, T0);
    await runCron(h.env, h.fetch, T0 + 60);
    await runCron(h.env, h.fetch, T0 + 120);
    expect(h.sent).toHaveLength(1);

    // An outage must not read as "everybody went offline".
    h.setResponder(() => new Response('gateway timeout', { status: 504 }));
    const tick = await runCron(h.env, h.fetch, T0 + 180);
    expect(tick.provider_ok).toBe(false);
    expect(tick.ended).toBe(0);

    const repo = new Repo(h.env.DB);
    const session = await repo.getConfirmedSessionForCreator('cr_gemmi');
    expect(session?.state).toBe('confirmed');
    expect(session?.consecutive_offline).toBe(0);
  });

  it('announces two different creators live at once, independently', async () => {
    const h = makeHarness();
    await seedCreator(h.env, { creatorId: 'cr_a', roomId: 'room_a', username: 'alpha' });
    await seedCreator(h.env, { creatorId: 'cr_b', roomId: 'room_b', username: 'beta' });

    h.setResponder(
      rosterResponder([
        { id: 'room_a', username: 'alpha', started: T0 },
        { id: 'room_b', username: 'beta', started: T0 },
      ]),
    );

    await runCron(h.env, h.fetch, T0);
    await runCron(h.env, h.fetch, T0 + 60);
    const tick = await runCron(h.env, h.fetch, T0 + 120);

    expect(tick.confirmed).toBe(2);
    expect(h.sent).toHaveLength(2);
  });

  it('suppresses the second identity when one creator appears under two rooms', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await addIdentity(h.env, 'cr_gemmi', 'room_2', 'gemmikakes_hd');

    h.setResponder(
      rosterResponder([
        { id: 'room_1', username: 'gemmikakes', started: T0 },
        { id: 'room_2', username: 'gemmikakes_hd', started: T0 },
      ]),
    );

    const first = await runCron(h.env, h.fetch, T0);
    expect(first.detected).toBe(2);
    expect(first.suppressed).toBe(1);

    await runCron(h.env, h.fetch, T0 + 60);
    const tick = await runCron(h.env, h.fetch, T0 + 120);

    // Both rooms confirm, but only the first is eligible to announce.
    expect(tick.live_now_queued).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it('refuses to poll a creator who has not opted in', async () => {
    const h = makeHarness();
    await seedCreator(h.env, { livePromotion: false });
    h.setResponder(rosterResponder([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));

    const tick = await runCron(h.env, h.fetch, T0);
    expect(tick.detected).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it('refuses to poll a creator whose mapping is ambiguous', async () => {
    const h = makeHarness();
    await seedCreator(h.env, { mapping: 'ambiguous' });
    h.setResponder(rosterResponder([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));

    const tick = await runCron(h.env, h.fetch, T0);
    expect(tick.detected).toBe(0);
    expect(h.sent).toHaveLength(0);
  });
});
