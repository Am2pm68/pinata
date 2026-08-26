import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo';
import { config } from '../src/env';
import { planIntent } from '../src/intents/planner';
import { runCron } from '../src/schedule/cron';
import { normaliseCaption } from '../src/lib/hash';
import { formatLocalDateTime } from '../src/lib/time';
import { scanPublicUrl, scanText, weightedLength } from '../src/content/safety';
import { renderCaption, type PublicSafeContext } from '../src/content/templates';
import { rosterPayload, seedCreator, T0 } from './helpers/seed';
import { jsonResponse, makeHarness } from './helpers/env';
import { restoreClock, setClock, useFixedClock } from './helpers/clock';

describe('public-safety scanning', () => {
  it('rejects HLS, R2 and signed-URL patterns', () => {
    const cases = [
      'watch https://cdn.toiaf.com/live/master.m3u8',
      'https://bucket.r2.cloudflarestorage.com/paid/master.mp4',
      'https://cdn.toiaf.com/a.jpg?X-Amz-Signature=deadbeef',
      'https://cdn.toiaf.com/protected/clip.mp4',
      'https://cdn.toiaf.com/masters/original.mov',
    ];
    for (const value of cases) {
      expect(scanText(value).safe, value).toBe(false);
    }
  });

  it('accepts an ordinary public promo URL', () => {
    expect(scanText('LIVE NOW https://toiaf.com/go/live/cr_gemmi').safe).toBe(true);
  });

  it('enforces https and the asset host allowlist', () => {
    expect(scanPublicUrl('http://cdn.toiaf.com/a.jpg', ['cdn.toiaf.com']).safe).toBe(false);
    expect(scanPublicUrl('https://evil.example/a.jpg', ['cdn.toiaf.com']).safe).toBe(false);
    expect(scanPublicUrl('https://cdn.toiaf.com/a.jpg', ['cdn.toiaf.com']).safe).toBe(true);
    expect(scanPublicUrl('https://img.cdn.toiaf.com/a.jpg', ['cdn.toiaf.com']).safe).toBe(true);
  });

  it('measures a URL as 23 characters, the way X does', () => {
    const long = `hello https://toiaf.com/go/live/${'a'.repeat(120)}`;
    expect(long.length).toBeGreaterThan(140);
    expect(weightedLength(long)).toBe('hello '.length + 23);
  });
});

describe('caption rendering', () => {
  const ctx: PublicSafeContext = {
    display_name: 'Gemmi Kakes',
    handle_x: 'gemmikakes',
    niche: 'Human Toilet',
    country: 'US',
    show_text: 'Toilet training night',
    local_time: 'Wed, Aug 26, 9:00 PM EDT',
    safe_link: 'https://toiaf.com/go/live/cr_gemmi',
  };

  it('leads with the show and niche and keeps country secondary', async () => {
    const rendered = await renderCaption({
      event: 'live_now',
      ctx,
      defaults: {},
      seed: 'seed-1',
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.caption).toContain('Toilet training night');
    expect(rendered!.caption).toContain('@gemmikakes');

    const hashtagLine = rendered!.caption.slice(rendered!.caption.indexOf('#'));
    expect(hashtagLine.indexOf('#HumanToilet')).toBeLessThan(hashtagLine.indexOf('#US'));
  });

  it('is deterministic for the same seed and varies across sessions', async () => {
    const a = await renderCaption({ event: 'live_now', ctx, defaults: {}, seed: 'session-a' });
    const again = await renderCaption({ event: 'live_now', ctx, defaults: {}, seed: 'session-a' });
    expect(a!.caption).toBe(again!.caption);

    const variants = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const rendered = await renderCaption({ event: 'live_now', ctx, defaults: {}, seed });
      variants.add(rendered!.variant_id);
    }
    expect(variants.size).toBeGreaterThan(1);
  });

  it('stays inside the X limit even with a very long show text', async () => {
    const rendered = await renderCaption({
      event: 'live_now',
      ctx: { ...ctx, show_text: 'x'.repeat(400) },
      defaults: {},
      seed: 'long',
    });
    expect(rendered).not.toBeNull();
    expect(weightedLength(rendered!.caption)).toBeLessThanOrEqual(280);
  });

  it('honours owner-edited copy defaults', async () => {
    const rendered = await renderCaption({
      event: 'live_now',
      ctx,
      defaults: { templates: { live_now: ['CUSTOM {NAME} → {LINK}'] }, suppress_hashtags: true },
      seed: 'custom',
    });
    expect(rendered!.caption).toBe('CUSTOM Gemmi Kakes → https://toiaf.com/go/live/cr_gemmi');
  });

  it('refuses to render a template that would leak a protected URL', async () => {
    const rendered = await renderCaption({
      event: 'live_now',
      ctx,
      defaults: { templates: { live_now: ['watch https://cdn.toiaf.com/live/master.m3u8'] } },
      seed: 'unsafe',
    });
    expect(rendered).toBeNull();
  });
});

describe('near-duplicate detection', () => {
  it('collapses captions that differ only by link, time and emoji', () => {
    const a = normaliseCaption('🔴 LIVE NOW — @gemmi · Toilet night\nWatch → https://a.test/1 #TOiAF');
    const b = normaliseCaption('LIVE NOW — @gemmi · Toilet night\nWatch → https://b.test/2 #TOiAF');
    expect(a).toBe(b);
  });

  it('picks a different variant rather than repeating recent copy', async () => {
    const h = makeHarness();
    await seedCreator(h.env);
    useFixedClock(T0);

    const repo = new Repo(h.env.DB);
    const cfg = config(h.env);
    const creator = (await repo.getCreator('cr_gemmi'))!;

    const first = await planIntent(repo, h.env, cfg, {
      creator,
      channel: 'x',
      event: 'reminder',
      session: null,
      schedule: null,
      scheduledAt: T0,
      now: T0,
    });
    expect(first.status).toBe('queued');

    // Mark it sent so the dedupe window sees it.
    const intentId = (first as { intent_id: string }).intent_id;
    await repo.markIntentSent(intentId, 'x1', 0.2);
    const sent = await repo.getIntent(intentId);

    // A later show for the same creator: same event, same channel, new schedule.
    await h.env.DB.prepare(
      `INSERT INTO schedules (schedule_id, creator_id, starts_at_utc, source_timezone, source,
                              show_text, status, session_id, created_at, updated_at)
       VALUES ('sch_next', 'cr_gemmi', ?, 'America/New_York', 'richgirls', NULL, 'active', NULL, ?, ?)`,
    )
      .bind(T0 + 7200, T0, T0)
      .run();

    const schedule = await repo.getSchedule('sch_next');
    const second = await planIntent(repo, h.env, cfg, {
      creator,
      channel: 'x',
      event: 'reminder',
      session: null,
      schedule,
      scheduledAt: T0 + 60,
      now: T0 + 60,
    });

    expect(second.status).toBe('queued');
    const secondIntent = await repo.getIntent((second as { intent_id: string }).intent_id);
    expect(secondIntent!.caption_hash).not.toBe(sent!.caption_hash);
    restoreClock();
  });
});

describe('timezone and daylight saving', () => {
  it('renders the creator local time on both sides of a DST boundary', () => {
    const winter = Math.floor(Date.parse('2026-01-15T18:00:00Z') / 1000);
    const summer = Math.floor(Date.parse('2026-07-15T18:00:00Z') / 1000);

    const winterLabel = formatLocalDateTime(winter, 'America/New_York');
    const summerLabel = formatLocalDateTime(summer, 'America/New_York');

    expect(winterLabel).toContain('EST');
    expect(winterLabel).toContain('1:00');
    expect(summerLabel).toContain('EDT');
    expect(summerLabel).toContain('2:00');
  });

  it('falls back to UTC for an unusable timezone rather than throwing', () => {
    expect(formatLocalDateTime(T0, 'Not/AZone')).toContain('UTC');
  });

  it('puts the creator local time into the reminder copy', async () => {
    const h = makeHarness();
    await seedCreator(h.env, { timezone: 'America/New_York' });
    const start = Math.floor(Date.parse('2026-07-15T23:00:00Z') / 1000);
    setClock(start - 3600);

    await h.env.DB.prepare(
      `INSERT INTO schedules (schedule_id, creator_id, starts_at_utc, source_timezone, source,
                              show_text, status, session_id, created_at, updated_at)
       VALUES ('sch_dst', 'cr_gemmi', ?, 'America/New_York', 'richgirls', 'Summer show', 'active',
               NULL, ?, ?)`,
    )
      .bind(start, start - 7200, start - 7200)
      .run();

    h.setResponder((url) =>
      url.startsWith('https://provider.test') ? jsonResponse(rosterPayload([])) : jsonResponse({}),
    );

    await runCron(h.env, h.fetch, start - 3600);
    expect(h.sent).toHaveLength(1);

    const repo = new Repo(h.env.DB);
    const intent = await repo.getIntent(h.sent[0]!.intent_id);
    expect(intent!.event).toBe('reminder');
    expect(intent!.caption).toContain('7:00');
    expect(intent!.caption).toContain('EDT');
    restoreClock();
  });

  beforeEach(() => useFixedClock(T0));
  afterEach(() => restoreClock());
});
