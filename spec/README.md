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
| `licence` | object | no | Terms the artist grants for their recordings. See below. |
| `payment` | array | no | Zero or more payment methods. Absent means the artist accepts no payment. |
| `releases` | array | **yes** | May be empty — a node with no music is valid. |

### `artist`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | 1–200 chars. Displayed everywhere. |
| `bio` | string | no | Max 2000 chars. Plain text — no markup. |
| `image` | URL | no | Avatar. HTTPS. |
| `banner` | URL | no | Wide image across the top of the artist's page. HTTPS. |
| `domain` | string | no | A bare domain the artist owns, like `yourname.com`, in lower case. Shown to listeners only once the domain confirms it: see **Linking a domain** below. |
| `contact` | string | no | An email address or an HTTPS link, for listeners to reach the artist about their data. Shown on the artist's privacy page. An artist who charges holds a record of each paying wallet and so has to be reachable. |
| `links` | array | no | `{ label, url }`. Max 20. |

### `content`

| Field | Type | Default | Notes |
|---|---|---|---|
| `explicit` | boolean | `false` | Self-declared, at artist level. Individual tracks may override. |

Self-declaration only. Nothing verifies this, by design — see `docs/legal.md` §6.

### `licence`

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | **yes** | A licence identifier. `amply-personal-1` is the standard one. |
| `url` | URL | no | Where the full text lives. Required for a `type` of `custom`. |
| `notice` | string | no | Max 300 chars. A line the artist wants shown alongside their work. |

**This is the artist's licence, not Amply's.** Amply publishes the standard text the way
Creative Commons publishes theirs — so that shared, unambiguous terms exist and each artist
need not draft their own. Amply is not a party to it, cannot enforce it, has no standing to,
and receives nothing under it.

**`amply-personal-1`** — [full text](./licence/personal-1.md), published at `https://amply.stream/licence/personal-1`. In short: anyone may listen,
with any client, without paying; clients that meter are expected to honour the declared rate.
What it withholds is **redistribution** — rehosting, inclusion in a catalogue or directory
presented to other people, operating a service that provides access to others, transmitting
to the public, and training models. Those require the artist's separate permission, and
without it infringe their copyright in the recording.

It withholds redistribution **even when the audio is served from the artist's own node**,
because a service can build an audience on someone else's recordings while leaving them the
running costs. That is the case the field exists for.

**`custom`** — the artist's own terms, at a `url` they control.

**Absent** — a client must assume **no** redistribution permission has been granted. Silence
is not a grant. It should still play the music: publishing a public manifest is plainly an
invitation to listen.

**What this is not.** It is not a payment enforcement mechanism, and it cannot be one. A
personal-use client that does not pay is permitted, deliberately: the artist's own page
streams free to anyone, and withdrawing that would break the shared link that is the only way
listeners find artists at all. The licence exists to stop the aggregator, not the individual.

### `payment`

An array, because an artist may offer several ways to pay and clients support different
ones. **A client uses the first entry whose `type` it understands and ignores the rest.**
Order therefore expresses the artist's preference.

**`type: "solana-usdc"`** — metered pay-per-listen.

| Field | Type | Required | Notes |
|---|---|---|---|
| `address` | string | see notes | Base58 Solana address, 32-44 chars. Required unless `recipients` is present. |
| `recipients` | array | see notes | A split. Present instead of `address` when more than one person is paid. |
| `ratePerMinute` | number | **yes** | USD per minute listened. Must be > 0 and ≤ `1.00`. |
| `settleAt` | number | no | USD a listener owes before their client sends it. Default `1.00`. Range `0.01`-`100`. See below. |
| `network` | string | no | Which chain the artist is paid on: `solana` or `devnet`. Default `solana`. See below. |

**Which money.** A Solana address is valid on every network, so nothing about a payment
reveals which one it was made on: a transfer to the wrong one succeeds, tokens move, and an
artist expecting real money has been paid in something nobody can spend. Both ends see a
payment that worked.

So the artist declares it and the client obeys. A client **must not** pay an artist whose
`network` is not the one the listener's wallet holds money on, and **must not** accrue a debt
it could never settle. It should say why, plainly, rather than appearing to charge.

Absent means `solana` — real money. Every manifest written before this field existed meant
that, and a file that does not raise the question is not asking to be paid in something
worthless. `devnet` exists so that Amply itself, and anyone building a client, can run the
whole path end to end without spending anything.

A debt is settled in the money it was earned in. An artist who switches `network` after
somebody has listened is still owed for that listening; what changes is that nothing further
accrues.

**Settling.** Nobody holds money between a listen and a payment: not Amply, not a payment
company, not the artist's node. The listener's own client keeps a running tally of what it
owes each artist, and when that tally reaches `settleAt` it transfers it from the listener's
wallet to the artist's. The threshold only decides how often a listener approves a payment;
the artist picks it, usually as "every song" or "every few songs".

A client **must send what is owed once it reaches the threshold**, and must send any
unsettled amount within 7 days of the oldest listen in the tally, so a listener who stops
before reaching `settleAt` still pays for what they heard. It should not settle merely because
playback paused or the app closed: that splits the artist's chosen amount into payments of a
cent or two, each costing a network fee. It must settle before it stops tracking an artist
(for example, when the listener removes them), since nothing would remain to send it later.

**Splits.** Collaboration is the normal case in music, so a payment may name several
payees instead of one. Exactly one of `address` or `recipients` is present: `address`
alone means one person gets everything, and `recipients` names each payee explicitly.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | Who this share belongs to. Display only. Max 200 chars. |
| `address` | string | **yes** | Base58 Solana address, 32-44 chars. |
| `split` | number | **yes** | Percent of each payment. Must be > 0. |

```jsonc
"payment": [{
  "type": "solana-usdc",
  "ratePerMinute": 0.01,
  "recipients": [
    { "name": "Hollow Coast", "address": "7xKX…", "split": 60 },
    { "name": "Ada Vance",    "address": "9mPQ…", "split": 40 }
  ]
}]
```

Splits must total 100, within 0.01 to allow for thirds. A client divides each payment
at the moment it sends it and transfers every share in one transaction. The money is
never pooled and never held: there is no account for it to sit in, which is the same
reason Amply cannot take a cut. Max 10 recipients, because a client has to be able to
send them all at once.

A client that cannot send to several addresses at once must **refuse the payment**,
not pay the first recipient and drop the rest.

**`type: "stripe-subscription"`** — a card subscription, sold through the artist's own
Stripe account. A subscriber hears every paid track for the plan's length and is not charged
per minute.

| Field | Type | Required | Notes |
|---|---|---|---|
| `plans` | array | **yes** | 1–3 plans, one per length. |
| `plans[].months` | number | **yes** | `3`, `6` or `12`. |
| `plans[].price` | number | **yes** | In `currency`, `2`–`1000`. |
| `plans[].currency` | string | no | ISO 4217, lower case. Default `usd`. |
| `plans[].url` | URL | **yes** | A Stripe payment link (`https://buy.stripe.com/…`). |

A client opens a plan's `url` with `client_reference_id` set to the listener's wallet
address. That is how the artist's server learns whom a subscription is for: Stripe reports
the completed checkout to it directly, signed with a secret only the server holds. The
manifest carries no key and no secret, and never can — it is public.

The server says whether a wallet is subscribed when it issues a listening token
(`subscribedUntil`, milliseconds since the epoch, or `null`). A client **must not** accrue a
per-minute debt for a wallet the artist's server reports as subscribed. Where
`stripe-subscription` is the only charging entry, the server refuses a token (HTTP 402) to a
wallet that is not subscribed.

It may sit alongside `solana-usdc`: then the listener chooses, and the per-minute entry still
governs anyone who hasn't subscribed.

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
| `colors` | object | no | Colours taken from the cover, for a client to tint itself with: `accent` (a vivid colour to draw with, tuned for a dark screen) and `deep` (a very dark background tone), each `#rrggbb` in lower case. Either may be missing. Made from the cover when it's picked — see `spec/colors.mjs`. |
| `sale` | object | no | The album is for sale to keep. See **Selling** below. |
| `tracks` | array | **yes** | At least one. |

### `releases[].tracks[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Unique within the manifest. Same rules as release `id`. |
| `title` | string | **yes** | 1–300 chars. |
| `duration` | integer | **yes** | Seconds, > 0. Metering depends on it; a client must not have to fetch audio to learn it. |
| `url` | URL | **yes** | HTTPS. The audio file. |
| `waves` | URL | no | HTTPS. How loud each part of the track is, moment by moment, for drawing a waveform. See below. |
| `explicit` | boolean | no | Overrides the artist-level flag for this track. |
| `free` | boolean | no | Default `false`. The artist gives this track away: it is served to anyone, with no wallet. See below. |
| `needsWallet` | boolean | no | Default `false`. Serve this track only to an identified listener even when the artist does not charge. Rarely needed. |
| `sale` | object | no | The song is for sale on its own, to keep. See **Selling** below. |

**Which tracks are paid for.** If an artist charges — a `solana-usdc` payment with a rate, or a `stripe-subscription` with plans
above zero — **every track is paid for, except those marked `free`.** A paid track is
served only to a listener whose client proves which wallet it holds, by signing a challenge
the node issues. A listener with no wallet hears the free tracks and nothing else.

An artist who does not charge gives everything away, and nothing is guarded unless a track
sets `needsWallet`.

The rule lives in one file, `spec/pricing.mjs`, and a client must apply the same one the
server does. If they disagree, a paid track refuses to play, or a free one is charged for.

A client **must not** charge for a track marked `free`, and **should not** play a paid track
from a wallet that has nothing in it to pay with: an empty wallet can identify itself and
then pay nothing, which is the same as having none.

The node cannot check that anyone has paid — it has no way to read the chain — so payment is
matched to listening in the artist's editor, and the artist can stop serving a wallet that
listens without paying. A stopped wallet is refused a new token, and loses the paid tracks
within a token's lifetime, currently thirty minutes.

**Waves.** A client that draws a waveform moving with the music needs to know how loud the
track is at each moment. Working that out on the listener's device would mean downloading
the song twice, so the artist's editor does it once, at upload, and publishes a small file
beside the audio: loudness in eight frequency bands, thirty times a second, one byte each —
about 14 KB a minute. The format is in `spec/waves.mjs`, with code to make and read it. It
holds nothing a waveform doesn't show, so it is served to anyone, even for a paid track. A
track without one plays exactly the same; a client just has less to draw.

**Selling.** An album or a song with a `sale` can be bought to keep, like a record: the file
itself, from the artist's own server, into the listener's app. `sale` is:

| Field | Type | Required | Notes |
|---|---|---|---|
| `price` | number | **yes** | In dollars, from 0.50 to 1000. Fixed. |
| `currency` | string | no | `usd`, the only one for now (USDC is dollars). |
| `url` | URL | no | A Stripe Payment Link for this item, made in the artist's own Stripe by their server. Present when they sell by card. |

It can be paid for by card (when `url` is present) or in USDC to the artist's `solana-usdc`
payment method (when they have one), at the same price either way. The artist's server
confirms the payment itself — with Stripe, or on the chain — records the purchase against
the listener's wallet, and serves the file only to that wallet, signed for, each song of a
purchase at most `DOWNLOADS_PER_PURCHASE` times (five). A purchase can be made as a gift,
which gives the buyer a code for someone else's wallet to claim instead. The shared rules
are in `spec/pricing.mjs`.

A bought song plays free only from the copy the listener keeps; streamed from the artist,
it is paid for as any other. The artist is the seller: their rights to sell, their
collecting society, the buyer's withdrawal right (waived only with express consent before
the download starts) and any VAT are theirs, as `docs/legal.md` item 13 sets out.

**Linking a domain.** Anyone can write any name in a manifest, so the artist's own domain
is how a listener knows who they are paying. The domain's owner adds one DNS record:

    _amply.yourname.com   TXT   "amply=https://yourname.example.workers.dev/manifest.json"

and the manifest names the domain in `artist.domain`. A client shows the domain beside the
artist only when both agree — the record pointing at this manifest, and this manifest naming
that domain — because either alone could be written by anyone. A client may also let a
listener add an artist by typing their domain, resolving the record to find the manifest.

Clients read the record over DNS-over-HTTPS from the listener's own device; no server of
Amply's is involved. The rules are in `spec/domain.mjs`.

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
