# Session handoff

## Shipped (branch `claude/messaging-ui-design-4wbawd`)

| | |
|---|---|
| `assets/css/toiaf-messages.css` | Messaging redesign. 372 rules of fighting overrides → 248 in one pass. Verified in Chromium at 1280×900 and 390×844. |
| `assets/css/toiaf-dock.css` + `assets/js/toiaf-dock.js` | Floating dock: Messages · Activity · Concierge. Self-mounting. |
| `assets/js/toiaf-messages.js` | Grouping, date chips, unlock flow, nav collapse. |
| `preview/index.html`, `preview/shell.html` | Standalone previews. `shell.html` reproduces the theme grid so width claims are measured, not asserted. |
| Artifact | https://claude.ai/code/artifact/d10c8e9a-9bf4-42a5-b79d-2ff596cdd049 |

**The headline fix:** the thread was 250px wide at any viewport, because the
theme pinned main to `minmax(0, 600px)` between two 300px rails inside a
1200px shell. Now 790px at 1440, 1150px at 1920, 1090px with the nav
collapsed. The widgets were the symptom; the grid was the cause.

**Also fixed:** the toast stack (`z-index: 999999`) renders on top of the
concierge orb (`99999`) on the live site today. The dock takes the corner and
lifts toasts above it.

## Blocked — read `RECONCILE.md` first

Messaging is **TopNotch Messages v4.4.0**, a plugin, not theme code. `.tnm-`
is its prefix. CSS and JS are unaffected (purely presentational), but that
plugin already ships *"myCRED locks, creator auto-lock pricing"*, so
`inc/class-toiaf-message-paywall.php` likely duplicates it — two systems that
could each subtract TP for one unlock.

**Do not install the paywall PHP.** The recommended path deletes it: the
stylesheet's legacy `.tnm-paid-preview` aliases restyle the plugin's existing
locked cards, so the full visual upgrade ships with **zero PHP**.

To reconcile properly I need the plugin source, or just its unlock endpoint.

## Changelly — the integration seam

Relevant to today's meeting: the paywall already has the crypto on-ramp point
built in. When a buyer cannot afford an unlock, the card flips to
`data-state="insufficient"` and the CTA becomes **GET TP**, pointing at:

```php
apply_filters( 'toiaf_paywall_topup_url', $default );
```

That filter is the entire integration surface. A Changelly checkout URL
returned there puts crypto top-up at the exact moment of highest intent — the
buyer is looking at content they want and just learned they are short. It
currently points at the NPN `buy-toiletpapers` SSO flow.

Two things worth raising in the meeting:

- **Return path.** After a top-up the buyer should land back on the message
  they were trying to unlock, not a generic wallet page. Needs a `redirect_to`
  that survives the payment round-trip.
- **Settlement lag.** Crypto confirms in minutes, not instantly. The unlock
  card needs a `pending` state, or balance credits before confirmation and you
  carry the risk. This is a product decision, not a code one.

## Audience notes (captured, not acted on)

Raised at the end of the session and worth keeping:

- **Patron persona.** Distinguished / professional men, and younger tech and
  crypto-savvy earners. Spends real money, treats creators well, values the
  quality of his own experience on the platform. This is who the supporter-tier
  work would serve — badges from lifetime TP, "patron since", top-supporter
  visibility. Possibly better suited to InfiniteVV than TOIAF.
- **F/F segment.** Women who worship women — a distinct audience from the
  primary one, with its own discovery and recruitment path.
- **Privacy is a differentiator, internationally.** Worth treating as a
  positioning pillar rather than a compliance checkbox — it is what the patron
  persona above is actually buying.
- **Women-run business networks.** Agencies and platforms that back
  female-founded ventures are a real recruitment and partnership channel.
  Note that mainstream professional networks prohibit adult content, so a
  presence there is corporate/B2B only — creator-facing recruitment has to
  live elsewhere.

None of this is built. It needs a scoping pass of its own.
