import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo';
import { config } from '../src/env';
import { consumeIntent } from '../src/intents/consumer';
import { runCron } from '../src/schedule/cron';
import { KILL_SWITCH_KEY, killSwitchKeyFor } from '../src/lib/guards';
import { rosterPayload, seedAsset, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';
import { restoreClock, setClock, useFixedClock } from './helpers/clock';

function responder(tweetStatus = 201) {
  return (url: string) => {
    if (url.startsWith('https://provider.test')) {
      return jsonResponse(rosterPayload([{ id: 'room_1', username: 'gemmikakes', started: T0 }]));
    }
    if (url.startsWith('https://api.x.com/2/tweets')) {
      return tweetStatus === 201
        ? jsonResponse({ data: { id: 'x1' } }, 201)
        : jsonResponse({ title: 'blocked' }, tweetStatus);
    }
    return jsonResponse({ ok: true });
  };
}

async function tick(h: ReturnType<typeof makeHarness>, at: number) {
  setClock(at);
  return runCron(h.env, h.fetch, at);
}

async function goLive(h: ReturnType<typeof makeHarness>) {
  await tick(h, T0);
  await tick(h, T0 + 60);
  return tick(h, T0 + 120);
}

describe('fail-closed gates', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('queues nothing and calls nothing external while channel gates are off', async () => {
    const h = makeHarness({
      TOIAF_ALLOW_AUTO_LIVE_X: '0',
      TOIAF_ALLOW_AUTO_LIVE_TELEGRAM: '0',
      TOIAF_ALLOW_AUTO_LIVE_BLUESKY: '0',
      TOIAF_ALLOW_MANUAL_X_FALLBACK: '0',
    });
    await seedCreator(h.env);
    h.setResponder(responder());

    const result = await goLive(h);

    // Detection still works -- the gates stop sending, not seeing.
    expect(result.confirmed).toBe(1);
    expect(result.live_now_queued).toBe(0);
    expect(h.sent).toHaveLength(0);
    expect(h.calls.every((c) => c.url.startsWith('https://provider.test'))).toBe(true);
  });

  it('honours the global kill switch', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await new Repo(h.env.DB).setFlag(KILL_SWITCH_KEY, '1', 'test');
    h.setResponder(responder());

    const result = await goLive(h);
    expect(result.confirmed).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  it('honours a per-channel kill switch', async () => {
    const h = makeHarness();
    await seedCreator(h.env, { channels: { x: true, telegram: true } });
    await new Repo(h.env.DB).setFlag(killSwitchKeyFor('x'), '1', 'test');
    h.setResponder(responder());

    await goLive(h);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent?.channel).toBe('telegram');
  });

  it('does not send when the creator revokes between queueing and sending', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder());
    await goLive(h);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);

    // The creator hits the switch one minute before the queue drains.
    const cancelled = await repo.revokeCreator('cr_gemmi', 'creator_changed_mind');
    expect(cancelled).toBe(1);

    const outcome = await consumeIntent(repo, h.env, cfg, h.sent[0]!, h.fetch);
    expect(outcome.action).toBe('noop');
    expect(h.calls.filter((c) => c.url.startsWith('https://api.x.com'))).toHaveLength(0);
  });

  it('stops a send when the creator turns the channel off after queueing', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder());
    await goLive(h);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    await repo.updateCreatorSettings('cr_gemmi', { auto_post_x: 0 });

    const outcome = await consumeIntent(repo, h.env, cfg, h.sent[0]!, h.fetch);
    expect(outcome).toMatchObject({ action: 'skipped', reason: 'creator_channel_off:x' });
    expect(h.calls.filter((c) => c.url.startsWith('https://api.x.com'))).toHaveLength(0);
  });

  it('fails closed when no X budget is provisioned, handing off to a human', async () => {
    const h = makeHarness({ X_MONTHLY_BUDGET_USD: '0' });
    await seedCreator(h.env);
    h.setResponder(responder());

    await goLive(h);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent?.channel).toBe('manual_x');
    expect(intent?.approval_mode).toBe('auto_live');
  });

  it('stops sending once the monthly X budget is spent', async () => {
    const h = makeHarness({ X_MONTHLY_BUDGET_USD: '0.10', TOIAF_ALLOW_MANUAL_X_FALLBACK: '0' });
    await seedCreator(h.env);
    h.setResponder(responder());

    // 0.20 for a post carrying a link, against a 0.10 budget.
    await goLive(h);
    expect(h.sent).toHaveLength(0);
  });

  it('escalates an X auth wall to the manual composer instead of retrying', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder(401));
    await goLive(h);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    const outcome = await consumeIntent(repo, h.env, cfg, h.sent[0]!, h.fetch);

    expect(outcome.action).toBe('skipped');
    expect(outcome).toMatchObject({ reason: 'escalated_to_manual:x_http_401' });
    expect(h.sent).toHaveLength(2);

    const manual = await repo.getIntent(h.sent[1]!.intent_id);
    expect(manual?.channel).toBe('manual_x');
    expect(manual?.caption).toBe((await repo.getIntent(h.sent[0]!.intent_id))?.caption);
  });

  it('parks a manual hand-off as awaiting_manual rather than sent', async () => {
    const h = makeHarness({ ADMIN_NOTIFY_WEBHOOK: 'https://admin.test/notify' });
    await seedCreator(h.env);
    h.setResponder(responder(401));
    await goLive(h);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    await consumeIntent(repo, h.env, cfg, h.sent[0]!, h.fetch);
    const outcome = await consumeIntent(repo, h.env, cfg, h.sent[1]!, h.fetch);

    expect(outcome.action).toBe('awaiting_manual');
    const manual = await repo.getIntent(h.sent[1]!.intent_id);
    expect(manual?.status).toBe('awaiting_manual');

    const notify = h.calls.find((c) => c.url === 'https://admin.test/notify');
    expect(notify).toBeDefined();
    const payload = JSON.parse(String(notify!.init!.body));
    expect(payload.composer_url).toContain('https://x.com/intent/post');
  });

  it('never attaches an asset that is not approved and watermarked', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await seedAsset(h.env, 'cr_gemmi', { watermarked: false });
    h.setResponder(responder());

    await goLive(h);
    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent?.public_asset_ref).toBeNull();
  });

  it('attaches an approved watermarked asset', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    const ref = await seedAsset(h.env, 'cr_gemmi');
    h.setResponder(responder());

    await goLive(h);
    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent?.public_asset_ref).toBe(ref);
  });

  it('skips the post entirely when media is required but unavailable', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await new Repo(h.env.DB).updateCreatorSettings('cr_gemmi', {
      copy_defaults_json: JSON.stringify({ require_media: true }),
    });
    h.setResponder(responder());

    const result = await goLive(h);
    expect(result.confirmed).toBe(1);
    expect(h.sent).toHaveLength(0);
  });
});
