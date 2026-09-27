# Amply node

The Worker an artist runs in **their own** Cloudflare account. It serves one artist's music
to listeners. Amply never runs this, never has access to it, and cannot change it.

## What it does

| Route | Returns |
|---|---|
| `GET /` | The artist's page, rendered from the manifest. `/privacy` is their privacy notice. |
| `GET /manifest.json` | The manifest, from D1. CORS open, cached 5 min. |
| `GET /audio/<key>` | Audio from R2. Range requests supported (seeking). Paid tracks need a listener's pass. |
| `GET /art/<key>` | Images from R2. |
| `GET /version` | `{ version, spec }` — lets the editor spot a stale service. |
| `/listen/…` | What a listener signs for with their wallet: a pass, play counts, subscriptions, purchases, and seeing or erasing their own record. |
| `/manage/…` | The artist's editor and its API, behind Cloudflare Access and verified again here (`src/access.ts`). |

## Bindings

| Binding | Type | Holds |
|---|---|---|
| `MEDIA` | R2 bucket | audio under `audio/`, images under `art/`, the editor under `manage/` |
| `DB` | D1 database | the manifest, settings, listener tallies, subscriptions and sales (`src/store.ts`) |
| `LIMIT_*` | rate limiters | request limits (`src/limits.ts`); optional |

Setup at amply.stream (`site/js/provision.js`) creates these in the artist's account.

## Deliberately small

Every line here is a line someone may have to update inside their own cloud account later,
and Amply has no channel to do that for them — by design (`docs/legal.md` §4). Logic that
might change belongs in the **client**.

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
