# Roadmap

Amply already works: artists can set up a node, publish music, and be paid by
card (Stripe) or in USDC. What stands between it and real use is friction, for
artists setting up and for listeners paying. Everything below is about removing
as much of that as possible, without giving up what Amply is: no company in
the middle, nothing stored, no cut.

Nothing here is promised. It's the direction, roughly in order.

## Listeners: paying without thinking about crypto

- **Adding money: three plain choices, fees shown upfront.** One calm screen.
  Each option says who handles the money and that Amply never sees bank or
  card details:
  - **Coinbase (the main route).** Coinbase's onramp fills in the wallet,
    USDC on Solana and the amount; returning fans are already signed in, so a
    top-up is one tap and a confirm. Fees: about 0.5% by bank (ACH), 2.5% by
    card, nothing extra from an existing Coinbase balance. Needs a free
    Coinbase developer account and its onramp access form, and the relay
    holds that one API key to mint five-minute sessions (origin check plus a
    wallet signature, no storage). Open questions: trial-mode limits, and
    whether full access needs a registered business. Fans need a Coinbase
    account: guest checkout ended on 30 June 2026.
  - **PayPal (US).** Buying PYUSD in PayPal or Venmo is free, and sending it
    to the Amply wallet in a separate step costs only the network fee. Needs
    the app to accept PYUSD or convert it to USDC on arrival.
  - **Card (almost everywhere).** Ramp's own site, where fans paste the
    address. Up to 3.9% with a minimum of up to €2.49, so default top-ups are
    $30 or more, and the app says "about $2.50 goes to card fees" before they
    pay. Stripe's onramp is not an option in the EU: it doesn't sell USDC on
    Solana there.
  - Show the exact amount that arrived afterwards ("$29.85 arrived").
  - Remember the fan's route and remind them before the balance runs out, so
    the confusing part happens once.
  - Any referral fee from a provider is declined or disclosed. Amply takes 0%.
- **No SOL for listeners.** *Built:* the artist's node pays the network fee
  on each payment as fee payer (about $0.001), after checking the transaction
  only pays this artist's split (node/src/feepay.ts, settle.ts). The artist
  adds a few dollars of SOL to the fee wallet once, from the Earnings tab.
  Still to do: fund the fee wallet through Coinbase's onramp in one tap.
- **A wallet that can't be lost.** Make the wallet from a passkey (WebAuthn
  PRF): the same passkey on any synced device recreates the same wallet, with
  no recovery words and nothing stored by anyone. Falls back to a backup code
  where PRF isn't supported (Firefox on Android; Windows Hello unclear).
  Prove it first on a one-page test across iPhone, Android, Mac and Windows.
- **Free first, pay later.** A new listener hears an artist's free tracks with
  no wallet at all, and is asked to set one up only when they reach a paid one.
- **No surprise bills.** Show each listener an estimated monthly cost from
  their own listening, alongside the daily limit that already exists.
- **Card-only paths stay first-class.** Subscriptions and purchases through
  the artist's Stripe let a listener support an artist without a wallet at all.

## Pricing

- **A lower suggested rate.** Done: new artists start at $0.005 a minute, with the
  comparison shown beside the price. Originally: suggest $0.003–0.005 a minute in the editor,
  with the comparison shown next to the field: at $0.005, a 3.5-minute play
  earns about $0.0175, roughly 3.5–6× a Spotify stream, and a fan who listens
  20 minutes a day pays that artist about $3 a month.
- **Bundles that fit fans.** Free singles, per-minute streaming, a yearly
  subscription and albums to keep, all on one artist's node.

## Artists: setting up in minutes

- **A live page before signing up, with no card.** Cloudflare can create a
  temporary account before anyone has one. `scripts/prove-temporary-account.mjs`
  proved it end to end: no key of Amply's is needed, the proof-of-work takes
  about a second, a node with KV and D1 deploys and serves, everything survives
  the claim, and the setup token is refused (401) afterwards. The new setup:
  1. The artist enters their name and accepts Cloudflare's terms themselves.
  2. Their browser creates the temporary account through the relay (the API
     has no CORS) and solves the proof-of-work. The token stays in the
     browser, as the OAuth token does today.
  3. Setup deploys the node with audio in **KV**, not R2 (temporary accounts
     can't use R2), and uploads a first song and artwork.
  4. The artist sees their page live, then claims it: sign up or in with
     Google or Apple, within the hour. Unclaimed setups delete themselves.
  5. "Finish setup" runs the existing one-time OAuth flow to switch on the
     editor lock (Access). Until then the node is read-only, as it already is
     without Access.
  6. R2 stays optional, for artists who outgrow KV's free 1 GB. Most never
     need to add a card.

  Work: KV storage in the node (started), two relay routes
  (`/provisioning/previews/challenge`, `/provisioning/previews`) with their
  bodies inspected, the new setup screens, and README updates so the claims
  table covers the new flow.
- **One-click Stripe.** Waiting on Stripe's review of the Amply for Artists
  app. Until then the editor shows the manual restricted-key steps.
- **Timed first-run tests.** Watch musicians who have never used Cloudflare
  set up a node, and fix wherever they get stuck. Target: under 15 minutes.
- **Plain-language guides** for the parts that feel risky: what access setup
  asks for and why, and tax and VAT basics for selling music.

## Getting paid without chores

- **Get paid with Face ID.** The editor makes the artist's wallet from a
  passkey on the node's own address: no wallet app, no address to paste. A
  Phantom address stays possible for artists who want it.
- **Cash out in one step.** Coinbase's offramp from the editor: the artist
  picks an amount, the editor reads Coinbase's deposit address and signs the
  transfer with their passkey, and Coinbase pays out to a bank (ACH in the
  US, PayPal in some countries) or their Coinbase balance. Elsewhere, guide
  them through an exchange with low fees (for example Bitvavo in the EU).
- **Automatic stopping of non-payers.** With the node as fee payer (now
  built), it signs every payment to its artist and could record it, so it knows exactly who has
  paid without reading the chain, and refuses a listening token to a wallet
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
