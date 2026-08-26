import type { Repo } from '../db/repo';
import type { Config } from '../env';
import { scanPublicUrl } from './safety';

export type AssetResolution =
  | { ok: true; asset_ref: string; url: string; kind: string }
  | { ok: false; reason: string };

/**
 * Resolve a social asset through the public promo derivative lane.
 *
 * An asset is usable only if it is registered, owned by this creator, approved,
 * watermarked, and its URL survives the public-safety scan. There is no path
 * here that reaches a paid master, a protected source or a signed URL, because
 * the only candidates considered are rows that the derivative lane published.
 */
export async function resolvePublicAsset(
  repo: Repo,
  cfg: Config,
  creatorId: string,
  requestedRef: string | null,
): Promise<AssetResolution> {
  const asset = requestedRef
    ? await repo.getPublicAsset(requestedRef)
    : await repo.latestApprovedAsset(creatorId);

  if (!asset) return { ok: false, reason: requestedRef ? 'asset_not_found' : 'no_public_asset' };
  if (asset.creator_id !== creatorId) return { ok: false, reason: 'asset_creator_mismatch' };
  if (!asset.approved) return { ok: false, reason: 'asset_not_approved' };
  if (!asset.watermarked) return { ok: false, reason: 'asset_not_watermarked' };

  const verdict = scanPublicUrl(asset.url, cfg.publicAssetAllowedHosts);
  if (!verdict.safe) return { ok: false, reason: `asset_unsafe:${verdict.reason}` };

  return { ok: true, asset_ref: asset.asset_ref, url: asset.url, kind: asset.kind };
}
