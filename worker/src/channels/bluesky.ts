import type { Env } from '../env';
import type { SendResult } from '../types';
import { log } from '../lib/log';

const DEFAULT_SERVICE = 'https://bsky.social';
const MAX_BLOB_BYTES = 976 * 1024;

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri: string }>;
}

/**
 * AT Protocol facets are indexed in UTF-8 *bytes*, not JS string offsets. Any
 * emoji or accented character ahead of a link shifts those two numbers apart,
 * so the offsets are computed on the encoded buffer.
 */
export function linkFacets(text: string): Facet[] {
  const encoder = new TextEncoder();
  const facets: Facet[] = [];
  const pattern = /https?:\/\/[^\s]+/g;

  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue;
    const uri = match[0].replace(/[.,;:!?)]+$/, '');
    facets.push({
      index: {
        byteStart: encoder.encode(text.slice(0, match.index)).byteLength,
        byteEnd: encoder.encode(text.slice(0, match.index) + uri).byteLength,
      },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return facets;
}

export interface BlueskySendInput {
  caption: string;
  assetUrl: string | null;
}

export async function sendToBluesky(
  env: Env,
  input: BlueskySendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const service = env.BLUESKY_SERVICE ?? DEFAULT_SERVICE;
  const identifier = env.BLUESKY_IDENTIFIER;
  const password = env.BLUESKY_APP_PASSWORD;

  if (!identifier || !password) {
    return {
      ok: false,
      retryable: false,
      error_class: 'bluesky_auth_unavailable',
      message: 'identifier or app password not configured',
    };
  }

  let accessJwt: string;
  let did: string;
  try {
    const sessionResponse = await fetchImpl(`${service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!sessionResponse.ok) {
      const body = await sessionResponse.text().catch(() => '');
      return {
        ok: false,
        retryable: sessionResponse.status >= 500,
        error_class: `bluesky_session_${sessionResponse.status}`,
        message: body.slice(0, 300),
      };
    }
    const json = (await sessionResponse.json()) as { accessJwt?: string; did?: string };
    if (!json.accessJwt || !json.did) {
      return {
        ok: false,
        retryable: false,
        error_class: 'bluesky_session_malformed',
        message: 'missing accessJwt or did',
      };
    }
    accessJwt = json.accessJwt;
    did = json.did;
  } catch (err) {
    return { ok: false, retryable: true, error_class: 'bluesky_network', message: String(err) };
  }

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text: input.caption,
    createdAt: new Date().toISOString(),
    facets: linkFacets(input.caption),
  };

  if (input.assetUrl) {
    const blob = await uploadBlob(service, accessJwt, input.assetUrl, fetchImpl);
    if (blob) {
      record.embed = {
        $type: 'app.bsky.embed.images',
        images: [{ alt: 'TOiAF live promo card', image: blob }],
      };
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessJwt}` },
      body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error_class: 'bluesky_network', message: String(err) };
  }

  const text = await response.text().catch(() => '');
  if (response.ok) {
    let uri: string | null = null;
    try {
      uri = (JSON.parse(text) as { uri?: string }).uri ?? null;
    } catch {
      uri = null;
    }
    return { ok: true, provider_post_id: uri, cost_usd: 0 };
  }

  return {
    ok: false,
    retryable: response.status === 429 || response.status >= 500,
    error_class: `bluesky_http_${response.status}`,
    message: text.slice(0, 300),
  };
}

async function uploadBlob(
  service: string,
  accessJwt: string,
  assetUrl: string,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  try {
    const assetResponse = await fetchImpl(assetUrl, { signal: AbortSignal.timeout(10_000) });
    if (!assetResponse.ok) return null;

    const contentType = assetResponse.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;

    const bytes = await assetResponse.arrayBuffer();
    if (bytes.byteLength > MAX_BLOB_BYTES) return null;

    const uploadResponse = await fetchImpl(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { 'content-type': contentType, authorization: `Bearer ${accessJwt}` },
      body: bytes,
      signal: AbortSignal.timeout(20_000),
    });
    if (!uploadResponse.ok) return null;

    const json = (await uploadResponse.json()) as { blob?: unknown };
    return json.blob ?? null;
  } catch (err) {
    log('warn', 'bluesky.blob_upload_failed', { error: String(err) });
    return null;
  }
}
