import { Repo } from '../../src/db/repo';
import type { Env } from '../../src/env';

export const T0 = 1_756_200_000; // 2025-08-26T09:20:00Z -- fixed clock for tests

export interface SeedCreatorOptions {
  creatorId?: string;
  roomId?: string;
  username?: string;
  timezone?: string;
  livePromotion?: boolean;
  channels?: { x?: boolean; telegram?: boolean; bluesky?: boolean };
  approval?: 'pending' | 'approved' | 'suspended';
  mapping?: 'unmapped' | 'confirmed' | 'ambiguous';
  niche?: string | null;
  surfaceUrl?: string | null;
  handleX?: string | null;
}

export async function seedCreator(env: Env, options: SeedCreatorOptions = {}): Promise<string> {
  const creatorId = options.creatorId ?? 'cr_gemmi';
  const roomId = options.roomId ?? 'room_1';
  const username = options.username ?? 'gemmikakes';
  const channels = options.channels ?? { x: true };

  await env.DB.prepare(
    `INSERT INTO creators (creator_id, display_name, handle_x, niche, country, timezone,
                           public_surface_url, approval_status, mapping_status,
                           live_promotion_enabled, auto_post_x, auto_post_telegram,
                           auto_post_bluesky, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      creatorId,
      'Gemmi Kakes',
      options.handleX === undefined ? 'gemmikakes' : options.handleX,
      options.niche === undefined ? 'Human Toilet' : options.niche,
      'US',
      options.timezone ?? 'America/New_York',
      options.surfaceUrl === undefined ? 'https://toiaf.com/model/gemmikakes/' : options.surfaceUrl,
      options.approval ?? 'approved',
      options.mapping ?? 'confirmed',
      options.livePromotion === false ? 0 : 1,
      channels.x ? 1 : 0,
      channels.telegram ? 1 : 0,
      channels.bluesky ? 1 : 0,
      T0 - 86_400,
      T0 - 86_400,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO provider_identities (creator_id, provider, provider_room_id, provider_username,
                                      is_primary, created_at)
     VALUES (?, 'stripcash', ?, ?, 1, ?)`,
  )
    .bind(creatorId, roomId, username, T0 - 86_400)
    .run();

  return creatorId;
}

export async function addIdentity(
  env: Env,
  creatorId: string,
  roomId: string,
  username: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO provider_identities (creator_id, provider, provider_room_id, provider_username,
                                      is_primary, created_at)
     VALUES (?, 'stripcash', ?, ?, 0, ?)`,
  )
    .bind(creatorId, roomId, username, T0 - 86_400)
    .run();
}

export async function seedAsset(
  env: Env,
  creatorId: string,
  options: { url?: string; approved?: boolean; watermarked?: boolean; ref?: string } = {},
): Promise<string> {
  const ref = options.ref ?? `asset_${creatorId}`;
  await env.DB.prepare(
    `INSERT INTO public_assets (asset_ref, creator_id, url, kind, watermarked, approved,
                                created_at, updated_at)
     VALUES (?, ?, ?, 'card', ?, ?, ?, ?)`,
  )
    .bind(
      ref,
      creatorId,
      options.url ?? 'https://cdn.toiaf.com/promo/gemmi-card.jpg',
      options.watermarked === false ? 0 : 1,
      options.approved === false ? 0 : 1,
      T0,
      T0,
    )
    .run();
  return ref;
}

export function repoFor(env: Env): Repo {
  return new Repo(env.DB);
}

/** A provider roster payload shaped like the aggregator API's. */
export function rosterPayload(
  models: Array<{ id: string; username: string; live?: boolean; started?: number; subject?: string }>,
) {
  return {
    models: models.map((m) => ({
      id: m.id,
      username: m.username,
      isLive: m.live !== false,
      broadcastStartedAt: m.started ?? null,
      subject: m.subject ?? null,
    })),
    total: models.length,
  };
}
