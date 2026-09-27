/**
 * The editor, running against nothing.
 *
 * A design harness: the same `Editor` an artist gets, wired to a fake api and a
 * sample manifest so the interface can be looked at without provisioning a node
 * and uploading real music to it. Built by `npm run preview`, written to a
 * scratch file, never served and never uploaded anywhere.
 *
 * The sample data is obviously fictional on purpose. Nothing here should ever
 * read as a real artist's numbers.
 */
import { render } from "preact";
import { Editor } from "./ui.jsx";

/**
 * Stand-in photographs, deliberately enormous.
 *
 * Each declares a width and height far larger than the box that holds it, so
 * an image that escapes its box and renders at its own size shows at once. A
 * placeholder that already fits would hide that.
 */
const pic = (w, h, a, b, label) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="monospace" font-size="${Math.round(Math.min(w, h) / 12)}" fill="rgba(255,255,255,.85)">` +
    `${label} ${w}x${h}</text></svg>`);

const AVATAR = pic(1600, 1600, "#f6711e", "#b23c00", "photo");
const COVER = pic(3200, 1200, "#131110", "#4a4644", "cover");
const ART = pic(2400, 2400, "#2c6b45", "#0f2e1d", "art");

const NODE = "https://hollowcoast.amply.workers.dev";

const sample = {
  amply: 1,
  updated: "2026-09-19T12:00:00Z",
  artist: {
    name: "Hollow Coast",
    bio: "Recorded in a converted lifeboat station on the Norfolk coast. Everything here is original and self-released.",
    image: AVATAR,
    banner: COVER,
    links: [{ label: "Bandcamp", url: "https://example.bandcamp.com" }],
  },
  content: { explicit: false },
  licence: { type: "amply-personal-1" },
  payment: [{
    type: "solana-usdc",
    ratePerMinute: 0.01,
    settleAt: 0.2,
    recipients: [
      { name: "Hollow Coast", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", split: 60 },
      { name: "Ada Vance", address: "9mPQ4cLXmhVYPb2M9fVd8rTgFq7WuXsKbNa1ZyEeRtUv", split: 40 },
    ],
  }],
  releases: [{
    id: "longwave",
    title: "Longwave",
    date: "2026-03-01",
    art: ART,
    tracks: [
      { id: "signal-fade", title: "Signal Fade", duration: 252, url: `${NODE}/audio/a.mp3` },
      { id: "north-sea-static", title: "North Sea Static", duration: 220, url: `${NODE}/audio/b.mp3` },
      { id: "tideline", title: "Tideline", duration: 306, url: `${NODE}/audio/c.mp3` },
    ],
  }],
};

// Every call succeeds, slowly enough that the busy states are visible.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = {
  async whoami() { return { email: "you@example.com", version: "preview" }; },
  async readManifest() { return sample; },
  // What would have been sent, kept for anyone poking at the preview.
  async writeManifest(m) { window.__published = m; await wait(700); },
  async putObject(key, body) { (window.__uploads ||= []).push({ key, size: body.size, body }); await wait(700); },
  async deleteObject() { await wait(200); },
  // The first track is a 46MB WAV, like a real first upload tends to be.
  async sizeOf(url) { return url.endsWith("/a.mp3") ? 46101094 : 6_500_000; },
  async listeners() { return [{ pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", plays: 12, seconds: 2880, first_seen: Date.now() - 864e5 * 9, last_seen: Date.now() - 864e5, blocked: 0, subscribed_until: null }]; },
  async stripeStatus() { return { connected: false }; },
  async connectStripe(key, plans) {
    await wait(900);
    return {
      connected: true, live: false, cancellable: true,
      plans: plans.map((p) => ({ ...p, currency: "usd", url: `https://buy.stripe.com/test_${p.months}` })),
    };
  },
  async disconnectStripe() { await wait(300); },
};

render(
  <Editor
    api={api}
    node={{ slug: "hollowcoast", url: NODE }}
    initial={sample}
    onSignOut={() => {}}
  />,
  document.getElementById("app"),
);
