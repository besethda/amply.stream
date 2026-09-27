/**
 * Links, and getting them into the app on an iPhone.
 *
 * An iPhone opens every link in Safari, even with Amply on the Home Screen —
 * Apple lets no home-screen app claim links, or be found from a web page —
 * and the two keep separate storage: a gift opened in Safari would be kept in
 * Safari, with Safari's wallet, not in the app. So an Amply link opened in
 * Safari on an iPhone asks first: copy it, open Amply, and paste it into +;
 * or carry on in Safari, for anyone who doesn't have the app (remembered, so
 * they're asked once). Everywhere else links simply open.
 */
import { useState } from "preact/hooks";
import { Icon } from "./icons.jsx";
import { readShare } from "./collection.js";

const STAY = "amply.browser.v1";

/** Running from the Home Screen, rather than in a browser tab. */
export const standalone = () => {
  try { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch { return false; }
};
/** An iPhone or iPad (which calls itself a Mac, with a touch screen). */
export const onIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const staying = () => { try { return localStorage.getItem(STAY) === "1"; } catch { return false; } };
const stay = () => { try { localStorage.setItem(STAY, "1"); } catch { /* storage off */ } };

/** Should this link be handed to the app, rather than opened here? */
export const needsHandoff = () => onIOS() && !standalone() && !staying();

/** The link kinds that are shared, as opposed to Stripe sending someone back. */
export const SHARED_LINK = /[?&](add|playlist|gift|song|album)=/;

function what(link) {
  switch (link.kind) {
    case "gift": return "A gift for you";
    case "song": return "A song";
    case "album": return "An album";
    case "playlist": return `A playlist${readShare(link.value)?.name ? `: ${readShare(link.value).name}` : ""}`;
    default: return "An artist";
  }
}

/** The screen that asks. */
export function Handoff({ link, url, onStay }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); }
    catch { window.prompt("Copy this link:", url); setCopied(true); }
  }
  const gift = link.kind === "gift";
  return (
    <div class="handoff" role="dialog" aria-label="Open in the Amply app">
      <span class="handoff-icon">{gift ? <Icon.heart size={26} /> : <Icon.note size={26} />}</span>
      <p class="label">{what(link).toUpperCase()}</p>
      <h1>Open it in Amply</h1>
      <ol class="handoff-steps">
        <li><b>Copy</b> the link</li>
        <li><b>Open Amply</b> from your Home Screen</li>
        <li>Tap <b>+</b>, then <b>Paste</b></li>
      </ol>
      <button class="btn-primary wide" onClick={copy}>
        {copied ? <><Icon.check size={16} /> Copied — now open Amply</> : <><Icon.copy size={16} /> Copy link</>}
      </button>
      <button class="btn-quiet wide" onClick={() => { stay(); onStay(); }}>
        {gift ? "Open it here in Safari" : "Continue in Safari"}
      </button>
      <p class="mono-dim small center">
        {gift ? "Opened here, it's kept in Safari, not in your app. " : ""}No Amply yet? Continue, then Share → Add to Home Screen.
      </p>
    </div>
  );
}
