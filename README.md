# Amply

Artists host their own music, set their own prices, and are paid directly by the people who
listen. There is no company in the middle — and nothing to sell, acquire, or shut down.

**Amply takes 0%.** Not a reduced rate: there is no mechanism by which it could take
anything.

---

## How it works

An artist connects their **own** Cloudflare account at [amply.stream](https://amply.stream).
Setup creates storage, a small Worker, a public address and an editor — all inside their
account, in their name, that they log into.

Their node then serves everything a listener ever sees: the page, the artwork, the audio.
It publishes a **manifest** — a JSON file listing tracks, prices and a payment destination.
Think RSS, for music.

Listeners follow an artist by adding that link. There is no directory, no search and no
algorithm, because deciding who gets seen is the thing this exists to avoid.

## What Amply does not do

These are properties of the architecture, not promises:

- **Hosts no audio.** It is on infrastructure the artist owns and pays for.
- **Operates no editor.** Artists manage their music on their own node, behind Cloudflare
  Access, signing in with a code emailed to them. There is no hosted copy.
- **Keeps no credential.** Setup never requests `offline_access` and never accepts a refresh
  token. Access to an artist's account lasts for one flow and is then gone for good.
- **Stores nothing.** No accounts, no database, no analytics, no record that an artist
  exists. Nodes are found by listing an account, not by looking anyone up.
- **Takes no cut.** Payments go from listener to artist. Amply is not in the transaction.

## Verifying those claims

They are only worth something if you can check them, so here is where to look:

| Claim | Where |
|---|---|
| No standing access to artist accounts | [`site/js/pkce.js`](site/js/pkce.js) — and enforced again in the relay |
| Nothing is stored or logged | [`relay/src/index.ts`](relay/src/index.ts) — no storage bindings at all, `observability` off |
| The relay cannot be used as a general proxy | Same file — an exact method-and-path allowlist |
| Only a one-time PIN provider can be created | Same file — the request body is inspected, not just the path |
| The node has no write path without Access | [`node/src/index.ts`](node/src/index.ts) — and it fails closed with no configuration |
| Sign-in cannot be forged | [`node/src/access.ts`](node/src/access.ts) — the assertion is verified in the Worker, not assumed from the edge |

## Layout

```
spec/     the manifest specification, a reference file, and a validator
node/     the Worker an artist runs in their own Cloudflare account
manage/   the editor, served from the artist's own node
relay/    a stateless CORS relay, used only during setup
site/     the deploy flow
```

## Building

```
npm run build        # every artifact the site serves
npm run check        # build, validate the spec, typecheck both Workers
npm run test:node <url>   # 16 conformance checks against any node
```

Three files in `site/` are compiled from elsewhere in the repo — see [BUILD.md](BUILD.md).
Deploying without building ships stale copies, including, once, a Worker that would have
left artists with an editor that could not save.

## For artists

**Use only music you own outright.** No covers, no uncleared samples. Two separate
questions matter and both must be yes: do you own the recording, and are you free to
distribute it yourself? An exclusive distribution deal can prevent self-hosting a recording
you fully own.

Your music lives on your infrastructure, so takedown notices come to you — not to Amply,
which has no copy and no ability to remove anything.

## Licence

[Apache 2.0](LICENSE). The name and logo are **not** licensed with the code — see
[NOTICE](NOTICE).
