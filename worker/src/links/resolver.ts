import type { Repo } from '../db/repo';
import type { Config } from '../env';

export interface ResolvedDestination {
  url: string;
  /** 1 exact stream · 2 creator surface · 3 niche discovery · 4 /live/ */
  step: 1 | 2 | 3 | 4;
  was_corrected: boolean;
  creator_id: string | null;
  session_id: string | null;
}

/**
 * The link that goes into a post. It never points at a stream directly: it
 * points at a TOiAF-controlled route that decides where to send the click at
 * the moment of the click. An announcement that outlives the show therefore
 * degrades to a live surface rather than to "No content found".
 */
export function buildGoLink(
  cfg: Config,
  creatorSlug: string,
  params: { campaignId?: string | null; intentId?: string | null } = {},
): string {
  const url = new URL(`/go/live/${encodeURIComponent(creatorSlug)}`, cfg.goLinkOrigin);
  if (params.campaignId) url.searchParams.set('c', params.campaignId);
  if (params.intentId) url.searchParams.set('i', params.intentId);
  return url.toString();
}

/**
 * Click-time resolution, in the order the contract fixes:
 *   1. the verified active stream for this creator right now;
 *   2. the creator's own current profile/live surface;
 *   3. LIVE discovery filtered to the same approved niche;
 *   4. /live/.
 *
 * Step 1 is gated on `confirmed` live state read from the provider API path --
 * the same authority the announcement itself used -- so we never hand a viewer
 * a stream URL that our own state says is not up.
 */
export async function resolveLiveDestination(
  repo: Repo,
  cfg: Config,
  slug: string,
): Promise<ResolvedDestination> {
  const creator = await repo.findCreatorBySlug(slug);

  if (!creator) {
    return {
      url: `${cfg.publicOrigin}/live/`,
      step: 4,
      was_corrected: true,
      creator_id: null,
      session_id: null,
    };
  }

  const session = await repo.getConfirmedSessionForCreator(creator.creator_id);
  if (session && !session.suppressed_reason && session.provider_username) {
    return {
      url: `${cfg.streamOrigin}/${encodeURIComponent(session.provider_username)}`,
      step: 1,
      was_corrected: false,
      creator_id: creator.creator_id,
      session_id: session.session_id,
    };
  }

  if (creator.public_surface_url) {
    return {
      url: creator.public_surface_url,
      step: 2,
      was_corrected: true,
      creator_id: creator.creator_id,
      session_id: session?.session_id ?? null,
    };
  }

  if (creator.niche) {
    const url = new URL('/live/', cfg.publicOrigin);
    url.searchParams.set('niche', creator.niche);
    return {
      url: url.toString(),
      step: 3,
      was_corrected: true,
      creator_id: creator.creator_id,
      session_id: session?.session_id ?? null,
    };
  }

  return {
    url: `${cfg.publicOrigin}/live/`,
    step: 4,
    was_corrected: true,
    creator_id: creator.creator_id,
    session_id: session?.session_id ?? null,
  };
}
