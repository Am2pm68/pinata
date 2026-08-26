import type { Creator, IntentEvent } from '../types';
import { stableIndex } from '../lib/hash';
import { scanText, truncateToWeighted, weightedLength } from './safety';

/**
 * The only fields a template may ever see.
 *
 * Copy is built exclusively from this shape, so private messages, customer
 * data, protected media references, precise location and viewer counts are not
 * merely filtered out downstream -- they are never in scope to begin with.
 */
export interface PublicSafeContext {
  display_name: string;
  handle_x: string | null;
  niche: string | null;
  country: string | null;
  show_text: string | null;
  local_time: string | null;
  safe_link: string;
}

export const X_MAX_WEIGHTED = 280;

/**
 * One authoritative template family. Variants exist so that a creator going
 * live four nights running does not emit four near-identical posts -- which is
 * both bad promotion and exactly what platform spam rules target.
 */
const DEFAULT_TEMPLATES: Record<IntentEvent, string[]> = {
  scheduled: [
    '{MODEL} goes LIVE at {LOCAL_TIME}. {SHOW}\nSet your reminder → {LINK} {HASHTAGS}',
    'Scheduled: {MODEL} · {SHOW}\nLive at {LOCAL_TIME} → {LINK} {HASHTAGS}',
    'Coming up — {MODEL}, {LOCAL_TIME}. {SHOW}\n{LINK} {HASHTAGS}',
  ],
  reminder: [
    'Starting soon — {MODEL} is live at {LOCAL_TIME}. {SHOW}\n{LINK} {HASHTAGS}',
    'One hour out: {MODEL} · {SHOW}\nDoors at {LOCAL_TIME} → {LINK} {HASHTAGS}',
    '{MODEL} goes live at {LOCAL_TIME}. {SHOW}\nBe there → {LINK} {HASHTAGS}',
  ],
  live_now: [
    '🔴 LIVE NOW — {MODEL} · {SHOW}\nWatch on TOiAF → {LINK} {HASHTAGS}',
    '🔴 {MODEL} is LIVE. {SHOW}\nTOiAF → {LINK} {HASHTAGS}',
    'LIVE NOW 🔴 {MODEL} — {SHOW}\nJoin on TOiAF → {LINK} {HASHTAGS}',
  ],
  ended: [
    'That’s a wrap — {MODEL} has finished tonight’s show. {LINK}',
    '{MODEL} is offline. Catch the next one → {LINK}',
  ],
  replay: [
    'Replay up — {MODEL} · {SHOW}\n{LINK} {HASHTAGS}',
    'Missed {MODEL} live? The replay is up → {LINK} {HASHTAGS}',
  ],
  promo: ['{SHOW}\n{LINK} {HASHTAGS}'],
};

export interface CopyDefaults {
  templates?: Partial<Record<IntentEvent, string[]>>;
  hashtags?: string[];
  suppress_hashtags?: boolean;
}

export function parseCopyDefaults(creator: Creator): CopyDefaults {
  if (!creator.copy_defaults_json) return {};
  try {
    const parsed = JSON.parse(creator.copy_defaults_json) as CopyDefaults;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function slugToHashtag(value: string): string {
  const cleaned = value
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('');
  return cleaned ? `#${cleaned}` : '';
}

/**
 * Niche leads, country is secondary and only ever a trailing tag. That ordering
 * came out of owner QA on the LIVE cards: what a viewer picks by is the show,
 * not the passport.
 */
export function buildHashtags(ctx: PublicSafeContext, defaults: CopyDefaults): string {
  if (defaults.suppress_hashtags) return '';
  if (defaults.hashtags?.length) return defaults.hashtags.slice(0, 3).join(' ');

  const tags: string[] = ['#TOiAF'];
  if (ctx.niche) {
    const tag = slugToHashtag(ctx.niche);
    if (tag) tags.push(tag);
  }
  if (ctx.country && tags.length < 3) {
    const tag = slugToHashtag(ctx.country);
    if (tag) tags.push(tag);
  }
  return tags.slice(0, 3).join(' ');
}

/** Show line: creator/provider-supplied text when real, otherwise the niche. */
function showLine(ctx: PublicSafeContext): string {
  const text = ctx.show_text?.trim();
  if (text) return text;
  if (ctx.niche) return ctx.niche;
  return '';
}

function modelToken(ctx: PublicSafeContext): string {
  return ctx.handle_x ? `@${ctx.handle_x.replace(/^@/, '')}` : ctx.display_name;
}

export interface RenderedCaption {
  caption: string;
  variant_id: string;
  /** Templates that were tried and rejected, for the audit trail. */
  rejected: string[];
}

export interface RenderOptions {
  event: IntentEvent;
  ctx: PublicSafeContext;
  defaults: CopyDefaults;
  /** Seed for deterministic variant choice -- same session never re-rolls. */
  seed: string;
  maxWeighted?: number;
  /** Variant indexes already known to collide with a recent post. */
  excludeVariants?: Set<number>;
}

/**
 * Render one caption.
 *
 * Variant choice is a stable hash of the seed rather than a random pick, so a
 * retry of the same send regenerates byte-identical copy. That property is what
 * lets the idempotency key and the near-duplicate hash stay meaningful across
 * restarts.
 */
export async function renderCaption(options: RenderOptions): Promise<RenderedCaption | null> {
  const { event, ctx, defaults, seed } = options;
  const max = options.maxWeighted ?? X_MAX_WEIGHTED;
  const exclude = options.excludeVariants ?? new Set<number>();

  const family = defaults.templates?.[event]?.length
    ? defaults.templates[event]!
    : DEFAULT_TEMPLATES[event];
  if (!family || family.length === 0) return null;

  const start = await stableIndex(seed, family.length);
  const rejected: string[] = [];

  for (let step = 0; step < family.length; step++) {
    const index = (start + step) % family.length;
    if (exclude.has(index)) continue;

    const template = family[index]!;
    const hashtags = buildHashtags(ctx, defaults);
    const show = showLine(ctx);

    let caption = template
      .replaceAll('{MODEL}', modelToken(ctx))
      .replaceAll('{NAME}', ctx.display_name)
      .replaceAll('{SHOW}', show)
      .replaceAll('{NICHE}', ctx.niche ?? '')
      .replaceAll('{COUNTRY}', ctx.country ?? '')
      .replaceAll('{LOCAL_TIME}', ctx.local_time ?? '')
      .replaceAll('{LINK}', ctx.safe_link)
      .replaceAll('{HASHTAGS}', hashtags);

    // Tidy up the holes left by absent optional fields.
    caption = caption
      .replace(/[ \t]*·[ \t]*(?=\n|$)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();

    const verdict = scanText(caption);
    if (!verdict.safe) {
      rejected.push(`${index}:${verdict.reason}`);
      continue;
    }

    if (weightedLength(caption) > max) {
      caption = truncateToWeighted(caption, max);
      if (weightedLength(caption) > max) {
        rejected.push(`${index}:too_long`);
        continue;
      }
    }

    return { caption, variant_id: `${event}:${index}`, rejected };
  }

  return null;
}

export function variantIndexOf(variantId: string | null): number | null {
  if (!variantId) return null;
  const parts = variantId.split(':');
  const index = Number(parts[parts.length - 1]);
  return Number.isInteger(index) ? index : null;
}

export const __testing = { DEFAULT_TEMPLATES };
