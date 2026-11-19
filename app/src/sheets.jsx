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
        <button class="btn-quiet wide" onClick={sheet.secondary || onClose}>{sheet.secondaryLabel || "Not now"}</button>
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
    case "nowallet": {
      // A fan who can subscribe by card never has to touch a wallet, so
      // that comes first wherever the artist offers it.
      const cheapest = (r.plans || []).slice().sort((a, b) => a.price / a.months - b.price / b.months)[0];
      const rate = r.rate > 0
        ? `${money(r.rate)} a minute (about ${money(r.rate * 4)} a song), paid straight to ${r.name || "the artist"}.`
        : `This song is paid for, straight to ${r.name || "the artist"}.`;
      if (cheapest) return {
        icon: <Icon.card size={22} />, title: `Support ${r.name || "this artist"} to listen`,
        body: `Subscribe by card and listen to everything, or pay as you go: ${rate}`,
        primaryLabel: `Subscribe by card · ${(!cheapest.currency || cheapest.currency === "usd") ? money(cheapest.price) : `${cheapest.price} ${cheapest.currency.toUpperCase()}`} for ${cheapest.months} months`,
        primary: go.artist,
        secondaryLabel: "Pay by the minute instead", secondary: go.setup || go.you,
      };
      return {
        icon: <Icon.card size={22} />, title: `Pay ${r.name || "the artist"} as you listen`,
        body: `${rate} You add a few dollars to Amply by card first. Free songs stay free.`,
        primaryLabel: "Set up paying", primary: go.you,
      };
    }
    case "subscribe": return {
      icon: <Icon.card size={22} />, title: "Subscribers only",
      primaryLabel: "See plans", primary: go.artist,
    };
    case "empty": return {
      icon: <Icon.card size={22} />, title: "Add money to keep listening",
      body: "Top up by card. It's paid out to artists as you listen, and free songs stay free.",
      primaryLabel: "Add money", primary: go.topUp,
    };
    case "paused": return {
      icon: <Icon.warn size={22} />, tone: "warn", title: "Payments paused",
      body: `${r.name || "This artist"} can't take payments right now. Nothing was charged. Try again later.`,
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

/**
 * An artist's server has stopped serving this wallet until it's paid what it
 * says is owed (their Auto-block). What it says, and the one thing to do.
 *
 * `v`: `{ name, art, owes (micros), state, partial, message }`. `state` is
 * where paying it has got to: "ask" (the Pay button), "daily" (over what goes
 * without asking in a day: the Pay button), "paying", "funds" (add money),
 * "paused" (their fees account can't pay: nobody can pay them right now —
 * not the listener's doing, and said calmly), "counting" (paid; their server
 * hasn't caught up), "unsure" (a payment not yet seen landing), "mismatch"
 * (wrong network), or "error" (didn't go through; tried again).
 */
export function unpaidSheet(v, { money, go }) {
  const name = v.name || "This artist";
  const usd = money(Math.max(v.owes || 0, 0) / 1e6);
  const base = { art: v.art ?? null, seed: name, title: `${name} has paused your listening until you've paid ${usd}` };
  const already = v.partial ? " Part of it has been paid already." : "";
  // Their number beside this device's own. This app counts for itself and
  // relies on neither: where they differ, the listener chooses, and the
  // first choice is what this device counted.
  const differs = v.mine != null && v.owes > 0 && v.mine < v.owes;
  const mineUsd = differs ? money(v.mine / 1e6) : null;
  const mine = differs ? ` This device counted ${mineUsd}.` : "";
  const choose = differs && v.mine > 0 && go.payMine
    ? { primaryLabel: `Pay ${mineUsd}`, primary: go.payMine, children: <button class="btn-quiet-solid wide" onClick={go.pay}>Pay their {usd}</button> }
    : { primaryLabel: `Pay ${usd}`, primary: go.pay };
  switch (v.state) {
    case "paying": return { ...base, body: `Paying ${usd} to ${name}…`, secondaryLabel: "Hide" };
    case "funds": return {
      ...base,
      body: `There isn't enough in your wallet to pay it.${already} Add money and it's paid straight away, and their music plays again.`,
      primaryLabel: "Add money", primary: go.topUp,
    };
    case "paused": return {
      icon: <Icon.card size={22} />, title: `${name} can't take payments right now`,
      body: "Their account for network fees is empty, so nobody can pay them at the moment. That isn't anything you've done, and nothing was taken. Amply keeps checking, and pays them as soon as they can take it.",
      secondaryLabel: "OK",
    };
    case "counting": return {
      icon: <Icon.check size={22} />, title: "Paid. Waiting for their server",
      body: `${name}'s server hasn't counted your payment yet. Your music plays again as soon as it does. Amply keeps checking.`,
      secondaryLabel: "OK",
    };
    case "unsure": return {
      ...base,
      body: `A payment to ${name} is still on its way. Amply checks it landed before sending anything more, so nothing is paid twice.`,
      secondaryLabel: "OK",
    };
    case "mismatch": return {
      ...base, icon: <Icon.warn size={22} />, tone: "warn", art: undefined,
      body: v.message, primaryLabel: "Settings", primary: go.you,
    };
    case "error": return {
      ...base,
      body: `${v.message ? `${v.message} ` : ""}Amply tries again on its own in a little while.${already}`,
      primaryLabel: `Try again: pay ${usd}`, primary: go.pay,
    };
    case "daily": return {
      ...base,
      body: `For listening you've already done, straight to them. More than Amply pays without asking.${mine}${already}`,
      ...choose,
    };
    default: return {
      ...base,
      body: `Their server's count of your listening. Their music plays again once they're paid.${mine}${already}`,
      ...choose,
    };
  }
}
