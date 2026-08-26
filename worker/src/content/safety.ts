/**
 * Everything that must never reach a social surface.
 *
 * The build contract is explicit: no paid masters, no protected sources, no
 * signed protected-media URLs, no raw R2 or HLS. These patterns are checked on
 * the rendered caption AND on any attached asset URL, immediately before send,
 * so a bad value introduced anywhere upstream still fails closed here.
 */
const FORBIDDEN_SUBSTRINGS = [
  '.m3u8',
  '.mpd',
  '/hls/',
  'master.m3u8',
  'r2.cloudflarestorage.com',
  '.r2.dev',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  '/protected/',
  '/private/',
  '/masters/',
  '/paid/',
  'signature=',
  'jwt=',
  'access_token=',
  'localhost',
  '127.0.0.1',
  '.internal',
  'wp-admin',
  'wp-content/uploads/private',
];

export interface SafetyVerdict {
  safe: boolean;
  reason?: string;
}

export function scanText(text: string): SafetyVerdict {
  const haystack = text.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (haystack.includes(needle)) {
      return { safe: false, reason: `forbidden_pattern:${needle}` };
    }
  }
  return { safe: true };
}

/** A public link must be https, on an allowed host, and free of the patterns above. */
export function scanPublicUrl(rawUrl: string, allowedHosts: string[]): SafetyVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { safe: false, reason: 'not_https' };

  const textVerdict = scanText(rawUrl);
  if (!textVerdict.safe) return textVerdict;

  if (allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const permitted = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!permitted) return { safe: false, reason: `host_not_allowed:${host}` };
  }
  return { safe: true };
}

/**
 * X counts every URL as 23 characters regardless of its real length. Measuring
 * the same way is what stops a long resolver link from silently pushing a post
 * over the limit and failing at the API.
 */
export function weightedLength(text: string): number {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  let length = [...text].length;
  for (const url of urls) length += 23 - [...url].length;
  return length;
}

export function truncateToWeighted(text: string, max: number): string {
  if (weightedLength(text) <= max) return text;
  const chars = [...text];
  let cut = chars.length;
  while (cut > 0 && weightedLength(chars.slice(0, cut).join('')) > max - 1) cut--;
  return `${chars.slice(0, cut).join('').trimEnd()}…`;
}
