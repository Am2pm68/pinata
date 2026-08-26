# stream.npntoi LIVE auto-post — Worker control plane

Implements the build contract
`00_GPT_TO_CODEX_STREAM_NPNTOI_LIVE_AUTOPOST_X_WORKER_20260826`.

```
MODEL SCHEDULES LIVE
   └─ TOiAF schedules promo            (D1 `schedules`, real sources only)
      └─ 60-minute reminder            (Cron → Queue → channel adapter)
         └─ MODEL ACTUALLY GOES LIVE
            └─ WORKER CONFIRMS         (provider API, flap-suppressed)
               └─ X / TELEGRAM / BLUESKY "LIVE NOW"
                  └─ CLICK RESOLVES to the current live destination
                     └─ RICHGIRLS RECORDS THE RESULT
```

---

## What is NOT in this repository

The contract's `READ/RECONCILE FIRST` section could not be carried out from this
session. The following live systems are on the WordPress production host or in
repositories that are not attached here, so their bytes, versions and hashes
were never read:

| Item | Status |
| --- | --- |
| `toiaf-live-aggregator` plugin + its Worker | **not reachable** — provider adapter written to the documented StripCash Aggregators API shape |
| `toiaf-drop-broadcaster` (reported v0.4.1) | **not reachable** — integrated through a documented hand-off, not modified |
| stream.npntoi model mapping + dead-link resolver | **not reachable** — resolver re-implemented per the contract's 4-step order |
| Share This Drop / promo derivative contract | **not reachable** — modelled as the `public_assets` registry |
| RichGirls creator settings UI | **not reachable** — this Worker exposes the API the UI binds to |

Nothing here edits, replaces or duplicates the broadcaster's existing approval
logic for non-live promos. Two integration modes are provided:

- `BROADCASTER_MODE=direct` — this Worker sends (default, used by the tests).
- `BROADCASTER_MODE=broadcaster` — this Worker stays the scheduler, live
  detector and idempotency owner, and hands each intent to the existing
  broadcaster at `BROADCASTER_INTENT_URL`, HMAC-signed.

Before enabling on production, reconcile the live aggregator's actual provider
endpoint into `PROVIDER_API_BASE` and confirm the broadcaster's intent endpoint.

---

## Architecture

| Concern | Where |
| --- | --- |
| Live truth | `src/live/provider.ts` — provider aggregator API only, never HTML |
| Flap suppression | `src/live/detector.ts` |
| Scheduling | `src/schedule/cron.ts` (Cron Trigger, 1 min) |
| Delivery | `src/intents/consumer.ts` (Cloudflare Queue + DLQ) |
| Exactly-once | `outbound_intents.idempotency_key` UNIQUE, `src/lib/ids.ts` |
| Fail-closed gates | `src/lib/guards.ts` |
| Copy | `src/content/templates.ts`, safety scan in `src/content/safety.ts` |
| Media | `src/content/assets.ts` against the `public_assets` registry |
| Links | `src/links/resolver.ts`, public route `GET /go/live/:slug` |
| Channels | `src/channels/{x,telegram,bluesky,manual,broadcaster}.ts` |
| RichGirls/admin API | `src/api/routes.ts`, HMAC auth in `src/api/auth.ts` |

No Durable Object is used. One active session per room is guaranteed by the
`UNIQUE (creator_id, provider_room_id, session_start_epoch)` constraint plus
conditional `UPDATE`s that only fire on the expected prior state — the smallest
design that holds the invariant. A DO is the escalation path if per-creator
write contention ever shows up.

### Live detection

`session_start_epoch` comes from the provider when it supplies one, otherwise
from the first sighting floored to the minute. It is written once and never
changes, which is what keeps the idempotency key stable for the life of a show.

- **Confirm** requires `LIVE_CONFIRM_CHECKS` consecutive online sightings **and**
  `LIVE_CONFIRM_SECONDS` of wall clock. Only a confirmed session may announce.
- **Reconnect** inside the grace window resolves to the same session row, so a
  brief drop cannot produce a second post.
- **End** requires `OFFLINE_CONFIRM_CHECKS` consecutive misses **and**
  `OFFLINE_GRACE_SECONDS` since the last sighting.
- **A failed provider fetch is not "everyone offline".** The cycle aborts and
  live state is left exactly as it was.

### Exactly-once

```
creator_id | provider_room_id | ses:<session_start_epoch> | event | channel
creator_id | provider_room_id | sch:<schedule_id>         | event | channel   (pre-live)
creator_id | noroom           | promo:<promo_post_id>     | promo | channel   (campaigns)
```

Claimed with `INSERT … ON CONFLICT(idempotency_key) DO NOTHING`; the first
caller wins. Delivery adds a second guard: `UPDATE … WHERE status IN
('queued','failed')`, so a redelivered queue message changes zero rows and acks
without sending.

### Fail-closed order

Checked at plan time and **again at send time** — the send-time run is
authoritative, because a creator can revoke in the minute between the two.

1. emergency kill switch (global, then per channel) — an unreadable flag counts as engaged
2. channel deployment gate (`TOIAF_ALLOW_AUTO_LIVE_*`, only `"1"` opens)
3. creator approval, mapping confirmed, live promotion on, channel on, not revoked
4. live state confirmed (LIVE NOW only) and session not suppressed
5. spam guards — one announcement per session/channel, `MIN_SESSION_INTERVAL_MINUTES` between shows
6. safe link resolves — a LIVE NOW whose link cannot reach the live stream is not sent
7. public-safe media — required media that fails validation stops the post
8. X budget guard — an unset budget means *not provisioned*, which blocks
9. near-duplicate copy — try another variant, then stop
10. duplicate idempotency key

A failed social send touches nothing outside this Worker: no streaming, payments,
entitlements or media protection path is in its blast radius.

### X transport

Official API only — `POST https://api.x.com/2/tweets`, OAuth 1.0a for the
network account (signature verified in tests against X's own documented
vector) or OAuth 2.0 user context for a creator-owned account with a stored
refresh token that revoke clears.

There is deliberately **no** XActions, stealth Chrome, cookie replay, CDP
evasion or browser-use agent. X prohibits unauthorised automation, and a session
cookie would be one more secret to defend.

X is pay-per-use. `X_COST_PER_POST_USD` (0.015) and
`X_COST_PER_POST_WITH_URL_USD` (0.200) are config, not constants — **verify the
live Developer Console rates before enabling.** Because every LIVE NOW carries a
link, budget at the 0.200 tier.

**Free fallback.** When X auth or budget is unavailable the announcement is not
dropped: a `manual_x` intent is created with the same copy and link, an admin is
notified with a one-tap `https://x.com/intent/post` composer, and the intent sits
at `awaiting_manual` until a human posts it. Nothing clicks that browser for them.

### Link resolution

Posts carry `https://toiaf.com/go/live/{creator}` — never a stream URL. At click
time:

1. the verified active stream (`stream.npntoi.com/<model>`), gated on confirmed live state
2. the creator's own profile/live surface
3. LIVE discovery filtered to the same approved niche
4. `/live/`

Every resolution is recorded with its step; anything past step 1 is flagged
`was_corrected` so dead destinations are measurable.

### Analytics

Per outbound post: creator/session/event/channel, scheduled and sent times,
provider post id, campaign id, send status and error class, measured clicks, and
conversions arriving through an authenticated callback with a unique
`external_ref`. **No impressions are reported** — there is no truthful source for
them, so the field does not exist.

---

## Deploy

```bash
cd worker
npm install
npx wrangler d1 create toiaf_live_autopost        # put the id in wrangler.toml
npx wrangler queues create toiaf-live-outbound
npx wrangler queues create toiaf-live-outbound-dlq
npm run migrate:remote

npx wrangler secret put TOIAF_API_HMAC_SECRET
npx wrangler secret put PROVIDER_API_KEY
npx wrangler secret put X_API_KEY          # + X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN # + TELEGRAM_CHAT_ID
npx wrangler secret put BLUESKY_APP_PASSWORD
npm run deploy
```

Secrets live in Worker secrets. Never in the WP database, the repo, chat, a
browser profile or source.

### Canary order

Every gate ships at `"0"`. Do not change more than one at a time.

1. `npm run typecheck && npm test`
2. Deploy with all gates `0`. Confirm `GET /api/v1/admin/status` shows them off.
3. Dry run: `POST /api/v1/admin/run-cron`. Detection, planning and the
   fail-closed path all exercise with **zero** external sends — the
   "gates off" test asserts exactly this.
4. Verify sessions confirm, flap suppression holds, and no intent leaves `skipped`.
5. Confirm X billing and rates in the Developer Console, then set
   `X_MONTHLY_BUDGET_USD` to a real cap.
6. Set `TOIAF_ALLOW_AUTO_LIVE_X=1` for **one** opted-in creator. Fire
   `POST /api/v1/admin/canary`. Check the exact post text, that the link
   resolves, that no duplicate appeared, and that the analytics row is present.
7. Only then widen. Telegram and Bluesky gate independently.

### Rollback

- `POST /api/v1/admin/kill-switch {"engaged":true}` — stops every channel at once,
  no redeploy. Add `"channel":"x"` to stop one.
- Set the channel var back to `"0"` and redeploy.
- `npx wrangler rollback` for the Worker itself.
- Creator-level: `POST /api/v1/creators/:id/revoke` cancels queued intents and
  clears stored X tokens in the same call.

---

## RichGirls integration

All `/api/v1/*` calls are signed:

```
X-TOIAF-Timestamp: <unix seconds>
X-TOIAF-Signature: hex(hmac_sha256(secret, "<ts>.<METHOD>.<path>.<raw body>"))
```

Five-minute skew window; cookies are not a credential on any endpoint.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/creators/:id/live-promotion` | panel state: toggles, next live, public link, last auto post |
| PUT | `/api/v1/creators/:id/live-promotion` | LIVE PROMOTION on/off, per-channel toggles, copy defaults |
| POST | `/api/v1/creators/:id/revoke` | immediate revoke + cancel queued + clear X tokens |
| POST | `/api/v1/creators/:id/schedule` | NEXT LIVE (`source`: `toiaf` \| `provider` \| `richgirls`) |
| DELETE | `/api/v1/schedules/:id` | cancel |
| POST | `/api/v1/creators/:id/preview` | POST PREVIEW, renders without queueing |
| GET | `/api/v1/creators/:id/results` | sent / failed / skipped + measured clicks and conversions |
| POST | `/api/v1/webhooks/conversion` | real conversion intake, deduped on `external_ref` |
| POST | `/api/v1/admin/kill-switch` | emergency stop |
| GET | `/api/v1/admin/status` | gates, kill switches, month-to-date X spend |
| POST | `/api/v1/admin/run-cron` | dry-run / manual tick |
| POST | `/api/v1/admin/canary` | one supervised send, all gates still in force |
| GET | `/go/live/:slug` | public click-time resolver |

Existing creators default to **OFF**. A wallet/NFTOI capability may be recorded
in `creator_channel_auth.wallet_grant_ref` (e.g.
`SOCIAL_PUBLISH_X_LIVE_GRANTED`) for interoperability and audit, but it does not
substitute for X OAuth or TOiAF account authorization.

---

## Test coverage

`npm test` — 81 tests. The QA matrix from the contract:

| Scenario | File |
| --- | --- |
| creator scheduled then cancels | `schedule.test.ts` |
| creator starts early / late | `schedule.test.ts` |
| no schedule but goes live | `schedule.test.ts` |
| stream disconnect / reconnect | `detection.test.ts` |
| duplicate cron / queue delivery | `idempotency.test.ts` |
| dead mapped route | `links.test.ts` |
| missing promo media | `gates.test.ts` |
| X credit / auth failure | `gates.test.ts` |
| creator disables auto-post before send | `gates.test.ts` |
| multiple models live simultaneously | `detection.test.ts` |
| one model under two provider identifiers | `detection.test.ts` |
| daylight-saving / timezone boundary | `content.test.ts` |
| gates off ⇒ no external call | `gates.test.ts` |
| provider API outage | `detection.test.ts` |

Tests run against Node's built-in SQLite rather than a mock, so the UNIQUE
constraints and `changes == 0` semantics the idempotency guarantees rest on are
the real engine.

Mobile RichGirls layouts at 360/390/430 are not covered here — this repository
contains no UI.
