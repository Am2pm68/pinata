import type { Repo } from '../db/repo';
import type { Config, Env } from '../env';
import type { CreatorChannelAuth, SendResult } from '../types';
import { hmacSha1Base64 } from '../lib/hmac';
import { log } from '../lib/log';

const TWEETS_ENDPOINT = 'https://api.x.com/2/tweets';
const MEDIA_UPLOAD_ENDPOINT = 'https://upload.twitter.com/1.1/media/upload.json';
const TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** RFC 3986 percent-encoding. `encodeURIComponent` leaves !*'() un-encoded. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/**
 * OAuth 1.0a request signing.
 *
 * `bodyParams` must be supplied for form-encoded requests -- the spec folds
 * those into the signature base string. JSON bodies contribute nothing, which
 * is why the tweet call passes an empty map and the media upload does not.
 */
export async function oauth1Header(
  method: 'GET' | 'POST',
  url: string,
  credentials: OAuth1Credentials,
  bodyParams: Record<string, string> = {},
  nonceOverride?: string,
  timestampOverride?: number,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonceOverride ?? crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestampOverride ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.token,
    oauth_version: '1.0',
  };

  const parsed = new URL(url);
  const queryParams: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });
  const baseUrl = `${parsed.origin}${parsed.pathname}`;

  const allParams = { ...queryParams, ...bodyParams, ...oauthParams };
  const paramString = Object.keys(allParams)
    .map((key) => [percentEncode(key), percentEncode(allParams[key]!)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const signatureBase = [method, percentEncode(baseUrl), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, signatureBase);

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key]!)}"`)
    .join(', ')}`;
}

function networkCredentials(env: Env): OAuth1Credentials | null {
  if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_SECRET) {
    return null;
  }
  return {
    consumerKey: env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    token: env.X_ACCESS_TOKEN,
    tokenSecret: env.X_ACCESS_SECRET,
  };
}

/**
 * Refresh a creator's OAuth 2.0 user token.
 *
 * Creator-owned posting only ever runs on tokens the creator granted through
 * the OAuth flow and can revoke. Browser cookies are never a credential here.
 */
async function refreshCreatorToken(
  repo: Repo,
  env: Env,
  auth: CreatorChannelAuth,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (!auth.refresh_token || !env.X_API_KEY) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: env.X_API_KEY,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (env.X_API_SECRET) {
    headers.authorization = `Basic ${btoa(`${env.X_API_KEY}:${env.X_API_SECRET}`)}`;
  }

  const response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers, body });
  if (!response.ok) {
    log('warn', 'x.token_refresh_failed', {
      creator_id: auth.creator_id,
      status: response.status,
    });
    return null;
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) return null;

  await repo.updateChannelAuthTokens(auth.id, {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? auth.refresh_token,
    token_expires_at: json.expires_in
      ? Math.floor(Date.now() / 1000) + json.expires_in - 60
      : null,
  });
  return json.access_token;
}

interface UploadableAsset {
  url: string;
  kind: string;
}

/**
 * Upload an image so the post carries the approved card.
 *
 * Anything that is not a modest image is skipped rather than forced: a missing
 * picture costs reach, a failed send costs the announcement entirely.
 */
async function uploadMedia(
  credentials: OAuth1Credentials,
  asset: UploadableAsset,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const assetResponse = await fetchImpl(asset.url, { signal: AbortSignal.timeout(10_000) });
    if (!assetResponse.ok) return null;

    const contentType = assetResponse.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;

    const bytes = new Uint8Array(await assetResponse.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null;

    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const mediaData = btoa(binary);

    const bodyParams = { media_data: mediaData };
    const authorization = await oauth1Header(
      'POST',
      MEDIA_UPLOAD_ENDPOINT,
      credentials,
      bodyParams,
    );

    const uploadResponse = await fetchImpl(MEDIA_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(bodyParams),
    });
    if (!uploadResponse.ok) return null;

    const json = (await uploadResponse.json()) as { media_id_string?: string };
    return json.media_id_string ?? null;
  } catch (err) {
    log('warn', 'x.media_upload_failed', { error: String(err) });
    return null;
  }
}

export interface XSendInput {
  creatorId: string | null;
  caption: string;
  assetUrl: string | null;
  assetKind: string | null;
  costUsd: number;
}

/**
 * Post to X through the official API.
 *
 * This is the whole production transport. There is deliberately no browser
 * automation, cookie replay or anti-bot path: those are against X's rules,
 * would make a session cookie one more secret to defend, and are not something
 * we are willing to run unattended on creators' behalf.
 */
export async function sendToX(
  repo: Repo,
  env: Env,
  _cfg: Config,
  input: XSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const body: { text: string; media?: { media_ids: string[] } } = { text: input.caption };
  let headers: Record<string, string>;

  // A creator-owned connection wins over the network account when present.
  const creatorAuth = input.creatorId
    ? await repo.getChannelAuth(input.creatorId, 'x')
    : null;

  if (creatorAuth && creatorAuth.auth_kind === 'oauth2_user') {
    let accessToken = creatorAuth.access_token;
    const expiresAt = creatorAuth.token_expires_at;
    if (!accessToken || (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000))) {
      accessToken = await refreshCreatorToken(repo, env, creatorAuth, fetchImpl);
    }
    if (!accessToken) {
      return {
        ok: false,
        retryable: false,
        error_class: 'x_auth_unavailable',
        message: 'creator oauth2 token missing or unrefreshable',
      };
    }
    headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  } else {
    const credentials = networkCredentials(env);
    if (!credentials) {
      return {
        ok: false,
        retryable: false,
        error_class: 'x_auth_unavailable',
        message: 'network X credentials not configured',
      };
    }
    if (input.assetUrl) {
      const mediaId = await uploadMedia(
        credentials,
        { url: input.assetUrl, kind: input.assetKind ?? 'card' },
        fetchImpl,
      );
      if (mediaId) body.media = { media_ids: [mediaId] };
    }
    headers = {
      authorization: await oauth1Header('POST', TWEETS_ENDPOINT, credentials),
      'content-type': 'application/json',
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(TWEETS_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error_class: 'x_network', message: String(err) };
  }

  if (response.status === 201 || response.status === 200) {
    const json = (await response.json()) as { data?: { id?: string } };
    return { ok: true, provider_post_id: json.data?.id ?? null, cost_usd: input.costUsd };
  }

  const text = await response.text().catch(() => '');

  // 402/403 here is the pay-per-use or permission wall, not a transient error:
  // retrying just spends money and trips rate limits.
  if (response.status === 401 || response.status === 403 || response.status === 402) {
    return {
      ok: false,
      retryable: false,
      error_class: `x_http_${response.status}`,
      message: text.slice(0, 300),
    };
  }
  if (response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      retryable: true,
      error_class: `x_http_${response.status}`,
      message: text.slice(0, 300),
    };
  }
  return {
    ok: false,
    retryable: false,
    error_class: `x_http_${response.status}`,
    message: text.slice(0, 300),
  };
}

export const __testing = { percentEncode };
