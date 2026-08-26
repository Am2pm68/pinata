import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo';
import { runCron } from '../src/schedule/cron';
import { rosterPayload, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';
import { restoreClock, setClock, useFixedClock } from './helpers/clock';

const SHOW_AT = T0 + 3600; // one hour out, so the 60-minute reminder is due now

async function addSchedule(
  env: ReturnType<typeof makeHarness>['env'],
  options: { id?: string; startsAt?: number; status?: string; showText?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO schedules (schedule_id, creator_id, starts_at_utc, source_timezone, source,
                            show_text, status, session_id, created_at, updated_at)
     VALUES (?, 'cr_gemmi', ?, 'America/New_York', 'richgirls', ?, ?, NULL, ?, ?)`,
  )
    .bind(
      options.id ?? 'sch_1',
      options.startsAt ?? SHOW_AT,
      options.showText ?? 'Toilet training night',
      options.status ?? 'active',
      T0 - 3600,
      T0 - 3600,
    )
    .run();
}

function responder(live: boolean, startedAt = T0) {
  return (url: string) => {
    if (url.startsWith('https://provider.test')) {
      return jsonResponse(
        rosterPayload(
          live ? [{ id: 'room_1', username: 'gemmikakes', started: startedAt }] : [],
        ),
      );
    }
    return jsonResponse({ data: { id: 'x1' } }, 201);
  };
}

async function tick(h: ReturnType<typeof makeHarness>, at: number) {
  setClock(at);
  return runCron(h.env, h.fetch, at);
}

describe('pre-live scheduling', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('sends one reminder at the configured 60-minute lead', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await addSchedule(h.env);
    h.setResponder(responder(false));

    // Ninety minutes out: too early.
    const early = await tick(h, SHOW_AT - 5400);
    expect(early.reminders_queued).toBe(0);

    const due = await tick(h, SHOW_AT - 3600);
    expect(due.reminders_queued).toBe(1);
    expect(h.sent).toHaveLength(1);

    // Subsequent ticks inside the window must not re-send.
    const again = await tick(h, SHOW_AT - 3540);
    expect(again.reminders_queued).toBe(0);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent!.event).toBe('reminder');
    expect(intent!.schedule_id).toBe('sch_1');
  });

  it('sends no reminder for a cancelled schedule', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await addSchedule(h.env, { status: 'cancelled' });
    h.setResponder(responder(false));

    const result = await tick(h, SHOW_AT - 3600);
    expect(result.reminders_queued).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it('stops a reminder that a creator cancels before it is due', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await addSchedule(h.env);
    h.setResponder(responder(false));

    const repo = new Repo(h.env.DB);
    await repo.setScheduleStatus('sch_1', 'cancelled', null);

    const result = await tick(h, SHOW_AT - 3600);
    expect(result.reminders_queued).toBe(0);
  });

  it('announces a creator who goes live with no schedule at all', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder(true));

    await tick(h, T0);
    await tick(h, T0 + 60);
    const result = await tick(h, T0 + 120);

    expect(result.reminders_queued).toBe(0);
    expect(result.live_now_queued).toBe(1);
  });

  it('marks the schedule fulfilled when the creator starts early', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    // Scheduled for T0+600; actually starts at T0, ten minutes early.
    await addSchedule(h.env, { startsAt: T0 + 600 });
    h.setResponder(responder(true, T0));

    await tick(h, T0);
    await tick(h, T0 + 60);
    await tick(h, T0 + 120);

    const repo = new Repo(h.env.DB);
    const schedule = await repo.getSchedule('sch_1');
    expect(schedule!.status).toBe('fulfilled');
    expect(schedule!.session_id).not.toBeNull();
  });

  it('leaves a schedule active when the show starts far outside the tolerance', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    // Scheduled a full hour after the actual start: not the same show.
    await addSchedule(h.env, { startsAt: T0 + 3600 });
    h.setResponder(responder(true, T0));

    await tick(h, T0);
    await tick(h, T0 + 60);
    await tick(h, T0 + 120);

    const repo = new Repo(h.env.DB);
    expect((await repo.getSchedule('sch_1'))!.status).toBe('active');
  });

  it('does not send a reminder after the show has already started', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    await addSchedule(h.env, { startsAt: T0 });
    h.setResponder(responder(false));

    const result = await tick(h, T0 + 60);
    expect(result.reminders_queued).toBe(0);
  });
});

describe('standalone scheduled promotion', () => {
  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());

  it('queues a due promo post exactly once', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder(false));

    await h.env.DB.prepare(
      `INSERT INTO promo_campaigns (campaign_id, name, creator_id, status, created_at, updated_at)
       VALUES ('camp_aug', 'ToiletFeed August', 'cr_gemmi', 'active', ?, ?)`,
    )
      .bind(T0, T0)
      .run();

    await h.env.DB.prepare(
      `INSERT INTO promo_posts (promo_post_id, campaign_id, creator_id, channel, scheduled_at,
                                caption, public_link, public_asset_ref, status, created_at, updated_at)
       VALUES ('pp_1', 'camp_aug', 'cr_gemmi', 'x', ?, 'New ToiletFeed drop → https://toiaf.com/go/live/cr_gemmi',
               'https://toiaf.com/go/live/cr_gemmi', NULL, 'pending', ?, ?)`,
    )
      .bind(T0, T0, T0)
      .run();

    const first = await tick(h, T0 + 10);
    expect(first.promo_queued).toBe(1);
    expect(h.sent).toHaveLength(1);

    const second = await tick(h, T0 + 70);
    expect(second.promo_queued).toBe(0);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent!.type).toBe('promo_post');
    expect(intent!.campaign_id).toBe('camp_aug');
    expect(intent!.estimated_cost_usd).toBeCloseTo(0.2);
  });

  it('ignores promo posts on a paused campaign', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    h.setResponder(responder(false));

    await h.env.DB.prepare(
      `INSERT INTO promo_campaigns (campaign_id, name, creator_id, status, created_at, updated_at)
       VALUES ('camp_p', 'Paused', 'cr_gemmi', 'paused', ?, ?)`,
    )
      .bind(T0, T0)
      .run();
    await h.env.DB.prepare(
      `INSERT INTO promo_posts (promo_post_id, campaign_id, creator_id, channel, scheduled_at,
                                caption, public_link, public_asset_ref, status, created_at, updated_at)
       VALUES ('pp_2', 'camp_p', 'cr_gemmi', 'x', ?, 'hello', NULL, NULL, 'pending', ?, ?)`,
    )
      .bind(T0, T0, T0)
      .run();

    const result = await tick(h, T0 + 10);
    expect(result.promo_queued).toBe(0);
  });
});
