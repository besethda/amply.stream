# Roadmap

Amply already works: artists can set up a node, publish music, and be paid by
card (Stripe) or in USDC. What stands between it and real use is friction, for
artists setting up and for listeners paying. Everything below is about removing
as much of that as possible, without giving up what Amply is: no company in
the middle, nothing stored, no cut.

Nothing here is promised. It's the direction, roughly in order.

## Listeners: paying without thinking about crypto

- **Buying dollars in the app, through an on-ramp.** A listener pays by card
  and the USDC arrives in the wallet the app already made. Framed as a top-up
  ("add $20, it lasts months"), not as buying crypto.
  - It has to buy a little SOL too, or the first payment fails on the network
    fee.
  - It must not make Amply hold a secret or keep any state. Many ramps require
    server-side signing; prefer one that doesn't.
  - Before building it: re-check the MiCA reasoning that currently rules out
    buying crypto inside the app (see `app/src/wallet.js`). Linking out to a
    separately regulated ramp may be fine; building one in may not be.
  - Any referral fee from the provider is declined or disclosed. Amply takes 0%.
- **A wallet that can't be lost.** Today it lives in browser storage, and
  deleting the home-screen icon deletes it. In the native apps, keep the key in
  the iOS Keychain (with iCloud Keychain sync) and the Android Keystore (with
  Block Store backup), behind Face ID or a fingerprint for anything unusual.
- **Free first, pay later.** A new listener hears an artist's free tracks with
  no wallet at all, and is asked to set one up only when they reach a paid one.
- **No surprise bills.** Show each listener an estimated monthly cost from
  their own listening, alongside the daily limit that already exists.
- **Card-only paths stay first-class.** Subscriptions and purchases through
  the artist's Stripe let a listener support an artist without a wallet at all.

## Pricing

- **A lower suggested rate.** Suggest $0.003–0.005 a minute in the editor,
  with the comparison shown next to the field: at $0.005, a 3.5-minute play
  earns about $0.0175, roughly 3.5–6× a Spotify stream, and a fan who listens
  20 minutes a day pays that artist about $3 a month.
- **Bundles that fit fans.** Free singles, per-minute streaming, a yearly
  subscription and albums to keep, all on one artist's node.

## Artists: setting up in minutes

- **One-click Stripe.** Waiting on Stripe's review of the Amply for Artists
  app. Until then the editor shows the manual restricted-key steps.
- **Timed first-run tests.** Watch musicians who have never used Cloudflare
  set up a node, and fix wherever they get stuck. Target: under 15 minutes.
- **Plain-language guides** for the parts that feel risky: what access setup
  asks for and why, and tax and VAT basics for selling music.

## Getting paid without chores

- **Automatic stopping of non-payers.** The app sends the node a receipt
  (transaction signature) each time it settles; the node checks it on-chain
  with the existing `verifyPayment` and refuses a listening token to a wallet
  that owes more than its `settleAt` past the 7-day window and a grace period.
  The artist no longer has to check Earnings by hand. Generous by default:
  blocking an honest fan is worse than a freeloader listening a few days more.
- **An artist's own RPC key** as a fallback, so payment checks don't depend on
  one free public endpoint.

## Bringing fans in

There is no directory and there won't be one run by Amply. Fans arrive because
an artist sent them, so the tools are for artists:

- **A printable QR poster** from the editor, for gigs, merch tables and
  sleeves. The listener app can already scan one.
- **An embeddable player** for an artist's own website and link page.
- **"Artists I like"** in the manifest, so one artist's fans can find the next.
- **Opt-in directories run by others**: a published format for lists of
  manifests, so a label, venue or scene can curate its own.

## Apps

- **Native shells (Capacitor) for iOS and Android**, keeping one codebase. This
  gives the secure wallet storage above, plus reliable background and
  lock-screen playback.
- **Android first:** direct APK and F-Droid, then Google Play after checking
  its payments policy.
- **iOS in the EU** through an alternative marketplace (such as AltStore PAL);
  the web app everywhere else.

## Beyond Cloudflare

- **A Docker image of the node**, so the same spec runs on a home server or a
  VPS. `npm run test:node` already checks any implementation against the spec.
- **The manifest as a standard.** Other players and servers that speak it are
  the goal, not a threat.

## The project

- First artists from one scene, then a grant application (NLnet / NGI Zero).
- A small group of artist testers who see changes first and help choose what
  gets built.
