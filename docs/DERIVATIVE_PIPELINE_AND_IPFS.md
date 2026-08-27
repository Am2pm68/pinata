# Public derivative pipeline + NFTOI / IPFS lane

**Status:** design only — no code. Decision record for two things that turn out
to be one pipeline.
**Scope agreed:** NFTOI token metadata and approved public assets on IPFS. R2
keeps every protected master and the whole HLS lane.

---

## 1. The insight: this is one pipeline, not two projects

The AI video editor is the *producer* of the artifact that the IPFS lane pins
and the broadcaster attaches to a post. Blurred, cut, transitioned and
watermarked output **is** the public-safe derivative. Designing them separately
would mean two registries, two review gates and two ways to leak a master.

```
  R2 master (protected, never leaves)
        │
        ▼
  ┌───────────────────────────────────────────┐
  │ DERIVATIVE JOB                            │
  │  face detect → selective blur             │
  │  shot detect → cut → transition           │
  │  watermark burn-in → encode               │
  └───────────────────────────────────────────┘
        │
        ▼
  HUMAN REVIEW GATE  ← mandatory, no auto-publish
        │
        ▼
  public_assets row  (approved=1, watermarked=1)
        │
        ├─► pin to IPFS ──► CID ──► NFTOI token metadata
        │
        └─► broadcaster attaches to X / Telegram / Bluesky post
                  │
                  └─► /go/live/{creator} resolves the click
```

Everything downstream of the review gate already exists and is tested. This
document is about the two boxes upstream of it.

---

## 2. Part A — NFTOI / IPFS lane

### 2.1 What goes on IPFS, and what never does

| Class | Destination | Why |
| --- | --- | --- |
| NFTOI token metadata (ERC-721 JSON) | **Public IPFS** | Content-addressing is the point: the CID in the token is provable and outlives TOiAF infrastructure |
| NFTOI token image | **Public IPFS** | Same; must be a reviewed derivative, never a frame grab from a master |
| Approved watermarked promo cards / GIFs / teasers | **Public IPFS** | Already public by definition; a CID adds durability and a second serving path |
| Paid masters, VOD sources, HLS renditions | **R2 only** | A CID is a permanent public handle. No revocation, no per-viewer entitlement, and unpinning does not delete |
| Anything pre-review | **Nowhere** | Not pinned, not served, not addressable |

### 2.2 Cloudflare Web3 and Pinata are not alternatives

Cloudflare Web3 is a **read path** — it serves IPFS content over HTTP on a
hostname you control. It stores nothing. Pinata is the **storage and pinning
layer**. Use both:

- Pin at Pinata (`upload.public.json()` / `upload.public.file()`).
- Serve through a Cloudflare Web3 **custom gateway** on a TOiAF hostname, so
  public links stay on TOiAF domains rather than a vendor's.

Cloudflare deprecated the shared `cloudflare-ipfs.com` / `cloudflare-eth.com`
hostnames in favour of custom gateways. Anything still pointed at those needs
migrating.

### 2.3 SDK surface (verified against `pinata` v2.5.6, the version already in `utils/`)

Every namespace is split by network, which maps cleanly onto the table above:

```
pinata.upload.public.file() | .json() | .base64() | .url() | .createSignedURL()
pinata.upload.private.…                       (same methods, private network)
pinata.gateways.public.get(cid) | .convert(url)
pinata.gateways.private.createAccessLink({ cid, expires })
pinata.files.public.…  /  pinata.files.private.…
pinata.groups.public.… /  pinata.groups.private.…
```

Private IPFS is not announced to the public DHT and reads require a
time-limited access link. That is close to R2 + signed URLs — which is exactly
why it is **not** in this scope: it would duplicate a capability we already
have, at a second vendor, for protected content. Revisit only if the non-TOiAF
creator tier actually ships.

### 2.4 Schema delta

Additive to the existing `public_assets` table — no migration of live rows:

```sql
ALTER TABLE public_assets ADD COLUMN cid TEXT;
ALTER TABLE public_assets ADD COLUMN ipfs_network TEXT;      -- 'public'
ALTER TABLE public_assets ADD COLUMN pin_status TEXT;        -- unpinned|pinning|pinned|failed
ALTER TABLE public_assets ADD COLUMN pinned_at INTEGER;
ALTER TABLE public_assets ADD COLUMN gateway_url TEXT;       -- TOiAF Web3 gateway URL
CREATE INDEX idx_public_assets_cid ON public_assets(cid);
```

Pinning is triggered **on approval**, never on upload. The existing safety
scanner in `worker/src/content/safety.ts` needs the gateway host added to
`PUBLIC_ASSET_ALLOWED_HOSTS`; its forbidden-pattern list already blocks the
things that must not reach a post.

### 2.5 NFTOI token metadata

Standard ERC-721 shape, built only from public-safe fields — the same
`PublicSafeContext` discipline the caption renderer uses:

```json
{
  "name": "<creator display name> — <edition>",
  "description": "<approved public copy>",
  "image": "ipfs://<cid of reviewed derivative>",
  "external_url": "https://toiaf.com/go/live/<creator>",
  "attributes": [
    { "trait_type": "Niche",   "value": "<approved niche>" },
    { "trait_type": "Network", "value": "TOiAF" }
  ]
}
```

`external_url` deliberately points at the **resolver**, not a stream — so a
token minted today still lands somewhere real in a year. This is the same
reasoning as the promo links.

The `wallet_grant_ref` column already on `creator_channel_auth` (used today for
`SOCIAL_PUBLISH_X_LIVE_GRANTED`) is the right place to record token-derived
capabilities. Wallet identity remains an audit/interop record — it does not
substitute for OAuth or a TOiAF account.

### 2.6 Two gates before any code

**Gate 1 — Pinata's Acceptable Use Policy.** `pinata.cloud` is blocked by this
session's egress proxy, so the AUP text was never read here. What is visible
second-hand prohibits "offensive" content in general terms. For an adult
network that is unquantified vendor risk, and a suspension would strand NFTOI
metadata that minted tokens permanently reference. **Required:** read
`pinata.cloud/terms` and the acceptable-use page, and get written confirmation
from Pinata sales that adult content on a paid plan is permitted. If the answer
is no or evasive, pin elsewhere or self-host an IPFS node before minting.

**Gate 2 — permanence.** A public CID cannot be unpublished. If a creator later
leaves or requests deletion, the metadata and image remain retrievable by
anyone holding the CID. Decide deliberately, in writing, before the first mint:

- *Immutable* — token points at a CID. Verifiable, permanent, unrevocable.
- *Mutable* — token points at a TOiAF resolver URL that can be changed. Revocable,
  but gives up the verifiability that was the reason to use IPFS at all.

There is no third option, and choosing by default is choosing immutable.

---

## 3. Part B — the editor

### 3.1 What it has to do

1. **Blur or cut faces.** Selectively: the performing creator stays visible,
   everyone else in frame is anonymised.
2. **Clean transitions and cuts.** Remove dead air, join takes, produce a
   watchable promo cut.
3. **Watermark burn-in**, so the output satisfies the broadcaster's existing
   watermark validation without a second pass.

### 3.2 Face blur is a compliance control, not an effect

Treat a missed face the way the rest of this system treats a missed gate: as a
failure that must not be able to publish. Three design consequences:

- **Bias toward over-blur.** Run detection at a low confidence threshold. A
  blurred bystander is a cosmetic cost; an unblurred one is a real harm to a
  real person.
- **Temporal interpolation, not per-frame independence.** Detectors drop
  frames. Track each face across time and hold the mask through gaps, so a
  three-frame miss does not flash an identifiable face. Per-frame-only tools
  (which is most of them, out of the box) will do exactly that.
- **Fail closed.** If detection errors, or confidence collapses on a segment, or
  the operator flags it, the derivative does not reach `approved=1`. No
  auto-publish path, ever.

**A human review gate is mandatory before `approved=1`.** Automated
anonymisation is a first pass that saves hours, not a substitute for a person
confirming the output is safe to publish. This is the single most important
constraint in this document.

### 3.3 Recommended stack — self-hosted

| Need | Tool | Notes |
| --- | --- | --- |
| Face detection | **CenterFace** via [`deface`](https://github.com/ORB-HD/deface) | ~2 MB ONNX model, CPU-viable, blur / solid / mosaic / image filters, re-encodes with ffmpeg and re-muxes audio |
| Match against the face allowlist | **ArcFace / InsightFace embeddings** compared to a two-person enrolled gallery | Closed-set recognition, not open-set tracking — see §3.4. [`deface-with-selective-face-blurring`](https://github.com/mitsoul/deface-with-selective-face-blurring) is a useful reference for wiring selective blur into `deface`, but its person re-ID approach is heavier than this problem needs |
| Shot / scene detection | PySceneDetect | Deterministic cut points |
| Cut, transition, watermark, encode | ffmpeg (`xfade`, `overlay`, `concat`) | Deterministic and inspectable — no model in the render path |

**Self-hosted, not a managed vision API.** AWS Rekognition, Google Video
Intelligence and Azure all carry content policies that land in the same place as
Gate 1 above, and this pipeline would be sending them the *unblurred master* —
the one asset that must never leave your control. Self-hosting removes both
problems at once. CenterFace is small enough that this is not a hard call.

### 3.4 The face allowlist

**Confirmed:** exactly two performers may appear unblurred.

| Performer | Status |
| --- | --- |
| `GoddessBearDonk` | face visible |
| `Xtra.lrg.Sweet.Tea` | face visible |
| **everyone else, without exception** | **blurred** |

This is a closed set, and that changes the engineering for the better. "Blur
everyone except the person we are following" is open-set re-identification —
track an unknown subject across a clip and hope the track survives occlusion,
turns and cuts. "These two named identities stay, everything else blurs" is
recognition against a gallery of two: embed every detected face, compare it to
the enrolled references, keep it only on a confident match. No tracking to lose,
and each frame is decided on its own evidence.

**Default deny.** The comparison runs at a *high* match threshold, and anything
that is not a confident match to an enrolled performer is blurred — including
faces the matcher is merely unsure about, faces at bad angles, motion-blurred
faces, and faces too small to embed reliably. The asymmetry is the whole point:

- a wrongly blurred allowlisted performer costs a re-run,
- a wrongly unblurred bystander is an irreversible harm to a real person.

Tune the threshold against the second failure, never the first. Expect to blur
some frames of GoddessBearDonk and Xtra.lrg.Sweet.Tea in profile or at distance;
that is the system working correctly, and the reviewer can request a re-run at a
looser threshold for a specific clip if the loss is unacceptable.

**Enrollment.** Each allowlisted performer needs a small reference set — a
handful of clear, varied stills (angles, lighting, with and without makeup or
accessories that recur in their material). Store the *embeddings*, and treat the
reference images as protected material under the same rules as masters. Never
pin them, never attach them to a post.

**The allowlist is a consent record.** It is the artifact that says these two
people agreed to be identifiable and nobody else did, so it needs the handling a
consent record gets:

- an owner who can add or remove an entry, and nobody else;
- a date on every entry, and on every change;
- a revocation path — removing a performer must trigger review of derivatives
  already published with their face visible, not merely change future renders;
- versioning, so a derivative records *which* version of the allowlist produced
  it. A clip rendered before a revocation is not automatically compliant after one.

Bind the allowlist version into `derivative_jobs.recipe_version` (§3.7) so this
is answerable from the row rather than from memory.

### 3.5 Where it runs

Not in a Worker — Workers cannot do this, and shouldn't.

| Option | Verdict |
| --- | --- |
| **Cloudflare Containers** | Good fit for the ffmpeg half and keeps everything on Cloudflare next to R2. **No GPU in the standard Containers offering** (GPUs exist only in a separate specialised preview), so detection runs on CPU |
| **GPU VM** (any provider) | ~10–20× faster detection. Worth it at ToiletFeed back-catalogue volume; adds a box to secure and an egress path from R2 |
| **Local workstation** | Fine for the first batch. Zero infrastructure, no upload of masters, but does not scale and does not audit |

Recommendation: prototype locally on real ToiletFeed footage to tune the match
threshold and confirm the allowlist holds across a full clip, then move the
settled pipeline to a GPU VM if throughput demands it. Do not build the distributed
version first — the tuning is the hard part, and it is unaffected by where it runs.

### 3.6 "AI editing" — scope honestly

Two very different asks are hiding in one phrase:

- **Deterministic editing** — shot detection, cut on silence, crossfade, trim,
  watermark. Solved, reliable, ships in a week or two. This is what "clean
  transitions" actually needs.
- **Editorial judgement** — choosing the best moments, pacing a promo, matching
  a hook to a beat. Genuinely open-ended, wants a human in the loop, and should
  not be in scope until the deterministic half is running.

Phase the first, and treat the second as a later experiment with a person still
holding the cut.

### 3.7 Job model

Reuse the pattern already proven in the Worker rather than inventing one:

```sql
CREATE TABLE derivative_jobs (
  job_id            TEXT PRIMARY KEY,
  idempotency_key   TEXT NOT NULL UNIQUE,   -- source asset + recipe version
  creator_id        TEXT NOT NULL,
  source_ref        TEXT NOT NULL,          -- R2 key, never a public URL
  recipe            TEXT NOT NULL,          -- blur mode, thresholds, transitions
  recipe_version    TEXT NOT NULL,
  status            TEXT NOT NULL,          -- queued|running|review|approved|rejected|failed
  detection_report  TEXT,                   -- per-segment confidence, gaps, frame counts
  output_asset_ref  TEXT,
  reviewed_by       TEXT,
  reviewed_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

Same properties as `outbound_intents`: unique idempotency key so a re-run cannot
produce a duplicate derivative, explicit terminal states, and a `detection_report`
so the reviewer sees *where* the model was unsure rather than approving blind.

This slots directly after the existing `toiaf-content-organization` workflow —
that skill produces the manifest, this consumes it.

---

## 4. Sequencing

1. **Resolve Gate 1 and Gate 2.** Neither needs code and both can invalidate work.
2. **Enrol the two allowlisted faces and prototype locally** on real footage.
   Tune the match threshold until the allowlist holds across a full clip, biased
   toward over-blur. Nothing else matters until this works.
3. **Add the review gate and `derivative_jobs`.** Human approval is what promotes
   a derivative to `approved=1`.
4. **Wire pinning on approval.** Additive schema, one adapter, TOiAF Web3 gateway.
5. **NFTOI metadata builder** — only once Gate 2 is answered in writing.
6. **Scale the editor** to a GPU box if volume demands it.

Steps 1–2 are the whole risk. Steps 3–6 are the parts this codebase is already
shaped for.

---

## 5. Open questions

- Pinata AUP for adult content — blocking, see Gate 1.
- Immutable vs mutable token metadata — blocking for minting, see Gate 2.
- ~~How many named performers stay visible?~~ **Answered:** two, closed set —
  `GoddessBearDonk` and `Xtra.lrg.Sweet.Tea`. See §3.4.
- Who owns the allowlist, and where does it live so that a change is dated and
  auditable rather than a message in a chat?
- Is there a signed consent record behind those two entries, or is the allowlist
  itself the only record today? If the latter, that gap should close before the
  first public derivative ships.
- What happens to already-published derivatives if one of the two revokes?
- Retention: how long are unblurred masters kept after a derivative is approved?
