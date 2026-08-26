# TOIAF Messages — UI upgrade + myCred paywall

A drop-in redesign of `/messages/` for the `topnotch-toiaf-network` theme,
plus a clean single-step myCred (TP) paywall for unlocking paid content.

Built against the actual rendered DOM of the live page (the saved `TOIFEED.mht`),
so **the visual upgrade needs no template changes** — it reuses the class hooks
the current PHP already emits.

```
assets/css/toiaf-messages.css   redesigned stylesheet (drop-in replacement)
assets/js/toiaf-messages.js     progressive enhancement + unlock flow
inc/class-toiaf-message-paywall.php   myCred debit, REST route, asset loading
inc/paywall-card.php            the locked-card partial
preview/index.html              standalone visual preview
```

---

## What changed, and why

The old stylesheet had grown to 372 rules across three override layers that
fought each other — the tip button alone was defined three different ways and
then forced with `!important`. The rewrite is 220 rules in one pass.

| | Before | After |
|---|---|---|
| **Colour** | 5 accents at equal weight, everything glowing | one accent per role; glow reserved for the unlock CTA and active states |
| **Type** | 9–10px at 1–3px tracking, including body copy | display type keeps its tracking; body drops to 14px/1.55 at 0 |
| **Height** | `min-height: 720px` broke short viewports | `clamp(520px, 100dvh - 24px, 1100px)` |
| **Inbox** | avatar · name · role · preview · time | adds unread badges, presence dots, paid-thread tinting |
| **Thread** | every bubble stamped with its own meta | Telegram-style grouping, floating date chips, meta on last of run |
| **Paywall** | veiled 16:9 box, yellow button | blurred teaser, price as hero, five explicit states |
| **Composer** | fixed textarea, no price control | autosizing, Enter-to-send, inline TP price strip |
| **Breakpoints** | 9 overlapping media queries | 3, with a real one-pane-at-a-time mobile layout |

### Where the references landed

- **[Agora Chat UIKit][uikit]** supplied the component vocabulary — `ConversationItem`,
  `MessageList`, `MessageStatus`, `MessageInput`, `Empty`. Each now has a real
  counterpart, including the unread badge and empty states the page was missing.
- **[Agora Signaling / RTM][rtm]** is infrastructure, not UI — but its state model
  (presence, typing, receipts) is what the markup is now shaped around.
  `data-presence`, `data-status` and `.tnm-typing` are styled and inert today;
  wiring RTM in later is a data change, not a redesign.
- **Telegram** supplied the density rules: message grouping, floating date
  separators, Enter-to-send, and status ticks that don't shout.
- **Stripchat** supplied the money rules: balance permanently in view, price as
  the largest element on a locked card, and a top-up path that appears exactly
  when the buyer cannot afford the thing they are looking at.

[uikit]: https://github.com/AgoraIO-Usecase/AgoraChat-UIKit-web
[rtm]: https://docs.agora.io/en/realtime-media/im/get-started/skills

---

## The paywall

One card, one price, one button, one balance line. No modal, no page reload.

```
┌─────────────────────────┐
│   ░░ blurred teaser ░░  │   the real thumbnail, blurred — something to want
│                         │
│        [ LOCKED ]       │
│      Video · 2:14       │
│         45 TP           │   ← the price is the hero
│  ┌───────────────────┐  │
│  │ UNLOCK FOR 45 TP  │  │   ← one action
│  └───────────────────┘  │
│     Balance 120 TP      │   ← quiet, unless it is the problem
└─────────────────────────┘
```

Five states, all driven by one `data-state` attribute so the server, the CSS and
the JS can never disagree:

| State | What the buyer sees |
|---|---|
| `locked` | yellow `UNLOCK FOR n TP` |
| `insufficient` | orange outline `GET TP`, balance turns orange, "You need n more TP." |
| `unlocking` | spinner in the button, disabled |
| `unlocked` | blur lifts, panel fades, border goes lime — in place, no reload |
| `own` | the creator sees the price they set, never an unlock CTA |
| `error` | the reason, in the status line, button re-enabled |

---

## Install

1. Copy `assets/css/toiaf-messages.css` and `assets/js/toiaf-messages.js` over
   the theme's existing files.
2. Copy `inc/` into the theme and require it from `functions.php`:

```php
require_once get_stylesheet_directory() . '/inc/class-toiaf-message-paywall.php';
require_once get_stylesheet_directory() . '/inc/paywall-card.php';
```

3. Activate the theme once (or call `TOIAF_Message_Paywall::install_table()`) to
   create `{prefix}_toiaf_message_unlocks`.
4. In the message loop, replace the current `.tnm-paid-preview` block with:

```php
toiaf_paywall_card( array(
    'message_id'  => $message->id,
    'price'       => $message->price,
    'balance'     => TOIAF_Message_Paywall::balance( get_current_user_id() ),
    'kind'        => 'video',
    'meta'        => '2:14',
    'preview_url' => $blurred_teaser_url,
    'is_own'      => ( $message->creator_id === get_current_user_id() ),
    'unlocked'    => TOIAF_Message_Paywall::has_unlocked( get_current_user_id(), $message->id ),
    'media'       => $signed_media,   // only when unlocked
) );
```

Step 1 alone gets you the full visual upgrade. Steps 2–4 add the paywall.

### Three filters you must wire

The theme owns message storage, so the paywall cannot guess it. It returns 404
rather than assume:

```php
// 1. Load a message.
add_filter( 'toiaf_paywall_message', function ( $null, $id ) {
    $row = my_theme_get_message( $id );
    return $row ? array(
        'id'           => $row->id,
        'creator_id'   => $row->sender_id,
        'recipient_id' => $row->recipient_id,
        'price'        => (float) $row->tp_price,
        'kind'         => $row->media_type,
        'caption'      => $row->caption,
        'preview_url'  => $row->teaser_url,
    ) : null;
}, 10, 2 );

// 2. Mint the signed asset — only ever called after payment clears.
add_filter( 'toiaf_paywall_media', function ( $media, $message ) {
    $media['url'] = purple_heart_signed_url( $message['id'] );
    return $media;
}, 10, 2 );

// 3. Point at the right myCred type if TP is not the default.
add_filter( 'toiaf_paywall_point_type', fn() => 'toiletpapers' );
```

Optional: `toiaf_paywall_network_fee` (creator's cut, defaults to 0 — they keep
the full price), `toiaf_paywall_topup_url`, `toiaf_paywall_can_view`,
`toiaf_paywall_currency_label`. `toiaf_message_unlocked` fires once per sale.

---

## How the charge stays correct

A double-click, a retried request and two browser tabs all have to end with the
buyer charged exactly once. The unlock row is claimed **before** the points move:

1. `INSERT IGNORE` into a table with `UNIQUE KEY (user_id, message_id)`.
2. Zero affected rows means someone else won the race — return the media, charge
   nothing.
3. One affected row means we hold the claim: `mycred_subtract()`, then credit the
   creator.
4. If the debit fails, delete the claim. The buyer ends up exactly where they
   started.

The UNIQUE constraint is the lock, so this holds across concurrent PHP workers —
no transient, no `wp_cache`, nothing that fails open.

**CSS blur is not access control.** `preview_url` must be a genuinely degraded
thumbnail. The real asset URL is minted server-side in `get_media()` and only
reaches the browser after the debit succeeds.

---

## Verification status

- **CSS + JS** — rendered in Chromium at 1280×900 and 390×844, every paywall
  state exercised, no console or page errors. Screenshots reviewed.
- **PHP** — `php -l` clean. Not executed against a live WordPress + myCred
  install; the filters above are the untested seam.
- **Preview** — open `preview/index.html` directly in a browser. The buttons at
  the top flip the paywall through its states.

## Not included

- Real-time delivery. The composer still posts the form. `.tnm-typing`,
  `data-presence` and `data-status` are styled and waiting.
- The GIF/emoji panels — the tray button and styling exist, the pickers do not.
- Migrating the `!important` rules elsewhere in `99-overrides.css`. Nothing here
  needs them, but they are still in the cascade.
