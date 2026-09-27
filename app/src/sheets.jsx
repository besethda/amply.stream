/**
 * Sheets from the bottom, for the moments that need a decision — mostly money —
 * and toasts, for the ones that don't.
 */
import { useEffect, useRef } from "preact/hooks";
import { usePullDown } from "./gestures.js";
import { lockScroll } from "./scroll.js";
import { Icon } from "./icons.jsx";
import { artStyle } from "./looks.js";

export function Sheet({ sheet, onClose }) {
  const box = useRef(null);
  useEffect(() => {
    if (!sheet) return;
    const esc = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [sheet]);
  const scrim = useRef(null);
  // The page behind stays put while a sheet is open.
  useEffect(() => (sheet ? lockScroll() : undefined), [!!sheet]);
  usePullDown(box, onClose, {
    on: !!sheet,
    onPull: (f, ease) => {
      const s = scrim.current;
      if (!s) return;
      s.style.transition = ease ? "opacity .2s ease" : "none";
      s.style.opacity = String(1 - f);
    },
  });
  if (!sheet) return null;
  return (
    <div class="sheet-wrap" role="dialog" aria-modal="true" aria-label={sheet.title}>
      <button class="sheet-scrim" ref={scrim} onClick={onClose} aria-label="Close" />
      <div class="sheet" ref={box}>
        <span class="grip" />
        {sheet.art !== undefined && <span class="art s56" style={artStyle(sheet.art, sheet.seed)} />}
        {sheet.icon && <span class={`sheet-icon ${sheet.tone || ""}`}>{sheet.icon}</span>}
        <h2>{sheet.title}</h2>
        {sheet.body && <p class="dim">{sheet.body}</p>}
        {sheet.mono && <p class="mono-box">{sheet.mono}</p>}
        {sheet.children}
        {sheet.primary && <button class={`btn-primary wide${sheet.danger ? " danger" : ""}`} onClick={sheet.primary}>{sheet.primaryLabel}</button>}
        <button class="btn-quiet wide" onClick={onClose}>{sheet.secondaryLabel || "Not now"}</button>
      </div>
    </div>
  );
}

/**
 * Confirming something, in Amply's own sheet rather than the browser's alert.
 * The app registers how to open a sheet; anything can then `await ask(...)`.
 */
let opener = null;
export const registerAsk = (fn) => { opener = fn; };
export function ask({ title, body = null, confirm = "OK", danger = false, icon = null }) {
  if (!opener) return Promise.resolve(typeof window !== "undefined" && window.confirm(title));
  return opener({ title, body, confirm, danger, icon });
}

export function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div class={`toast${toast.bad ? " bad" : ""}`} role="status">
      {toast.bad ? <Icon.warn size={15} /> : <Icon.check size={15} />}
      <span>{toast.text}</span>
    </div>
  );
}

/**
 * What to say when a song can't play, and the one action that fixes it.
 * `r` is the player's refusal ({ kind, message, ... }).
 */
export function refusalSheet(r, { money, go }) {
  switch (r.kind) {
    case "price": return {
      art: r.art || null, seed: r.name,
      title: `${money(r.rate)} a minute`,
      mono: `≈${money(r.rate * 4)} a song · paid to ${r.name}`,
      body: r.was ? `Up from ${money(r.was)}.` : null,
      primaryLabel: "Agree and play", primary: go.agree,
    };
    case "nowallet": return {
      icon: <Icon.card size={22} />, title: "Set up paying",
      body: "Paid songs need it. Free ones don't.",
      primaryLabel: "Set up", primary: go.you,
    };
    case "subscribe": return {
      icon: <Icon.card size={22} />, title: "Subscribers only",
      primaryLabel: "See plans", primary: go.artist,
    };
    case "empty": return {
      icon: <Icon.card size={22} />, title: "Nothing left to spend",
      primaryLabel: "Top up", primary: go.topUp,
    };
    case "nosol": return {
      icon: <Icon.card size={22} />, title: "Add a little SOL",
      body: "It pays the network fee.",
      primaryLabel: "Top up", primary: go.topUp,
    };
    case "mismatch": return {
      icon: <Icon.warn size={22} />, tone: "warn", title: "Wrong network",
      body: r.message, primaryLabel: "Settings", primary: go.you,
    };
    case "offline": return {
      icon: <Icon.warn size={22} />, tone: "warn", title: "Not answering",
      body: "Their streaming service is offline.",
      primaryLabel: "Try again", primary: go.retry,
    };
    default: return {
      icon: <Icon.warn size={22} />, tone: "warn", title: "Can't play this",
      body: r.message, secondaryLabel: "Close",
    };
  }
}
