/**
 * Creates an artist's streaming service inside their own Cloudflare account.
 *
 * The steps in STEPS, in order. Two properties matter more than anything else:
 *
 *   IDEMPOTENT — every step checks whether its resource already exists before
 *   creating it. Artists refresh mid-flow, double-click buttons, and re-run
 *   setup. None of that may produce a second bucket or a duplicate database.
 *
 *   RESUMABLE — progress is persisted after each step, so a failure halfway
 *   through picks up where it stopped instead of starting over. A failed setup
 *   that loses ten minutes of work is how you lose an artist.
 *
 * Amply holds nothing afterwards. The token dies when this finishes; the
 * account, the resources and the music are the artist's.
 */

const PROGRESS_KEY = "amply.provision";

/** Where the highest applied schema change is recorded, in the artist's own
 *  settings table. Matches SCHEMA_VERSION in node/src/store.ts. */
const SCHEMA_VERSION = "schema-version";
const COMPAT_DATE = "2026-09-01";

export const STEPS = [
  { id: "account", label: "Finding your account" },
  { id: "bucket", label: "Creating storage for your audio" },
  { id: "database", label: "Creating your track list" },
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

/**
 * Rebuilding an artist's node.
 *
 * The same steps, with one left out. Every step here already reads before it
 * writes, so running them again finds what exists and replaces only the code:
 * the Worker and the editor. Audio, artwork, the track list and the sign-in
 * settings are never touched.
 *
 * `manifest` is excluded rather than made idempotent. It writes a starter page,
 * and a starter page written over somebody's actual music would be the worst
 * thing this repo could do.
 */
export const REPAIR_STEPS = STEPS.filter((s) => s.id !== "manifest");

/**
 * Raised with a machine-readable `kind` so the UI can offer the right fix.
 *
 * `fatal` marks the few failures that must stop everything even inside a step
 * that is otherwise allowed to fail softly. Soft failure is right when the
 * artist loses something they can come back for; it is wrong when carrying on
 * produces a service that cannot work and the fix is a manual one, because
 * then the reason scrolls past on a summary screen and they simply run it
 * again.
 */
export class ProvisionError extends Error {
  constructor(kind, message, detail, { fatal = false } = {}) {
    super(message);
    this.kind = kind;
    this.detail = detail;
    this.fatal = fatal;
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

    // A fresh account has to switch some services on in the dashboard before
    // the API will use them, and no permission Amply can ask for does it. Which
    // service is decided by the request, not by the wording of the message: the
    // wording is generic, and matching on it alone can send an artist to switch
    // on a service they already have.
    if (/subscription|not enabled|enable|sign up|entitle/i.test(message)) {
      if (path.includes("/d1/")) {
        throw new ProvisionError("d1_disabled", "D1 isn't switched on yet.", message);
      }
      if (path.includes("/r2/")) {
        throw new ProvisionError("r2_disabled", "R2 storage isn't switched on yet.", message);
      }
    }
    // Cloudflare says this one plainly, from whichever call hits it first:
    // uploading the Worker fails before the subdomain step is even reached.
    if (/workers\.dev subdomain/i.test(message)) {
      throw new ProvisionError("no_subdomain", "This account has no workers.dev address yet.", message);
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

/**
 * The artist's database.
 *
 * Holds the track list, the sign-in settings and a tally per listener. D1
 * rather than KV because KV allows a thousand writes a day on the free plan,
 * and counting listening would spend that in an evening.
 *
 * Found rather than created when it already exists, so a rebuild keeps the
 * artist's music and their listeners.
 */
async function stepDatabase(ctx) {
  const { accountId, dbName } = ctx.progress;
  if (ctx.progress.dbId) return;

  let db;
  try {
    const existing = await api(ctx, "GET", `/accounts/${accountId}/d1/database?per_page=100`);
    db = (existing || []).find((d) => d.name === dbName);

    if (!db) {
      db = await api(ctx, "POST", `/accounts/${accountId}/d1/database`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: dbName }),
      });
    }
  } catch (e) {
    // A brand-new account may refuse until its dashboard page has been opened
    // once, as R2 and KV both did. Any Cloudflare-side refusal gets the fix
    // that is known to work for those.
    if (e instanceof ProvisionError && e.kind === "cloudflare") {
      throw new ProvisionError("d1_disabled", "D1 isn't switched on yet.", e.detail || e.message);
    }
    throw e;
  }

  ctx.progress.dbId = db.uuid || db.id;
  saveProgress(ctx.progress);

  // Every statement says IF NOT EXISTS, so running them again on a rebuild
  // leaves the artist's rows exactly as they were.
  const { schema, migrations = [] } = await fetch(ctx.versionUrl).then((r) => r.json());
  for (const sql of schema) {
    await api(ctx, "POST", `/accounts/${accountId}/d1/database/${ctx.progress.dbId}/query`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
  }

  await migrate(ctx, migrations);
}

/**
 * Apply changes to tables that already exist.
 *
 * Creating a table is idempotent and altering one is not, so a rebuild cannot
 * simply run everything again. Each change carries an id, the highest applied
 * id lives in the artist's own settings table, and only what is newer runs.
 *
 * Deliberately not clever. No rollback, no checksums: the alternative to a
 * simple mechanism here is a subtle one running unattended inside somebody
 * else's account, where nobody can go and look at what happened.
 */
async function migrate(ctx, migrations) {
  if (!migrations.length) return;

  const answer = await query(ctx, "SELECT value FROM settings WHERE key = ?", [SCHEMA_VERSION]);
  const stored = Number(answer?.[0]?.results?.[0]?.value);
  const applied = Number.isFinite(stored) ? stored : 0;

  const due = migrations.filter((m) => m.id > applied).sort((a, b) => a.id - b.id);
  if (!due.length) return;

  for (const step of due) {
    try {
      await query(ctx, step.sql);
    } catch (e) {
      // Stop at the first failure and record only what did work. Carrying on
      // would apply a later change to a table that never received an earlier
      // one, which is how a database ends up in a state nobody has a name for.
      await putSetting(ctx, SCHEMA_VERSION, String(step.id - 1));
      throw new ProvisionError(
        "migration",
        "Your database could not be brought up to date.",
        `Change ${step.id} failed: ${e.message}`,
      );
    }
  }

  await putSetting(ctx, SCHEMA_VERSION, String(due[due.length - 1].id));
}

/** Run one statement against the artist's database. */
async function query(ctx, sql, params = []) {
  const { accountId, dbId } = ctx.progress;
  return api(ctx, "POST", `/accounts/${accountId}/d1/database/${dbId}/query`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
}

/**
 * Upload the Worker. Bindings are declared in the metadata part, so there is no
 * separate "bind" call — the script arrives already wired to its storage.
 */
async function stepWorker(ctx) {
  const { accountId, workerName, bucketName, dbId } = ctx.progress;
  if (ctx.progress.workerDone) return;

  // Cloudflare rejects the upload itself when the account has no workers.dev
  // name, so claim one first rather than fail here and explain two steps later.
  await ensureSubdomain(ctx, accountId, workerName).catch(() => null);

  const source = await fetch(ctx.workerUrl).then((r) => {
    if (!r.ok) throw new ProvisionError("unexpected", "Could not load the player code.");
    return r.text();
  });

  const base = [
    { type: "r2_bucket", name: "MEDIA", bucket_name: bucketName },
    { type: "d1", name: "DB", id: dbId },
  ];
  // Cloudflare's rate limiters, so nobody can run the service into the
  // ground (node/src/limits.ts). Numbers from the version file, which takes
  // them from the Worker's own source.
  const { limits = [] } = await fetch(ctx.versionUrl).then((r) => r.json()).catch(() => ({}));
  const limiters = limits.map((l) => ({
    type: "ratelimit", name: l.binding, namespace_id: l.namespace, simple: { limit: l.limit, period: l.period },
  }));
  const upload = (bindings) => {
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: COMPAT_DATE, bindings })], { type: "application/json" }));
    form.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    // No Content-Type header: the browser must set it, with the multipart boundary.
    return api(ctx, "PUT", `/accounts/${accountId}/workers/scripts/${workerName}`, { body: form });
  };
  try {
    await upload([...base, ...limiters]);
  } catch (e) {
    // An account that won't take the limiters still gets its service: the
    // Worker counts in memory instead. Anything else fails as it always did.
    if (!limiters.length) throw e;
    await upload(base);
  }

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
  } catch {
    org = null;   // none yet
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
  const existingApp = app !== null;

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

  // An application we found rather than made is one we have not checked.
  //
  // Setup adopts an existing app for this exact address, which is what makes a
  // rebuild safe to run twice. But adopting it means inheriting whoever it lets
  // in, and an app left behind by another tool — or one somebody was talked
  // into creating — could let in anybody at all.
  //
  // Only one of the things that can be wrong here is dangerous, and treating
  // them all as fatal is worse than the problem: this step fails softly, so a
  // throw means the access setting below never gets written, and the artist is
  // locked out of their editor by a check meant to protect them.
  //
  //   admits everyone   — dangerous. Anyone could sign in and take the
  //                       account over. Stop, and say how to fix it.
  //   admits nobody     — a lockout, not a risk. Add a rule for the artist.
  //   cannot be read    — unknown, and not evidence of anything. Carry on; the
  //                       node verifies the token's audience regardless.
  if (existingApp) {
    const policies = await api(ctx, "GET", `/accounts/${accountId}/access/apps/${app.id}/policies`)
      .catch(() => null);

    const admits = (rule) => (rule.decision === "allow" ? rule.include || [] : []);
    const rules = (policies || []).flatMap(admits);

    if (rules.some((r) => "everyone" in r || "certificate" in r || "any_valid_service_token" in r)) {
      throw new ProvisionError(
        "zt_policy_open",
        "The sign-in rule protecting your editor lets anyone in.",
        "There is already an Access application for this address that admits everybody. Delete it in Zero Trust → Access → Applications and run this again, and Amply will make one that admits only you.",
        { fatal: true },
      );
    }

    // Nothing admits this artist: add a rule rather than refusing, which is
    // the same thing setup does for an application it creates.
    const mine = rules.some((r) => r.email?.email?.toLowerCase() === ctx.email.toLowerCase());
    if (policies && !mine) {
      await api(ctx, "POST", `/accounts/${accountId}/access/apps/${app.id}/policies`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Artist",
          decision: "allow",
          include: [{ email: { email: ctx.email } }],
        }),
      });
    }
  }

  // 4. Tell the node what to verify against. Without this it refuses every
  //    write — an unverifiable guard is a closed one.
  await putSetting(ctx, "access", JSON.stringify({ team: org.auth_domain, aud: app.aud }));

  ctx.progress.editorUrl = `${url}/manage`;
  ctx.progress.accessDone = true;
  saveProgress(ctx.progress);
}

/**
 * Claim a workers.dev name for the account.
 *
 * These are global across Cloudflare, so the artist's own slug is usually free
 * but not always; taken names get a suffix rather than an error. It is claimed
 * once and permanently, and it becomes part of every address the artist shares,
 * which is why it is their name and not something generated.
 */
async function claimSubdomain(ctx, accountId, slug) {
  const tries = [slug, `${slug}-music`, `${slug}-${Math.random().toString(36).slice(2, 6)}`];
  for (const name of tries) {
    try {
      const res = await api(ctx, "PUT", `/accounts/${accountId}/workers/subdomain`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: name }),
      });
      return res?.subdomain || name;
    } catch (e) {
      // Taken: try the next candidate. Anything else (no permission, service
      // off) means claiming is not going to work at all, so stop and let the
      // caller fall back to asking the artist to do it.
      if (!(e instanceof ProvisionError) || e.kind !== "name_taken") return null;
    }
  }
  return null;
}

/**
 * The account's workers.dev name, claiming one if there is none.
 *
 * Wanted before the Worker is uploaded, not only when its URL is built:
 * Cloudflare refuses the upload itself on an account that has no name yet,
 * which is a step earlier than it sounds.
 */
async function ensureSubdomain(ctx, accountId, slug) {
  if (ctx.progress.subdomain) return ctx.progress.subdomain;

  const sub = await api(ctx, "GET", `/accounts/${accountId}/workers/subdomain`);
  const name = sub?.subdomain || await claimSubdomain(ctx, accountId, slug);
  if (name) {
    ctx.progress.subdomain = name;
    saveProgress(ctx.progress);
  }
  return name;
}

async function stepSubdomain(ctx) {
  const { accountId, workerName } = ctx.progress;
  if (ctx.progress.url) return ctx.progress.url;

  const name = await ensureSubdomain(ctx, accountId, workerName);
  if (!name) {
    throw new ProvisionError(
      "no_subdomain",
      "This account has no workers.dev address yet.",
      "Amply could not claim one either. Opening the Workers page in Cloudflare usually offers you one.",
    );
  }
  await api(ctx, "POST", `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });

  ctx.progress.url = `https://${workerName}.${name}.workers.dev`;
  saveProgress(ctx.progress);
  return ctx.progress.url;
}

/** Write one of the node's settings into the artist's database. */
async function putSetting(ctx, key, value) {
  await query(
    ctx,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/** A valid, empty manifest, so the node answers correctly from the first second. */
async function stepManifest(ctx) {
  if (ctx.progress.manifestDone) return;

  const manifest = {
    amply: 1,
    updated: new Date().toISOString(),
    artist: { name: ctx.artistName },
    content: { explicit: false },
    // The default matters: silence grants nothing, but an artist who never
    // opens the editor should still have stated terms rather than none.
    licence: { type: "amply-personal-1" },
    payment: [],
    releases: [],
  };

  await putSetting(ctx, "manifest", JSON.stringify(manifest));

  ctx.progress.manifestDone = true;
  saveProgress(ctx.progress);
}

const RUNNERS = {
  account: stepAccount,
  bucket: stepBucket,
  database: stepDatabase,
  worker: stepWorker,
  subdomain: stepSubdomain,
  editor: stepEditor,
  access: stepAccess,
  manifest: stepManifest,
};

/**
 * Is this a hostname an artist may put their streaming service on?
 *
 * A new subdomain of a domain they own — listen.example.com — and nothing
 * else. Not the bare domain and not www, because those are almost always
 * their existing website, and a custom domain attached there would replace
 * it. Cloudflare refuses to overwrite an existing record unless told to, and
 * we never tell it to; this stops the attempt before it is made.
 */
export function domainProblem(hostname) {
  const h = String(hostname || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!h) return "Type the address you want, like listen.yourname.com.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) {
    return "That doesn't look like a web address. It should be like listen.yourname.com.";
  }
  if (/\.workers\.dev$|\.pages\.dev$/.test(h)) return "That's a Cloudflare address, not your own domain.";
  const labels = h.split(".");
  if (labels.length < 3) {
    return `Use a new part in front of it, like listen.${h}. Putting it on ${h} itself would replace your website.`;
  }
  if (labels[0] === "www") return "www is usually your website already. Use something new, like listen.";
  return null;
}

/**
 * Put an artist's streaming service on a domain they own.
 *
 * The strongest answer to impersonation there is: only the person who controls
 * yourname.com can put anything at listen.yourname.com, so a listener who sees
 * that address knows who they are paying, with no badge and no checker.
 *
 * One call does the work — Cloudflare attaches the Worker and issues the
 * certificate — provided the domain is on Cloudflare in the same account.
 * Everything else here is saying clearly what to do when it is not.
 */
export async function attachDomain({ token, relay, slug, hostname, onStep = () => {} }) {
  const host = String(hostname).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const problem = domainProblem(host);
  if (problem) throw new ProvisionError("bad_hostname", problem);

  const ctx = { token, relay, progress: {} };

  // Looked up here rather than through stepAccount, which saves setup's
  // progress as it goes — and a half-finished setup in this browser must not
  // be overwritten by attaching a domain.
  onStep("account", "running");
  const accounts = await api(ctx, "GET", "/accounts");
  if (!accounts?.length) throw new ProvisionError("no_account", "No Cloudflare account found on this login.");
  onStep("account", "done");

  // Attach, in whichever account holds this Worker. Almost everyone has one
  // account; someone with several is spared a question they may not know the
  // answer to, because the wrong account simply has no Worker by that name.
  onStep("attach", "running");
  let accountId = null;
  let failure = null;
  for (const a of accounts) {
    try {
      await api(ctx, "PUT", `/accounts/${a.id}/workers/domains`, {
        headers: { "Content-Type": "application/json" },
        // No zone given: Cloudflare finds it from the hostname, which means one
        // less permission to ask for. And no override of existing records, ever.
        body: JSON.stringify({ hostname: host, service: slug, environment: "production" }),
      });
      accountId = a.id;
      break;
    } catch (e) {
      const text = `${e.message} ${e.detail || ""}`;
      const noSuchWorker = /(script|service|worker)/i.test(text) && /(not found|does not exist|unknown)/i.test(text);
      // Keep the most telling failure: "no such Worker here" only matters if
      // it is the only thing any account said.
      if (!failure || !noSuchWorker) failure = e;
      if (!noSuchWorker) break;
    }
  }

  if (!accountId) {
    const e = failure;
    const text = `${e.message} ${e.detail || ""}`;
    if (e instanceof ProvisionError && e.kind === "auth") {
      throw new ProvisionError("domain_permission",
        "Cloudflare didn't allow Amply to attach the domain.", text);
    }
    if (/zone/i.test(text) && /(not found|could not find|no zone|not within|does not exist|unknown)/i.test(text)) {
      throw new ProvisionError("domain_not_on_cloudflare",
        "That domain isn't on your Cloudflare account yet.", text);
    }
    if (/(pending|not active|inactive)/i.test(text)) {
      throw new ProvisionError("domain_pending",
        "Your domain is on Cloudflare but not active yet.", text);
    }
    if (/(already|existing|conflict|in use|externally managed)/i.test(text)) {
      throw new ProvisionError("hostname_in_use",
        `${host} is already being used for something else.`, text);
    }
    if (/(script|service|worker)/i.test(text) && /(not found|does not exist|unknown)/i.test(text)) {
      throw new ProvisionError("no_worker",
        "Amply couldn't find your streaming service on this Cloudflare login.", text);
    }
    throw e;
  }
  onStep("attach", "done");

  // Remember it on the service itself, so the editor shares this address from
  // now on instead of the workers.dev one.
  onStep("remember", "running");
  try {
    const dbs = await api(ctx, "GET", `/accounts/${accountId}/d1/database?per_page=100`);
    const db = (dbs || []).find((d) => d.name === `${slug}-amply`);
    if (db) {
      ctx.progress = { accountId, dbId: db.uuid || db.id };
      await putSetting(ctx, "home", `https://${host}`);
    }
  } catch { /* the domain works regardless; the editor just keeps sharing the old link */ }
  onStep("remember", "done");

  return { url: `https://${host}`, host };
}

/**
 * Run the whole sequence. `onStep(id, state, detail)` is called with
 * "running" | "done" | "skipped" for each step so the UI can follow along.
 */
export async function provision({
  token, relay, artistName, slug, email = null, withAccess = true,
  workerUrl = "/node-worker.js",
  editorUrl = "/node-manage",   // Pages serves .html files extensionless
  versionUrl = "/node-version.json",
  chosenAccountId = null,
  mode = "setup",               // or "repair": rebuild the code, keep the music
  onStep = () => {},
}) {
  // A rebuild starts from nothing remembered. Progress exists so an
  // interrupted setup can resume; reusing it here would skip the very steps
  // that need doing again.
  if (mode === "repair") clearProgress();
  const progress = loadProgress();

  // Names are derived from the slug and stored, so a resumed run reuses exactly
  // the same names rather than creating a second set of resources.
  progress.bucketName ||= `${slug}-media`;
  progress.dbName ||= `${slug}-amply`;
  progress.workerName ||= slug;
  saveProgress(progress);

  const ctx = {
    token, relay, artistName, email, workerUrl, editorUrl, chosenAccountId, progress,
    versionUrl,
  };

  for (const step of (mode === "repair" ? REPAIR_STEPS : STEPS)) {
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
      if (OPTIONAL_STEPS.has(step.id) && !err?.fatal) {
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
