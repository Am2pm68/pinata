# ⚠ Read before installing any PHP from this package

This package was built from a saved render of `/messages/` plus the theme's
stylesheets. At that point the messaging system looked like theme code. It is
not — it is a plugin:

> **TopNotch Messages** v4.4.0 — *"Lightweight messaging inbox for TOIAF /
> TopNotch with myCRED locks, Orbitron neon UI, emoji, attachments, and
> creator auto-lock pricing."*

The `.tnm-` class prefix is that plugin's. Everything here targets its markup.

## What is unaffected

The presentation layer is fine, because it only ever targeted rendered classes:

| File | Status |
|---|---|
| `assets/css/toiaf-messages.css` | ✅ Works as-is. Enqueue from the plugin instead of the theme. |
| `assets/css/toiaf-dock.css` | ✅ Self-contained, plugin-agnostic. |
| `assets/js/toiaf-dock.js` | ✅ Self-mounting; adopts `.toiaf-mcc` if present. |
| `assets/js/toiaf-messages.js` | ⚠ Mostly fine. Its **unlock call** points at this package's REST route — see below. |

Only the enqueue path changes: `get_stylesheet_directory_uri()` →
`plugin_dir_url( __FILE__ )`, or dequeue the plugin's stylesheet and enqueue
this one from the theme after it.

## What must NOT be installed without checking first

**`inc/class-toiaf-message-paywall.php` probably duplicates the plugin.**

v4.4.0 already advertises *"myCRED locks"* and *"creator auto-lock pricing"*.
This package independently implements a myCred debit, an unlock table, and a
creator payout. Running both is not a cosmetic overlap — it is two systems
that can each subtract TP for the same unlock.

Do not activate `class-toiaf-message-paywall.php` or `paywall-card.php` until
one of these is settled:

1. **The plugin's lock logic stays.** Then delete both PHP files and keep only
   the CSS/JS. Point `toiaf-messages.js` at the plugin's existing unlock
   endpoint by changing `CFG.restUrl`, and render the plugin's own locked
   markup — the legacy `.tnm-paid-preview` aliases in the stylesheet already
   restyle it to the new card, so the visual upgrade lands with zero PHP.
2. **This package's lock logic replaces it.** Then the plugin's lock path has
   to be disabled first, and the existing unlock records migrated into
   `{prefix}_toiaf_message_unlocks`, or previously-paid content re-locks for
   everyone who already bought it.

Option 1 is almost certainly right. The idempotency work in
`class-toiaf-message-paywall.php::charge()` is still worth reading — if the
plugin does not claim the unlock row before calling `mycred_subtract()`, it
can double-charge on a double-click, and that is worth checking either way.

## Other plugins that overlap

- **TOIAF Widgets Core** v1.0.1 — *"backend endpoints for right-rail widgets
  (messages stats, wallet, rich girls, tips). No layout/CSS injection."*
  `class-toiaf-dock.php` writes its own feed endpoint. Prefer wiring the dock
  to these existing endpoints via the `toiaf_dock_conversations` and
  `toiaf_dock_notifications` filters rather than adding a parallel API.
  Because the plugin injects no layout, the CSS that removes the right rail
  is safe — but the widget queries still run until the theme stops rendering
  them.
- **TOIAF Message Media Library Bridge** — likely owns attachment handling for
  paid message media. The paywall's `toiaf_paywall_media` filter is where that
  should hook, rather than minting URLs here.
- **TOIAF Live Aggregator** v0.3.1 — already consumes the StripCash
  Aggregators API through a Cloudflare Worker. Nothing here touches it.

## What is genuinely new

`class-toiaf-dock.php` adds something no listed plugin does: a **durable
notification store**. `toiaf-ux-notification-center` fires transient toasts
that vanish; a creator who was not looking never learns a tip arrived. The
dock archives them. That part does not duplicate anything — but it should read
from TOIAF Widgets Core where those endpoints already exist.
