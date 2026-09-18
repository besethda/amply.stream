# Building

```
npm run build        # every artifact the site serves
npm run check        # build, validate the spec, typecheck both Workers
npm run deploy:site  # build, then publish site/ to Cloudflare Pages
npm run deploy:relay # publish the CORS relay
```

## Why one command

Three of the files in `site/` are **compiled from source elsewhere in this repo**, and
nothing about them looks generated:

| Served file | Built from |
|---|---|
| `site/node-worker.js` | `node/src/` — the Worker uploaded into artists' accounts |
| `site/node-manage.html` | `manage/src/` — the editor uploaded into artists' buckets |
| `site/js/manage.js` | `manage/src/` — the hosted fallback editor |

Deploying `site/` without rebuilding ships whatever was there last time. That already
nearly happened once: the node Worker gained its entire `/manage` write surface, and the
stale bundle in `site/` would have provisioned artists with the old read-only build — a
self-hosted editor that could not save anything, in accounts we cannot reach afterwards.

**Use `npm run deploy:site`,** which builds first. Running `wrangler pages deploy` directly
is the failure mode.

The deploy scripts call `wrangler` from `node/node_modules/.bin`. npm only puts the *local*
`node_modules/.bin` on `PATH`, and this root has no `node_modules` — so `wrangler` alone is
not found here. The build already depends on that tree for esbuild, so this adds no new
requirement and avoids a duplicate ~100 MB install at the root.

## Checking a node

```
npm run test:node https://<slug>.<subdomain>.workers.dev
```

16 checks: manifest, CORS, range requests and seeking, conditional requests, and the
rejection paths. Runs against any node, including an artist's.
