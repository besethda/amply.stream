# Amply node

The Worker an artist runs in **their own** Cloudflare account. It serves one artist's music
to listeners. Amply never runs this, never has access to it, and cannot change it.

## What it does

| Route | Returns |
|---|---|
| `GET /manifest.json` | The manifest, from KV. CORS open, cached 5 min. |
| `GET /audio/<key>` | Audio from R2. Range requests supported (seeking). |
| `GET /art/<key>` | Images from R2. |
| `GET /version` | `{ version, spec }` — lets a management page spot a stale node. |

`HEAD` and `OPTIONS` are handled. Everything else is 404 or 405.

## Bindings

| Binding | Type | Holds |
|---|---|---|
| `MEDIA` | R2 bucket | audio under `audio/`, images under `art/` |
| `MANIFEST` | KV namespace | one key, `manifest` |

The IDs in `wrangler.jsonc` are **placeholders**. Real deployment substitutes actual IDs —
the OAuth provisioning flow writes them, and the Deploy to Cloudflare button fills them in
from its setup page. Keep every binding's default name distinct: identical defaults are a
known cause of deploy failures.

## Deliberately small

Around 200 lines, and it should stay that way. Every line here is a line someone may have
to update inside their own cloud account later, and Amply has no channel to do that for
them — by design (`docs/legal.md` §4). Logic that might change belongs in the **client**,
which ships through the app stores like any normal app.

There is no auth, no session, no database, and no write path. The management UI writes to
R2 and KV directly using the artist's own credentials; this Worker only reads.

## Security notes

- R2 keys come from the URL path and are treated as hostile: traversal, absolute paths,
  backslashes, control characters and keys over 512 chars are rejected before any lookup.
- Keys are always prefixed (`audio/`, `art/`), so nothing outside those prefixes is
  reachable even if a check were missed.
- Range and conditional requests are handled by R2 itself via `range`/`onlyIf`, rather than
  hand-parsed.
- `observability` is off. The node should not accumulate logs about who listened to what.

## Costs

Egress is free at any volume — this is the whole reason self-hosting music works. Storage
is roughly $0.015/GB-month. What bills is requests: roughly half a million plays a month
before anything is charged, and $10–20/month at a few million. Verify against current rates.

## Local development

```
npm install
npm run dev        # wrangler dev
npm run typecheck
npm run deploy     # wrangler deploy
```
