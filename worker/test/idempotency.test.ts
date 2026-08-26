import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo';
import { config } from '../src/env';
import { consumeIntent } from '../src/intents/consumer';
import { planIntent } from '../src/intents/planner';
import { runCron } from '../src/schedule/cron';
import { rosterPayload, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';
import { restoreClock, setClock, useFixedClock } from './helpers/clock';

function liveResponder(postId = 'x_post_1') {
  return (url: string) => {
    if (url.startsWith('https://provider.test')) {
      return jsonResponse(rosterPayload([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));
    }
    if (url.startsWith('https://api.x.com/2/tweets')) {
      return jsonResponse({ data: { id: postId } }, 201);
    }
    return jsonResponse({ ok: true });
  };
}

async function tick(h: ReturnType<typeof makeHarness>, at: number) {
  setClock(at);
  return runCron(h.env, h.fetch, at);
}

async function driveToConfirmed(h: ReturnType<typeof makeHarness>) {
  await tick(h, T0);
  await tick(h, T0 + 60);
  return tick(h, T0 + 120);
}

describe('exactly-once guarantees', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('creates one intent no matter how many times the same event is planned', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(liveResponder());
    await driveToConfirmed(h);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    const creator = await repo.getCreator('cr_gemmi');
    const session = await repo.getConfirmedSessionForCreator('cr_gemmi');

    const second = await planIntent(repo, h.env, cfg, {
      creator: creator!,
      channel: 'x',
      event: 'live_now',
      session,
      schedule: null,
      scheduledAt: T0 + 130,
      now: T0 + 130,
    });

    // Blocked by the session guard: an announcement for this session is already
    // alive, so planning stops before the idempotency key is even reached.
    expect(second.status).toBe('skipped');
    expect(h.sent).toHaveLength(1);
  });

  it('survives a duplicate cron fire in the same minute', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(liveResponder());

    await tick(h, T0);
    await tick(h, T0 + 60);
    await tick(h, T0 + 120);
    await tick(h, T0 + 120);

    expect(h.sent).toHaveLength(1);
  });

  it('sends once when the queue redelivers the same message', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(liveResponder('x_post_dup'));
    await driveToConfirmed(h);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    const message = h.sent[0]!;

    const first = await consumeIntent(repo, h.env, cfg, message, h.fetch);
    expect(first.action).toBe('sent');

    const second = await consumeIntent(repo, h.env, cfg, message, h.fetch);
    expect(second.action).toBe('noop');

    const tweetCalls = h.calls.filter((c) => c.url.startsWith('https://api.x.com/2/tweets'));
    expect(tweetCalls).toHaveLength(1);

    const intent = await repo.getIntent(message.intent_id);
    expect(intent?.status).toBe('sent');
    expect(intent?.provider_post_id).toBe('x_post_dup');
    expect(intent?.attempts).toBe(1);
  });

  it('rejects a second row for an idempotency key that already exists', async () => {
    const h = makeHarness();
    const repo = new Repo(h.env.DB);
    await seedCreator(h.env);

    const row = {
      idempotency_key: 'cr_gemmi|room_1|ses_1|live_now|x',
      type: 'live_event' as const,
      creator_id: 'cr_gemmi',
      provider_room_id: 'room_1',
      session_id: null,
      schedule_id: null,
      campaign_id: null,
      event: 'live_now' as const,
      channel: 'x' as const,
      scheduled_at: T0,
      caption: 'LIVE NOW',
      caption_hash: 'hash',
      variant_id: null,
      public_link: 'https://toiaf.com/go/live/cr_gemmi',
      public_asset_ref: null,
      approval_mode: 'auto_live' as const,
      status: 'queued' as const,
      estimated_cost_usd: 0.2,
    };

    expect(await repo.insertIntentIfAbsent({ ...row, intent_id: 'int_a' })).toBe(true);
    expect(await repo.insertIntentIfAbsent({ ...row, intent_id: 'int_b' })).toBe(false);

    expect(await repo.getIntent('int_a')).not.toBeNull();
    expect(await repo.getIntent('int_b')).toBeNull();
  });

  it('does not double-claim an intent for two concurrent consumers', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(liveResponder());
    await driveToConfirmed(h);

    const repo = new Repo(h.env.DB);
    const intentId = h.sent[0]!.intent_id;

    expect(await repo.claimIntentForSend(intentId)).not.toBeNull();
    expect(await repo.claimIntentForSend(intentId)).toBeNull();
  });

  it('re-publishes a stale queued intent without creating a second one', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(liveResponder());
    await driveToConfirmed(h);
    expect(h.sent).toHaveLength(1);

    // Far enough ahead that the sweep considers the row stale.
    const swept = await tick(h, T0 + 600);
    expect(swept.resweept).toBe(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.intent_id).toBe(h.sent[0]!.intent_id);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    expect((await consumeIntent(repo, h.env, cfg, h.sent[0]!, h.fetch)).action).toBe('sent');
    expect((await consumeIntent(repo, h.env, cfg, h.sent[1]!, h.fetch)).action).toBe('noop');
    expect(h.calls.filter((c) => c.url.startsWith('https://api.x.com/2/tweets'))).toHaveLength(1);
  });
});
