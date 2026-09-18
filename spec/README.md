# The Amply Manifest

An artist publishes one JSON file describing who they are, what they've released, and how
to pay them. A client reads it. That file is the only contract in Amply — there is no API,
no server, and no registry.

Think of it as RSS for music.

**Spec version: 1**

---

## Where it lives

At `/manifest.json` on the artist's own node. That URL *is* their identity — it's what they
share and what a listener subscribes to.

```
https://music.hollowcoast.com/manifest.json
```

Served over HTTPS, with `Access-Control-Allow-Origin: *` so web clients can read it.

## Example

See [`example.json`](./example.json) for a complete, valid manifest.

```jsonc
{
  "amply": 1,
  "updated": "2026-09-18T12:00:00Z",
  "artist": { "name": "Hollow Coast" },
  "content": { "explicit": false },
  "payment": [
    { "type": "solana-usdc", "address": "7xKX…", "ratePerMinute": 0.01, "settleAt": 1.00 }
  ],
  "releases": [
    { "id": "longwave", "title": "Longwave",
      "tracks": [
        { "id": "signal-fade", "title": "Signal Fade", "duration": 214,
          "url": "https://music.hollowcoast.com/audio/signal-fade.m4a" }
      ]}
  ]
}
```

---

## Fields

### Root

| Field | Type | Required | Notes |
|---|---|---|---|
| `amply` | integer | **yes** | Spec version. Currently `1`. A client that doesn't know the version must refuse the manifest. |
| `updated` | ISO 8601 string | **yes** | When the manifest last changed. Clients use it to decide whether to re-read. |
| `artist` | object | **yes** | See below. |
| `content` | object | no | Content labels. Absent means `explicit: false`. |
| `payment` | array | no | Zero or more payment methods. Absent means the artist accepts no payment. |
| `releases` | array | **yes** | May be empty — a node with no music is valid. |

### `artist`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | 1–200 chars. Displayed everywhere. |
| `bio` | string | no | Max 2000 chars. Plain text — no markup. |
| `image` | URL | no | Avatar. HTTPS. |
| `links` | array | no | `{ label, url }`. Max 20. |

### `content`

| Field | Type | Default | Notes |
|---|---|---|---|
| `explicit` | boolean | `false` | Self-declared, at artist level. Individual tracks may override. |

Self-declaration only. Nothing verifies this, by design — see `docs/legal.md` §6.

### `payment`

An array, because an artist may offer several ways to pay and clients support different
ones. **A client uses the first entry whose `type` it understands and ignores the rest.**
Order therefore expresses the artist's preference.

**`type: "solana-usdc"`** — metered pay-per-listen.

| Field | Type | Required | Notes |
|---|---|---|---|
| `address` | string | **yes** | Base58 Solana address, 32–44 chars. |
| `ratePerMinute` | number | **yes** | USD per minute listened. Must be > 0 and ≤ `1.00`. |
| `settleAt` | number | no | USD accrued before a transfer fires. Default `1.00`. Range `0.05`–`100`. |

**`type: "link"`** — anything else: Ko-fi, Stripe, Bandcamp, a membership page.

| Field | Type | Required | Notes |
|---|---|---|---|
| `label` | string | **yes** | Max 40 chars. Shown on the button. |
| `url` | URL | **yes** | HTTPS. |

### `releases[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Unique within the manifest. `[a-z0-9-]`, 1–64 chars. Stable forever — clients key local state off it. |
| `title` | string | **yes** | 1–300 chars. |
| `date` | `YYYY-MM-DD` | no | Release date. |
| `art` | URL | no | Cover image. HTTPS. |
| `tracks` | array | **yes** | At least one. |

### `releases[].tracks[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Unique within the manifest. Same rules as release `id`. |
| `title` | string | **yes** | 1–300 chars. |
| `duration` | integer | **yes** | Seconds, > 0. Metering depends on it; a client must not have to fetch audio to learn it. |
| `url` | URL | **yes** | HTTPS. The audio file. |
| `explicit` | boolean | no | Overrides the artist-level flag for this track. |

---

## Rules

These are the rules a validator enforces and a client must assume.

1. **Every URL is absolute and HTTPS.** Relative URLs would make the manifest's location
   load-bearing. Plain HTTP would let anyone on the network path swap the payment address.
2. **`duration` is mandatory and in seconds.** Metering is time-based.
3. **IDs are stable and unique.** Changing an `id` orphans every listener's local state for
   that track. Treat them as permanent once published.
4. **Unknown fields are ignored, never rejected.** This is how the spec grows without
   breaking deployed clients. A client encountering `amply: 2` should refuse; a client
   encountering an unknown *field* should carry on.
5. **A rate is declared once, per artist** — not per track. Simpler to reason about and
   simpler to disclose honestly before the first play.

## What a client must do

The manifest is **untrusted input from a stranger that declares a price**. See
`docs/build.md` §2C. At minimum:

- **Clamp `ratePerMinute`** to a hard maximum the client will honour, whatever the file
  says. The spec's `1.00` ceiling is a validator rule, not a defence — a hostile node can
  serve anything.
- **Show the rate before the first play.** Require explicit confirmation above a low
  threshold, and re-confirm on any increase. Never silently adopt a new rate.
- **Reject non-HTTPS URLs** and any scheme that isn't `https:`.
- **Sanitise all text before rendering.** `name`, `bio`, `title` and `label` are XSS vectors.
- **Cap the payload.** Refuse a manifest over 2 MB.
- **Respect attribution.** Always display the artist's name with their work; never strip it.
  Swedish moral rights make this an obligation, not a courtesy — see `docs/legal.md` §11.5.

## Validating

```
node spec/validate.mjs spec/example.json
node spec/validate.mjs https://music.hollowcoast.com/manifest.json
```

Zero dependencies. Exits non-zero on error.
