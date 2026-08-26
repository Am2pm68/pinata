import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from '../lib/hmac';

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

const MAX_SKEW_SECONDS = 300;

/**
 * Request authentication for the RichGirls/WordPress side.
 *
 * Signed with a shared secret over `timestamp.method.path.body`, with a five
 * minute skew window so a captured request cannot be replayed later. Cookies
 * are deliberately not an accepted credential on any endpoint here.
 */
export async function verifySignature(
  env: Env,
  request: Request,
  rawBody: string,
): Promise<AuthResult> {
  const secret = env.TOIAF_API_HMAC_SECRET;
  if (!secret) return { ok: false, reason: 'api_secret_not_configured' };

  const signature = request.headers.get('x-toiaf-signature');
  const timestamp = request.headers.get('x-toiaf-timestamp');
  if (!signature || !timestamp) return { ok: false, reason: 'missing_signature_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp_skew' };
  }

  const url = new URL(request.url);
  const expected = await hmacSha256Hex(
    secret,
    `${timestamp}.${request.method.toUpperCase()}.${url.pathname}.${rawBody}`,
  );

  return timingSafeEqual(expected, signature.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}
