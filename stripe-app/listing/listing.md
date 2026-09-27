# Amply for Artists: Stripe App Marketplace listing

The text for the listing form, field by field, within Stripe's limits
(https://docs.stripe.com/stripe-apps/publish-app#write-your-listing).
Character counts in brackets.

## Name (35 max)

Amply for Artists  [17]

Must match `stripe-app.json`. Stripe forbids "Stripe", "app", "free", "paid",
"RAK", "Generator", "API Key" and "Authenticator" in it.

## Icon

`stripe-app/icon.png`: the same file as the manifest's icon, as Stripe requires.

## Built by (80 max)

Seth Armistead  [14]

(The individual who builds and maintains it. Amply isn't a company.)

## Category

Billing (or the closest to subscriptions that the form offers).

## Subtitle (80 max)

Sell fan subscriptions to your music through your own Stripe account.  [69]

## About (1000 max)

Amply is free, open-source software that lets musicians stream their music
from a server they own, and be paid directly by their fans, with nothing
taken in between. Amply for Artists connects Stripe to an artist's Amply
streaming service in one step. Installing it creates a restricted key with
only the six permissions subscriptions need; the artist pastes that key into
their Amply editor, which then sets up their plans, checkout links and
customer portal in their own Stripe account. Fans subscribe on Stripe's
checkout, and every payment goes straight to the artist's account. The key
stays on the artist's own server: Amply never receives it, and can't move
money, see card numbers or pay anything out.  [~690]

## Works with

Settings (filled in from the manifest).

## Key features (3; title 80 max, description 300 max, image min 1600 px wide)

### 1. Connect Stripe to your music in one step  [44]

Installing creates a key limited to the six permissions subscriptions need,
with no permissions to choose by hand. Copy it into your Amply editor and
choose Connect Stripe: your plans, checkout links and customer portal are set
up in your own account.  [~250]

Image: the app's settings page in the Stripe Dashboard (sandbox screenshot).

### 2. Sell subscriptions at your own price  [37]

Offer plans every 3, 6 or 12 months at the amounts you choose. Each plan gets
a Stripe Payment Link, so fans pay on Stripe's own checkout page and the money
goes straight to your account. Change a price whenever you like.  [~230]

Image: Stripe's Payment Links page showing the plans Amply created (sandbox).

### 3. Fans manage their own subscriptions  [36]

Fans cancel or change their card themselves on Stripe's customer portal,
without having to contact you. Amply checks each subscription when it's due
to renew and once a day, so someone who cancels stops getting paid music.  [~230]

Image: the customer portal, or the Subscriptions list (sandbox).

## Pricing

Free. No fees from Amply; Stripe's usual processing fees apply to the
artist's own payments.

## Support channel

support@amply.stream, replies within 2 business days.

## Based in

(Your country.)

## Supported languages

English.

## Links

- Privacy policy: https://amply.stream/privacy
- Terms of service: https://amply.stream/terms
- Company website: https://amply.stream
- Technical documentation: https://amply.stream/stripe
- FAQ: https://amply.stream/why

## Testing guidance

Amply for Artists does one thing: it creates a restricted key that an
artist's Amply streaming service uses to set up and check subscriptions.

1. Install Amply for Artists in a sandbox.
2. Open it: the settings page explains the three steps. Click View API keys
   and copy the restricted key (it starts rk_test_).
3. Open the demo editor at [DEMO EDITOR URL] and sign in with your
   @stripe.com email address: a one-time code is sent to it.
4. Go to Settings → Subscriptions, paste the key, keep the suggested plans,
   and choose Connect Stripe.
5. In the sandbox Dashboard, see what was created: one product ("Demo artist
   — subscription"), a price and a Payment Link for each plan, and a
   customer portal configuration.
6. To see a fan's side, open [DEMO LISTENER LINK], tap the demo artist, and
   choose a plan. Pay with test card 4242 4242 4242 4242, any future date, any
   CVC. After checkout, the listening app shows the subscription as active.
7. Back in the editor, choose Disconnect: the Payment Links are switched off.

## Test credentials

No password is needed: the demo editor accepts any @stripe.com email address
and sends it a one-time code. No two-step verification beyond that.
