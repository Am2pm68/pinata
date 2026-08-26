import { describe, expect, it } from 'vitest';
import { oauth1Header } from '../src/channels/x';
import { linkFacets, sendToBluesky } from '../src/channels/bluesky';
import { sendToTelegram } from '../src/channels/telegram';
import { composerUrl } from '../src/channels/manual';
import { jsonResponse, makeHarness } from './helpers/env';

describe('X OAuth 1.0a signing', () => {
  /**
   * The worked example from X's own "Creating a signature" documentation. If
   * this vector reproduces, the percent-encoding, parameter sort, signature
   * base string and HMAC-SHA1 key construction are all correct.
   */
  it('reproduces the documented signature vector', async () => {
    const header = await oauth1Header(
      'POST',
      'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
      'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      1318622958,
    );

    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_version="1.0"');
  });

  it('produces a different signature when the body differs', async () => {
    const credentials = {
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
    };
    const a = await oauth1Header('POST', 'https://api.x.com/2/tweets', credentials, {}, 'n', 1);
    const b = await oauth1Header(
      'POST',
      'https://api.x.com/2/tweets',
      credentials,
      { extra: '1' },
      'n',
      1,
    );
    expect(a).not.toBe(b);
  });
});

describe('Bluesky', () => {
  it('computes facet offsets in UTF-8 bytes, not string indexes', () => {
    const text = '🔴 LIVE NOW — go https://toiaf.com/go/live/cr_gemmi';
    const [facet] = linkFacets(text);

    expect(facet).toBeDefined();
    const encoder = new TextEncoder();
    const slice = encoder.encode(text).slice(facet!.index.byteStart, facet!.index.byteEnd);
    expect(new TextDecoder().decode(slice)).toBe('https://toiaf.com/go/live/cr_gemmi');
  });

  it('trims trailing punctuation out of a detected link', () => {
    const [facet] = linkFacets('see https://toiaf.com/live/.');
    expect(facet!.features[0]!.uri).toBe('https://toiaf.com/live/');
  });

  it('creates a session then a post record', async () => {
    const h = makeHarness();
    h.setResponder((url) => {
      if (url.endsWith('com.atproto.server.createSession')) {
        return jsonResponse({ accessJwt: 'jwt', did: 'did:plc:abc' });
      }
      if (url.endsWith('com.atproto.repo.createRecord')) {
        return jsonResponse({ uri: 'at://did:plc:abc/app.bsky.feed.post/1' });
      }
      return jsonResponse({});
    });

    const result = await sendToBluesky(
      h.env,
      { caption: 'LIVE NOW https://toiaf.com/go/live/cr_gemmi', assetUrl: null },
      h.fetch,
    );

    expect(result).toMatchObject({ ok: true, provider_post_id: 'at://did:plc:abc/app.bsky.feed.post/1' });
    const record = JSON.parse(String(h.calls[1]!.init!.body)).record;
    expect(record.facets).toHaveLength(1);
  });

  it('fails closed without credentials', async () => {
    const h = makeHarness({ BLUESKY_IDENTIFIER: undefined, BLUESKY_APP_PASSWORD: undefined });
    const result = await sendToBluesky(h.env, { caption: 'hi', assetUrl: null }, h.fetch);
    expect(result).toMatchObject({ ok: false, error_class: 'bluesky_auth_unavailable' });
  });
});

describe('Telegram', () => {
  it('uses sendPhoto when an approved card is attached', async () => {
    const h = makeHarness();
    h.setResponder(() => jsonResponse({ ok: true, result: { message_id: 42 } }));

    const result = await sendToTelegram(
      h.env,
      { caption: 'LIVE NOW', assetUrl: 'https://cdn.toiaf.com/card.jpg' },
      h.fetch,
    );

    expect(result).toMatchObject({ ok: true, provider_post_id: '42', cost_usd: 0 });
    expect(h.calls[0]!.url).toContain('/sendPhoto');
  });

  it('uses sendMessage without an asset', async () => {
    const h = makeHarness();
    h.setResponder(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
    await sendToTelegram(h.env, { caption: 'LIVE NOW', assetUrl: null }, h.fetch);
    expect(h.calls[0]!.url).toContain('/sendMessage');
  });

  it('treats 429 as retryable and 400 as terminal', async () => {
    const h = makeHarness();
    h.setResponder(() => new Response('slow down', { status: 429 }));
    expect(
      await sendToTelegram(h.env, { caption: 'a', assetUrl: null }, h.fetch),
    ).toMatchObject({ ok: false, retryable: true });

    h.setResponder(() => new Response('bad', { status: 400 }));
    expect(
      await sendToTelegram(h.env, { caption: 'a', assetUrl: null }, h.fetch),
    ).toMatchObject({ ok: false, retryable: false });
  });
});

describe('manual X fallback', () => {
  it('builds a composer URL carrying the exact caption', () => {
    const caption = '🔴 LIVE NOW — @gemmikakes\nWatch → https://toiaf.com/go/live/cr_gemmi';
    const url = new URL(composerUrl(caption));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
    expect(url.searchParams.get('text')).toBe(caption);
  });
});
