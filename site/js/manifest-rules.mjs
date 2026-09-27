/**
 * The Amply manifest rules, as a module.
 *
 * One copy, used twice: by spec/validate.mjs on the command line, and bundled
 * into the artist's editor, which runs them before every publish. Two copies
 * would drift, and the editor once published a manifest this file rejects.
 * No dependencies and nothing Node-specific, so it runs in either place.
 */
export const SPEC_VERSION = 1;
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RATE = 1.0;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Which chain a payment is denominated on. Real money first, deliberately:
 * `network` is optional, and what an absent field means is whatever stands at
 * the front of this list. Anything else and an artist who never heard of the
 * field would be quietly moved onto play money.
 */
export const NETWORKS = ["solana", "devnet"];

/**
 * Subscription lengths an artist may offer, in months. Nothing shorter: card
 * fees are roughly 1.5% plus a fixed 25 cents, so a one-month plan at a dollar
 * would lose a quarter of itself before the artist saw any.
 */
export const PLAN_MONTHS = [3, 6, 12];
/** Below this the fixed part of a card fee eats too much of the price. */
export const MIN_PLAN_PRICE = 2;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Selling a song or an album to keep. Card fees are about 25 cents plus a
 * percentage, so less than this and the artist sees little of it; Stripe
 * refuses charges below 50 cents anyway.
 */
export const MIN_SALE_PRICE = 0.5;
export const MAX_SALE_PRICE = 1000;

/**
 * An album's or a song's `sale`: a fixed price in dollars, paid by card
 * through the artist's own Stripe (`url`, a Payment Link the artist's server
 * made) or in USDC to the artist's wallet (when they have one). Either way the
 * artist's own server confirms the payment and hands over the file.
 */
function sale(s, p, m) {
  if (!isObj(s)) return err(p, "must be an object");
  if (typeof s.price !== "number" || !(s.price >= MIN_SALE_PRICE) || s.price > MAX_SALE_PRICE)
    err(`${p}.price`, `must be a number from ${MIN_SALE_PRICE} to ${MAX_SALE_PRICE} (dollars)`);
  if (s.currency !== undefined && s.currency !== "usd") err(`${p}.currency`, "must be usd (or absent)");
  if (s.url !== undefined && httpsUrl(s.url, `${p}.url`)) {
    const host = new URL(s.url).host;
    if (host !== "buy.stripe.com" && !host.endsWith(".stripe.com")) err(`${p}.url`, "must be a Stripe payment link (buy.stripe.com)");
  }
  const wallet = (m.payment || []).some((e) => isObj(e) && e.type === "solana-usdc");
  if (s.url === undefined && !wallet) warn(p, "no way to pay: add a Stripe link or a Solana payment method");
}

let errors = [];
let warnings = [];
const err = (p, m) => errors.push(`${p}: ${m}`);
const warn = (p, m) => warnings.push(`${p}: ${m}`);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(v, p, { required = false, min = 1, max = Infinity } = {}) {
  if (v === undefined) { if (required) err(p, "required"); return false; }
  if (typeof v !== "string") { err(p, `must be a string, got ${typeof v}`); return false; }
  if (v.length < min) { err(p, `must be at least ${min} character(s)`); return false; }
  if (v.length > max) { err(p, `must be at most ${max} characters (got ${v.length})`); return false; }
  return true;
}

function httpsUrl(v, p, { required = false } = {}) {
  if (v === undefined) { if (required) err(p, "required"); return false; }
  if (typeof v !== "string") { err(p, "must be a string URL"); return false; }
  let u;
  try { u = new URL(v); } catch { err(p, `not a valid absolute URL: ${JSON.stringify(v)}`); return false; }
  if (u.protocol !== "https:") { err(p, `must be https, got ${u.protocol.replace(":", "")}`); return false; }
  return true;
}

function id(v, p, seen) {
  if (!str(v, p, { required: true })) return;
  if (!ID_RE.test(v)) { err(p, `must match [a-z0-9-], 1-64 chars (got ${JSON.stringify(v)})`); return; }
  if (seen.has(v)) err(p, `duplicate id ${JSON.stringify(v)} — ids must be unique across the manifest`);
  seen.add(v);
}

function check(m) {
  if (!isObj(m)) { err("$", "manifest must be a JSON object"); return; }

  if (m.amply === undefined) err("amply", "required");
  else if (m.amply !== SPEC_VERSION) err("amply", `unsupported spec version ${m.amply} (this validator knows ${SPEC_VERSION})`);

  if (str(m.updated, "updated", { required: true })) {
    if (Number.isNaN(Date.parse(m.updated))) err("updated", "not a parseable ISO 8601 timestamp");
  }

  // artist
  if (!isObj(m.artist)) err("artist", "required, must be an object");
  else {
    str(m.artist.name, "artist.name", { required: true, max: 200 });
    if (m.artist.bio !== undefined) str(m.artist.bio, "artist.bio", { max: 2000 });
    if (m.artist.image !== undefined) httpsUrl(m.artist.image, "artist.image");
    if (m.artist.banner !== undefined) httpsUrl(m.artist.banner, "artist.banner");
    // A domain the artist owns, confirmed by a DNS record on it pointing back
    // at this manifest — see spec/domain.mjs. The claim alone proves nothing;
    // clients show it only once the record agrees.
    if (m.artist.domain !== undefined && str(m.artist.domain, "artist.domain", { max: 253 })) {
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(m.artist.domain)) {
        err("artist.domain", "must be a bare domain in lower case, like yourname.com");
      }
    }
    // How a listener reaches the artist about their data. An artist who
    // charges holds a record of each wallet that plays their music, which
    // makes them its controller, and a controller has to be reachable. An
    // email address or an https page; it is shown on the artist's privacy page.
    if (m.artist.contact !== undefined && str(m.artist.contact, "artist.contact", { max: 320 })) {
      const c = m.artist.contact;
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c);
      const page = /^https:\/\/\S+$/.test(c);
      if (!email && !page) err("artist.contact", "must be an email address or an https link");
    }
    if (m.artist.links !== undefined) {
      if (!Array.isArray(m.artist.links)) err("artist.links", "must be an array");
      else {
        if (m.artist.links.length > 20) err("artist.links", "at most 20 links");
        m.artist.links.forEach((l, i) => {
          const p = `artist.links[${i}]`;
          if (!isObj(l)) return err(p, "must be an object");
          str(l.label, `${p}.label`, { required: true, max: 40 });
          httpsUrl(l.url, `${p}.url`, { required: true });
        });
      }
    }
  }

  // content
  if (m.content !== undefined) {
    if (!isObj(m.content)) err("content", "must be an object");
    else if (m.content.explicit !== undefined && typeof m.content.explicit !== "boolean")
      err("content.explicit", "must be a boolean");
  }

  // licence
  if (m.licence !== undefined) {
    if (!isObj(m.licence)) err("licence", "must be an object");
    else {
      if (str(m.licence.type, "licence.type", { required: true, max: 64 })) {
        const known = ["amply-personal-1", "custom"];
        if (!known.includes(m.licence.type)) {
          warn("licence.type", `unrecognised licence ${JSON.stringify(m.licence.type)} — clients will treat it as granting no redistribution rights`);
        }
        if (m.licence.type === "custom" && m.licence.url === undefined) {
          err("licence.url", "required when type is \"custom\" — otherwise the terms cannot be read");
        }
      }
      if (m.licence.url !== undefined) httpsUrl(m.licence.url, "licence.url");
      if (m.licence.notice !== undefined) str(m.licence.notice, "licence.notice", { max: 300 });
    }
  } else {
    warn("licence", "absent — clients must assume no redistribution rights were granted");
  }

  // payment
  if (m.payment !== undefined) {
    if (!Array.isArray(m.payment)) err("payment", "must be an array");
    else {
      if (m.payment.length === 0) warn("payment", "empty — this artist cannot be paid");
      m.payment.forEach((e, i) => {
        const p = `payment[${i}]`;
        if (!isObj(e)) return err(p, "must be an object");
        if (!str(e.type, `${p}.type`, { required: true })) return;
        if (e.type === "solana-usdc") {
          // Exactly one of address (one payee) or recipients (a split).
          if (e.recipients !== undefined) {
            if (e.address !== undefined)
              err(`${p}.address`, "must be absent when recipients is present, the split names every payee");
            if (!Array.isArray(e.recipients)) err(`${p}.recipients`, "must be an array");
            else if (e.recipients.length === 0) err(`${p}.recipients`, "must name at least one payee");
            else if (e.recipients.length > 10) err(`${p}.recipients`, "at most 10 payees");
            else {
              let total = 0;
              e.recipients.forEach((r, k) => {
                const rp = `${p}.recipients[${k}]`;
                if (!isObj(r)) return err(rp, "must be an object");
                if (r.name !== undefined) str(r.name, `${rp}.name`, { max: 200 });
                if (str(r.address, `${rp}.address`, { required: true }) && !B58_RE.test(r.address))
                  err(`${rp}.address`, "not a plausible base58 Solana address (32-44 chars)");
                if (typeof r.split !== "number") err(`${rp}.split`, "required, must be a number (percent)");
                else if (!(r.split > 0)) err(`${rp}.split`, "must be greater than 0");
                else total += r.split;
              });
              // Floating point: 33.33 x 3 will not land on 100 exactly, and a
              // client dividing a payment has to know the shares are whole.
              if (Math.abs(total - 100) > 0.01)
                err(`${p}.recipients`, `splits must total 100%, got ${total.toFixed(2)}%`);
            }
          } else if (str(e.address, `${p}.address`, { required: true }) && !B58_RE.test(e.address)) {
            err(`${p}.address`, "not a plausible base58 Solana address (32-44 chars)");
          }
          if (typeof e.ratePerMinute !== "number") err(`${p}.ratePerMinute`, "required, must be a number");
          else if (!(e.ratePerMinute > 0)) err(`${p}.ratePerMinute`, "must be greater than 0");
          else if (e.ratePerMinute > MAX_RATE) err(`${p}.ratePerMinute`, `must be at most ${MAX_RATE} USD/min (got ${e.ratePerMinute})`);
          if (e.settleAt !== undefined) {
            if (typeof e.settleAt !== "number") err(`${p}.settleAt`, "must be a number");
            else if (e.settleAt < 0.01 || e.settleAt > 100) err(`${p}.settleAt`, "must be between 0.01 and 100 USD");
          }
          // Which chain the artist wants to be paid on. Absent means real
          // money, because a manifest that does not raise the question is not
          // asking to be paid in something worthless — and because every
          // manifest written before this field existed meant exactly that.
          if (e.network !== undefined && !NETWORKS.includes(e.network)) {
            err(`${p}.network`, `must be one of ${NETWORKS.join(", ")} (absent means ${NETWORKS[0]})`);
          }
        } else if (e.type === "stripe-subscription") {
          // A card subscription, sold by the artist through their own Stripe
          // account: Amply is never the seller and never holds the money. The
          // artist's server asks Stripe who has paid and serves them.
          if (!Array.isArray(e.plans) || e.plans.length === 0) {
            err(`${p}.plans`, "must list at least one plan");
          } else {
            if (e.plans.length > PLAN_MONTHS.length) err(`${p}.plans`, `at most ${PLAN_MONTHS.length} plans`);
            const seen = new Set();
            e.plans.forEach((plan, k) => {
              const pp = `${p}.plans[${k}]`;
              if (!isObj(plan)) return err(pp, "must be an object");
              if (!PLAN_MONTHS.includes(plan.months)) err(`${pp}.months`, `must be one of ${PLAN_MONTHS.join(", ")}`);
              else if (seen.has(plan.months)) err(`${pp}.months`, "each length may appear once");
              seen.add(plan.months);
              if (typeof plan.price !== "number" || !(plan.price >= MIN_PLAN_PRICE) || plan.price > 1000)
                err(`${pp}.price`, `must be a number from ${MIN_PLAN_PRICE} to 1000`);
              if (plan.currency !== undefined && !/^[a-z]{3}$/.test(plan.currency))
                err(`${pp}.currency`, "must be a three-letter currency code in lower case");
              if (httpsUrl(plan.url, `${pp}.url`, { required: true })) {
                // A Stripe-hosted checkout, so a listener pays on Stripe's page
                // and nowhere an artist's server — or anyone else — controls.
                const host = new URL(plan.url).host;
                if (host !== "buy.stripe.com" && !host.endsWith(".stripe.com"))
                  err(`${pp}.url`, "must be a Stripe payment link (buy.stripe.com)");
              }
            });
          }
        } else if (e.type === "link") {
          str(e.label, `${p}.label`, { required: true, max: 40 });
          httpsUrl(e.url, `${p}.url`, { required: true });
        } else {
          warn(p, `unknown payment type ${JSON.stringify(e.type)} — clients will skip it`);
        }
      });
    }
  }

  // releases
  const ids = new Set();
  if (!Array.isArray(m.releases)) { err("releases", "required, must be an array"); return; }
  if (m.releases.length === 0) warn("releases", "empty — valid, but nothing to listen to");
  m.releases.forEach((r, i) => {
    const p = `releases[${i}]`;
    if (!isObj(r)) return err(p, "must be an object");
    id(r.id, `${p}.id`, ids);
    str(r.title, `${p}.title`, { required: true, max: 300 });
    if (r.date !== undefined && !DATE_RE.test(String(r.date))) err(`${p}.date`, "must be YYYY-MM-DD");
    if (r.art !== undefined) httpsUrl(r.art, `${p}.art`);
    if (r.colors !== undefined) {
      if (!isObj(r.colors)) err(`${p}.colors`, "must be an object");
      else for (const k of ["accent", "deep"]) {
        if (r.colors[k] !== undefined && !/^#[0-9a-f]{6}$/.test(String(r.colors[k])))
          err(`${p}.colors.${k}`, "must be a colour like #e0652c");
      }
    }
    if (r.sale !== undefined) sale(r.sale, `${p}.sale`, m);
    if (!Array.isArray(r.tracks) || r.tracks.length === 0) return err(`${p}.tracks`, "required, must be a non-empty array");
    r.tracks.forEach((t, j) => {
      const tp = `${p}.tracks[${j}]`;
      if (!isObj(t)) return err(tp, "must be an object");
      id(t.id, `${tp}.id`, ids);
      str(t.title, `${tp}.title`, { required: true, max: 300 });
      if (!Number.isInteger(t.duration)) err(`${tp}.duration`, "required, must be an integer (seconds)");
      else if (t.duration <= 0) err(`${tp}.duration`, "must be greater than 0");
      httpsUrl(t.url, `${tp}.url`, { required: true });
      if (t.waves !== undefined) httpsUrl(t.waves, `${tp}.waves`);
      if (t.explicit !== undefined && typeof t.explicit !== "boolean") err(`${tp}.explicit`, "must be a boolean");
      if (t.needsWallet !== undefined && typeof t.needsWallet !== "boolean")
        err(`${tp}.needsWallet`, "must be a boolean");
      // If the artist charges, every track is paid for unless it says free.
      // See spec/pricing.mjs, which both the server and the app apply.
      if (t.free !== undefined && typeof t.free !== "boolean")
        err(`${tp}.free`, "must be a boolean");
      if (t.sale !== undefined) sale(t.sale, `${tp}.sale`, m);
    });
  });
}

/** Check a parsed manifest. Returns every problem found, never throws. */
export function validate(m) {
  errors = [];
  warnings = [];
  check(m);
  return { errors, warnings };
}
