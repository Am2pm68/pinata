# toiaf-live-autopost

Cloudflare Worker control plane for TOiAF live auto-promotion: provider live
detection, scheduling, exactly-once outbound intents, and gated channel
delivery to X / Telegram / Bluesky.

Full architecture, deploy order, canary procedure and the RichGirls API
contract: [`../docs/LIVE_AUTOPOST.md`](../docs/LIVE_AUTOPOST.md).

```bash
npm install
npm run typecheck
npm test           # 81 tests, no network, no Cloudflare account needed
npm run dev
```

Every channel gate defaults to `"0"`. Nothing is sent until an operator opens a
channel **and** the runtime kill switch is clear.
