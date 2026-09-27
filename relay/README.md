# Amply relay

A stateless CORS relay. It forwards requests to Cloudflare's API and adds the headers a
browser needs. That is the entire program.

## Why it exists

Amply's deploy site provisions storage and a Worker inside the **artist's own** Cloudflare
account. That has to happen from the browser, because Amply has no backend to do it from.

But `api.cloudflare.com` sends no CORS headers and does not answer `OPTIONS`, so a browser
cannot call it. Verified by direct test — this is not an assumption.

The alternatives are worse. Asking artists to paste an API token hands over unlimited,
permanent access and trains people to do a dangerous thing. Routing through Cloudflare's
Deploy button requires a GitHub account, which musicians do not have. So: forty lines that
forward a request.

## What it must never become

**No storage bindings.** No KV, no R2, no D1, no Durable Objects. Deliberate and
load-bearing: there is nothing here to exfiltrate even if the code is wrong. Do not add one.

**No logging.** `observability` is off. An artist's access token passes through this Worker
in memory for one request and is never written anywhere.

**No standing access.** Amply never requests `offline_access` and never accepts a refresh
token. The relay enforces this independently of the call site — it rejects a
`refresh_token` grant, rejects an `offline_access` scope, and strips `refresh_token` from a
response if Cloudflare ever returns one unasked.

That last rule is what keeps this from being the relationship `docs/legal.md` §1 exists to
prevent. Access lasts for the seconds of one provisioning flow and is then gone forever.

## Routes

| Route | Purpose |
|---|---|
| `POST /token` | OAuth token exchange, forwarded to `dash.cloudflare.com/oauth2/token` |
| `POST /revoke` | Kill the token the moment provisioning finishes |
| `/api/*` | Forwarded to `api.cloudflare.com/client/v4/*`, allowlisted |

The `/api/*` allowlist is exact — method plus a path regex, with account and resource IDs
pattern-matched. An open proxy to the Cloudflare API would be a genuinely dangerous thing to
leave running on the internet.

Currently permitted: list accounts; create and list R2 buckets, and put, read and delete
objects in them; create and list D1 databases and run queries in them; upload and read a
Worker script; read or claim the account's `workers.dev` subdomain and enable it for a
script; attach a Worker to a hostname; and read and create the Zero Trust organisation,
one-time PIN sign-in, Access application and its policies. The full list is `ALLOWED` in
`src/index.ts`. Nothing else.

## Origins

Set `ALLOWED_ORIGINS` in `wrangler.jsonc`. Requests with no `Origin`, or an origin not on
the list, get a 403 before anything else happens.

## Verifying it

```
npm run typecheck
npm run deploy
```

Then, against the deployed URL, confirm: no origin is refused, a wrong origin is refused, a
good origin gets its `Access-Control-Allow-Origin` back, a missing token is refused, a path
off the allowlist is refused, a `DELETE` is refused, and both `refresh_token` and
`offline_access` are rejected at `/token`.

Every one of those is a security property rather than a feature, so re-check them after any
change.
