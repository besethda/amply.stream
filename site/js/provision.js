/**
 * Creates an artist's node inside their own Cloudflare account.
 *
 * Six ordered steps. Two properties matter more than anything else here:
 *
 *   IDEMPOTENT — every step checks whether its resource already exists before
 *   creating it. Artists refresh mid-flow, double-click buttons, and re-run
 *   setup. None of that may produce a second bucket or a duplicate namespace.
 *
 *   RESUMABLE — progress is persisted after each step, so a failure halfway
 *   through picks up where it stopped instead of starting over. A failed setup
 *   that loses ten minutes of work is how you lose an artist.
 *
 * Amply holds nothing afterwards. The token dies when this finishes; the
 * account, the resources and the music are the artist's.
 */

const PROGRESS_KEY = "amply.provision";
const COMPAT_DATE = "2026-09-01";

export const STEPS = [
  { id: "account", label: "Finding your account" },
  { id: "bucket", label: "Creating storage for your audio" },
  { id: "kv", label: "Creating your track list" },
  { id: "worker", label: "Deploying your player" },
  { id: "subdomain", label: "Giving it a web address" },
  { id: "editor", label: "Installing your editor" },
  { id: "access", label: "Locking the editor to you" },
  { id: "manifest", label: "Publishing your page" },
];

/**
 * The editor steps are soft-failing, but they are not optional.
 *
 * There is no hosted editor to fall back to — Amply is deliberately not
 * involved in an artist editing their own music. What softness buys is that a
 * failure here leaves a working node and a live link rather than wreckage: the
 * artist re-runs setup, every step is idempotent, and it picks up where it
 * stopped. That is a much better failure than a half-built node behind an
 * error screen.
 */
export const OPTIONAL_STEPS = new Set(["editor", "access"]);

/** Raised with a machine-readable `kind` so the UI can offer the right fix. */
export class ProvisionError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); }
  catch { return {}; }
}
function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch {}
}
export function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch {}
}

/**
 * Cloudflare answers 200 with `success: false` for application-level errors, so
 * the HTTP status alone is not enough to tell whether a call worked.
 */
async function api(ctx, method, path, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(`${ctx.relay}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${ctx.token}`, ...headers },
      body,
    });
  } catch (e) {
    throw new ProvisionError("network", "Lost connection to Cloudflare.", e.message);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (res.status === 401 || res.status === 403) {
    throw new ProvisionError("auth", "Cloudflare refused the request.", text.slice(0, 300));
  }
  if (!json) {
    throw new ProvisionError("unexpected", `Unreadable response from Cloudflare (${res.status}).`, text.slice(0, 300));
  }
  if (json.success === false) {
    const err = (json.errors && json.errors[0]) || {};
    // Include the code: Cloudflare's messages are sometimes empty, and the
    // numeric code is often the only thing that identifies the problem.
    const message = err.message
      || (err.code ? `Cloudflare error ${err.code}` : "")
      || `Cloudflare rejected ${method} ${path}`;

    // R2 has to be switched on manually — it is the one step Amply cannot do
    // for the artist, and by far the most likely failure.
    if (/subscription|not enabled|enable r2|sign up/i.test(message)) {
      throw new ProvisionError("r2_disabled", "R2 storage isn't switched on yet.", message);
    }
    if (/already exists|duplicate|taken/i.test(message)) {
      throw new ProvisionError("name_taken", "That name is already in use.", message);
    }
    throw new ProvisionError("cloudflare", message, JSON.stringify(json.errors || []));
  }
  return json.result;
}

/**
 * Which account to build in. An artist with several must choose — picking for
 * them risks creating their music node inside an employer's account.
 */
async function stepAccount(ctx) {
  if (ctx.progress.accountId) return ctx.progress.accountId;

  const accounts = await api(ctx, "GET", "/accounts");
  if (!accounts || accounts.length === 0) {
    throw new ProvisionError("no_account", "No Cloudflare account found on this login.");
  }
  if (accounts.length > 1 && !ctx.chosenAccountId) {
    throw new ProvisionError(
      "choose_account",
      "You have more than one Cloudflare account.",
      JSON.stringify(accounts.map((a) => ({ id: a.id, name: a.name }))),
    );
  }
  const id = ctx.chosenAccountId || accounts[0].id;
  ctx.progress.accountId = id;
  saveProgress(ctx.progress);
  return id;
}

async function stepBucket(ctx) {
  const { accountId, bucketName } = ctx.progress;
  if (ctx.progress.bucketDone) return;

  const existing = await api(ctx, "GET", `/accounts/${accountId}/r2/buckets`);
  const found = (existing?.buckets || []).some((b) => b.name === bucketName);
  if (!found) {
    await api(ctx, "POST", `/accounts/${accountId}/r2/buckets`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: bucketName }),
    });
  }
  ctx.progress.bucketDone = true;
  saveProgress(ctx.progress);
}

async function stepKv(ctx) {
  const { accountId, kvTitle } = ctx.progress;
  if (ctx.progress.kvId) return;

  const existing = await api(ctx, "GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const found = (existing || []).find((n) => n.title === kvTitle);

  const ns = found || await api(ctx, "POST", `/accounts/${accountId}/storage/kv/namespaces`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: kvTitle }),
  });

  ctx.progress.kvId = ns.id;
  saveProgress(ctx.progress);
}

/**
 * Upload the Worker. Bindings are declared in the metadata part, so there is no
 * separate "bind" call — the script arrives already wired to its storage.
 */
async function stepWorker(ctx) {
  const { accountId, workerName, bucketName, kvId } = ctx.progress;
  if (ctx.progress.workerDone) return;

  const source = await fetch(ctx.workerUrl).then((r) => {
    if (!r.ok) throw new ProvisionError("unexpected", "Could not load the player code.");
    return r.text();
  });

  const metadata = {
    main_module: "index.js",
    compatibility_date: COMPAT_DATE,
    bindings: [
      { type: "r2_bucket", name: "MEDIA", bucket_name: bucketName },
      { type: "kv_namespace", name: "MANIFEST", namespace_id: kvId },
    ],
  };

  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set(
    "index.js",
    new Blob([source], { type: "application/javascript+module" }),
    "index.js",
  );

  // No Content-Type header: the browser must set it, with the multipart boundary.
  await api(ctx, "PUT", `/accounts/${accountId}/workers/scripts/${workerName}`, { body: form });

  ctx.progress.workerDone = true;
  saveProgress(ctx.progress);
}

/** Upload the editor into the artist's own bucket, under a non-public prefix. */
async function stepEditor(ctx) {
  const { accountId, bucketName } = ctx.progress;
  if (ctx.progress.editorDone) return;

  const html = await fetch(ctx.editorUrl).then((r) => {
    if (!r.ok) throw new ProvisionError("unexpected", "Could not load the editor.");
    return r.text();
  });

  await api(ctx, "PUT", `/accounts/${accountId}/r2/buckets/${bucketName}/objects/manage/index.html`, {
    headers: { "Content-Type": "text/html" },
    body: html,
  });

  ctx.progress.editorDone = true;
  saveProgress(ctx.progress);
}

/**
 * Put Cloudflare Access in front of /manage, so the editor is private to the
 * artist without any password existing anywhere.
 *
 * Reads before it writes at every stage. These are account-wide objects, and an
 * artist may already use Zero Trust for something entirely unrelated — creating
 * a second organisation or clobbering their setup would be unforgivable.
 */
async function stepAccess(ctx) {
  const { accountId, workerName, url } = ctx.progress;
  if (ctx.progress.accessDone) return;
  if (!ctx.email) throw new ProvisionError("no_email", "An email address is needed to lock the editor.");

  // 1. Zero Trust organisation — reuse the artist's if they have one.
  let org = null;
  try {
    org = await api(ctx, "GET", `/accounts/${accountId}/access/organizations`);
    console.info("[amply] existing Zero Trust org:", org);
  } catch (e) {
    console.info("[amply] no Zero Trust org yet:", e?.message);
    org = null;
  }

  if (!org?.auth_domain) {
    const suffix = Math.random().toString(36).slice(2, 8);
    try {
      org = await api(ctx, "POST", `/accounts/${accountId}/access/organizations`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workerName,
          auth_domain: `${workerName}-${suffix}.cloudflareaccess.com`,
        }),
      });
      console.info("[amply] created Zero Trust org:", org);
    } catch (e) {
      throw new ProvisionError("zt_org", `couldn't create Zero Trust: ${e.message}`, e.detail);
    }
  }

  // 1b. An identity provider, or nobody can sign in at all.
  //
  // A fresh Zero Trust organisation has none, and Access then reports "no login
  // methods available for this account". One-time PIN mails a code to an
  // address the artist already controls: no password, no new account, and no
  // third party added to their trust chain.
  //
  // The relay refuses every other provider type, whatever this code asks for.
  try {
    const idps = await api(ctx, "GET", `/accounts/${accountId}/access/identity_providers`);
    const hasPin = (idps || []).some((i) => i.type === "onetimepin");
    if (!hasPin) {
      await api(ctx, "POST", `/accounts/${accountId}/access/identity_providers`, {
        headers: { "Content-Type": "application/json" },
        // `config` must be present even though one-time PIN needs none.
        // Omitting it gets "unexpected end of JSON input" from Cloudflare —
        // Go's error for unmarshalling an empty byte slice, not a complaint
        // about our request being malformed.
        body: JSON.stringify({ type: "onetimepin", name: "One-time PIN", config: {} }),
      });
      console.info("[amply] created one-time PIN identity provider");
    }
  } catch (e) {
    throw new ProvisionError("zt_idp", `couldn't enable email sign-in: ${e.message}`, e.detail);
  }

  const host = new URL(url).host;
  const appDomain = `${host}/manage`;

  // 2. The application — one per node, matched on its exact domain+path.
  let app = null;
  const existing = await api(ctx, "GET", `/accounts/${accountId}/access/apps`).catch(() => []);
  app = (existing || []).find((a) => a.domain === appDomain) || null;

  if (!app) {
    try {
    app = await api(ctx, "POST", `/accounts/${accountId}/access/apps`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Amply editor — ${workerName}`,
        type: "self_hosted",
        domain: appDomain,
        session_duration: "24h",
        app_launcher_visible: false,
      }),
    });

    // 3. Only this artist's email may sign in.
    await api(ctx, "POST", `/accounts/${accountId}/access/apps/${app.id}/policies`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Artist",
        decision: "allow",
        include: [{ email: { email: ctx.email } }],
      }),
    });
    } catch (e) {
      throw new ProvisionError("zt_app", `couldn't create the Access rule: ${e.message}`, e.detail);
    }
  }
  if (!app?.aud) {
    throw new ProvisionError("zt_aud", "Access application has no audience tag", JSON.stringify(app));
  }

  // 4. Tell the node what to verify against. Without this it refuses every
  //    write — an unverifiable guard is a closed one.
  await api(ctx, "PUT", `/accounts/${accountId}/storage/kv/namespaces/${ctx.progress.kvId}/values/access`, {
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ team: org.auth_domain, aud: app.aud }),
  });

  ctx.progress.editorUrl = `${url}/manage`;
  ctx.progress.accessDone = true;
  saveProgress(ctx.progress);
}

async function stepSubdomain(ctx) {
  const { accountId, workerName } = ctx.progress;
  if (ctx.progress.url) return ctx.progress.url;

  const sub = await api(ctx, "GET", `/accounts/${accountId}/workers/subdomain`);
  if (!sub?.subdomain) {
    throw new ProvisionError(
      "no_subdomain",
      "This account has no workers.dev subdomain yet.",
      "One must be claimed in the Cloudflare dashboard before a Worker can have a public URL.",
    );
  }

  await api(ctx, "POST", `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });

  ctx.progress.url = `https://${workerName}.${sub.subdomain}.workers.dev`;
  saveProgress(ctx.progress);
  return ctx.progress.url;
}

/** A valid, empty manifest, so the node answers correctly from the first second. */
async function stepManifest(ctx) {
  const { accountId, kvId, url } = ctx.progress;
  if (ctx.progress.manifestDone) return;

  const manifest = {
    amply: 1,
    updated: new Date().toISOString(),
    artist: { name: ctx.artistName },
    content: { explicit: false },
    payment: [],
    releases: [],
  };

  await api(ctx, "PUT", `/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/manifest`, {
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(manifest),
  });

  ctx.progress.manifestDone = true;
  saveProgress(ctx.progress);
}

const RUNNERS = {
  account: stepAccount,
  bucket: stepBucket,
  kv: stepKv,
  worker: stepWorker,
  subdomain: stepSubdomain,
  editor: stepEditor,
  access: stepAccess,
  manifest: stepManifest,
};

/**
 * Run the whole sequence. `onStep(id, state, detail)` is called with
 * "running" | "done" for each step so the UI can follow along.
 */
export async function provision({
  token, relay, artistName, slug, email = null, withAccess = true,
  workerUrl = "/node-worker.js",
  editorUrl = "/node-manage",   // Pages serves .html files extensionless
  chosenAccountId = null,
  onStep = () => {},
}) {
  const progress = loadProgress();

  // Names are derived from the slug and stored, so a resumed run reuses exactly
  // the same names rather than creating a second set of resources.
  progress.bucketName ||= `${slug}-media`;
  progress.kvTitle ||= `${slug}-manifest`;
  progress.workerName ||= slug;
  saveProgress(progress);

  const ctx = { token, relay, artistName, email, workerUrl, editorUrl, chosenAccountId, progress };

  for (const step of STEPS) {
    // Asked for but not granted, or no email to attach a policy to: skip
    // cleanly instead of attempting a call that cannot succeed.
    if (OPTIONAL_STEPS.has(step.id) && (!withAccess || !email)) {
      const why = !email ? "no email address given" : "permission not granted";
      onStep(step.id, "skipped", why);
      progress.skipped = [...(progress.skipped || []), { id: step.id, why }];
      saveProgress(progress);
      continue;
    }
    onStep(step.id, "running");
    try {
      await RUNNERS[step.id](ctx);
      onStep(step.id, "done");
    } catch (err) {
      // A failure here must not cost the artist their node. They lose the
      // editor until they re-run setup — a far better outcome than a
      // half-built node behind an error screen.
      if (OPTIONAL_STEPS.has(step.id)) {
        // A silent skip is useless — it says something went wrong and nothing
        // about what. Squeeze a description out of whatever was thrown.
        const why =
          [err?.message, err?.detail].filter(Boolean).join(" · ") ||
          err?.kind ||
          (typeof err === "string" ? err : "") ||
          `unexpected ${err?.name || typeof err}`;
        console.error(`[amply] step "${step.id}" failed:`, err);
        onStep(step.id, "skipped", why);
        // Keep the reason, not just the fact. The progress view is gone within
        // a second of finishing; the reason has to survive to the last screen.
        ctx.progress.skipped = [...(ctx.progress.skipped || []), { id: step.id, why }];
        saveProgress(ctx.progress);
        continue;
      }
      throw err;
    }
  }

  return {
    url: progress.url,
    accountId: progress.accountId,
    editorUrl: progress.accessDone ? progress.editorUrl : null,
    skipped: progress.skipped || [],
  };
}

/** Cloudflare names: lowercase, alphanumeric and hyphens, no leading digit. */
export function toSlug(name) {
  const s = (name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[0-9]/.test(s) ? `a-${s}` : (s || "amply-node");
}
