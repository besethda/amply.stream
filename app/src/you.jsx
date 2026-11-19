/**
 * You: the money, and everything that is yours on this device.
 */
import { useState } from "preact/hooks";
import { Icon } from "./icons.jsx";
import { artStyle } from "./looks.js";
import { money, TopUp, SendBack, SaveBackup } from "./wallet-ui.jsx";
import { backupSaved, machinery, passkeyWallet } from "./paying.js";
import { NETWORKS, networkName } from "./networks.js";
import { isSubscribed, subscriptionUntil, originOf } from "./identify.js";
import { nameOf } from "./screens.jsx";
import { charges } from "../../spec/pricing.mjs";
import { ask } from "./sheets.jsx";
import { Equalizer, Appearance } from "./eq-ui.jsx";
import { receipts, forgetReceipts } from "./receipts.js";

const KINDS = { listen: "Listening", tip: "Tip", purchase: "Purchase", owed: "Listening" };
const dayOf = (t) => {
  const d = new Date(t), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

/** Every payment this device sent, newest first, by day. */
function History({ entries, onOpenArtist }) {
  const all = receipts();
  if (!all.length) return <p class="dim">No payments yet.</p>;
  const byOrigin = (o) => entries.find((e) => { try { return new URL(e.url).origin === o; } catch { return false; } });
  const days = [];
  for (const r of all) {
    const d = dayOf(r.at);
    if (!days.length || days[days.length - 1].d !== d) days.push({ d, rows: [] });
    days[days.length - 1].rows.push(r);
  }
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const spent = all.filter((r) => r.at >= month.getTime()).reduce((n, r) => n + r.micros, 0);
  const KIND_ICON = { tip: <Icon.tip size={12} />, purchase: <Icon.card size={12} />, listen: <Icon.note size={12} />, owed: <Icon.note size={12} /> };
  return (
    <div class="history">
      <div class="tx-sum">
        <span class="label">THIS MONTH</span>
        <b>{money(spent / 1e6)}</b>
        <span class="dim small">{all.filter((r) => r.at >= month.getTime()).length} payments, straight to artists</span>
      </div>
      {days.map(({ d, rows }) => (
        <section key={d}>
          <span class="label">{d.toUpperCase()}</span>
          {rows.map((r, i) => {
            const e = r.origin && byOrigin(r.origin);
            const img = e?.manifest?.artist?.image;
            return (
              <button class="tx" key={r.signature || `${r.at}${i}`} onClick={() => e && onOpenArtist(e.url)} disabled={!e}>
                <span class="art round s40" style={artStyle(img, r.artist || "?")} />
                <span class="t"><b>{r.artist || "Artist"}</b><span class="tx-meta"><i class={`tx-kind ${r.kind || "listen"}`}>{KIND_ICON[r.kind] || KIND_ICON.listen}</i>{KINDS[r.kind] || "Payment"} · {new Date(r.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span></span>
                <span class="tx-amt"><i>−</i>{money(r.micros / 1e6)}</span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}


function Row({ icon, label, meta, onClick, tone }) {
  return (
    <button class={`you-row ${tone || ""}`} onClick={onClick}>
      <span class="you-icon">{icon}</span>
      <span class="t">{label}</span>
      {meta && <span class="mono-dim">{meta}</span>}
      <Icon.chevron size={15} />
    </button>
  );
}

function Sub({ title, onBack, children }) {
  return (
    <div class="screen you sub">
      <div class="head">
        <button class="circle-btn" onClick={onBack} aria-label="Back"><Icon.back size={17} /></button>
        <h1 class="h-sub">{title}</h1>
      </div>
      <div class="pad">{children}</div>
    </div>
  );
}

export function You({ pair, setPair, balance, owed, onRefresh, entries, onOpenArtist, view, setView, themeName, onTheme, purchases, onSetUp, eq }) {
  const network = NETWORKS[networkName()];
  const saved = pair && backupSaved(pair.publicKey.toBase58());
  const subs = entries.filter((e) => isSubscribed(originOf(e.url)));
  const back = () => setView(null);

  async function forget() {
    const ok = await ask(saved
      ? { title: "Remove this wallet?", body: "Your backup key brings it back.", confirm: "Remove", danger: true }
      : { title: "Your key isn't saved", body: "Removing the wallet loses the money and subscriptions in it.", confirm: "Remove anyway", danger: true });
    if (!ok) return;
    const { wallet } = await machinery();
    wallet.forgetWallet();
    forgetReceipts();
    setPair(null);
    back();
  }

  // Money goes in only once the key that can bring it back is saved: losing
  // an empty wallet costs nothing, losing a topped-up one costs real money.
  if (view === "topup" && pair && !saved && network.real) {
    return <Sub title="First, save your key" onBack={back}><SaveBackup pair={pair} onSaved={() => setView("topup")} cta="Saved. Now add money" /></Sub>;
  }
  if (view === "topup" && pair) return <Sub title="Top up" onBack={back}><TopUp address={pair.publicKey.toBase58()} balance={balance} network={network} /></Sub>;
  if (view === "send" && pair) return <Sub title="Send back" onBack={back}><SendBack pair={pair} balance={balance} onRefresh={onRefresh}
    nodes={(entries || []).filter((e) => e.feesPaid).map((e) => originOf(e.url))} /></Sub>;
  if (view === "backup" && pair) return <Sub title="Backup key" onBack={back}><SaveBackup pair={pair} onSaved={back} /></Sub>;
  if (view === "subs") {
    return (
      <Sub title="Subscriptions" onBack={back}>
        {subs.length ? subs.map((e) => (
          <button class="you-row" key={e.url} onClick={() => onOpenArtist(e.url)}>
            <span class="t">{nameOf(e)}</span>
            <span class="mono-dim">until {new Date(subscriptionUntil(originOf(e.url))).toLocaleDateString()}</span>
            <Icon.chevron size={15} />
          </button>
        )) : <p class="dim">None yet.</p>}
      </Sub>
    );
  }
  if (view === "history") return <Sub title="Payments" onBack={back}><History entries={entries || []} onOpenArtist={onOpenArtist} /></Sub>;
  if (view === "purchases") return <Sub title="Purchases" onBack={back}>{purchases}</Sub>;
  // Settings that aren't money: how it looks and sounds, and the wallet's
  // housekeeping (its key, how paying works, removing it).
  if (view === "general") {
    return (
      <Sub title="General" onBack={back}>
        <div class="general">
          {/* On desktop the top bar has its own light/dark switch. */}
          <div class="appearance-set">
            <span class="label">APPEARANCE</span>
            <Appearance themeName={themeName} onTheme={onTheme} />
          </div>
          <span class="label">SOUND</span>
          {eq && <Equalizer eq={eq} />}
        </div>
        <div class="you-list in-sub">
          {pair && <Row icon={<Icon.key size={18} />} label="Backup key" meta={saved ? "saved" : "not saved"} tone={saved ? "" : "warn-ink"} onClick={() => setView("backup")} />}
          <a class="you-row" href="/paying" target="_blank" rel="noopener">
            <span class="you-icon"><Icon.help size={18} /></span><span class="t">How paying works</span><Icon.external size={14} />
          </a>
          {pair && <Row icon={<Icon.trash size={18} />} label="Remove wallet" tone="warn-ink" onClick={forget} />}
        </div>
      </Sub>
    );
  }

  return (
    <div class="screen you">
      <div class="head"><h1>You</h1></div>
      <div class="pad stack">
        {!pair ? (
          <div class="id-card">
            <button class="btn-primary wide" onClick={() => onSetUp?.()}><Icon.key size={18} /> Save your ID</button>
            <span class="dim small">Needed for paid songs. No account, no email.</span>
          </div>
        ) : <>
          {passkeyWallet(pair.publicKey.toBase58()) ? (
            <p class="note-line good-ink small"><Icon.check size={14} /> Protected by your passkey. Use it to open this
              wallet on your other devices.</p>
          ) : !saved && (
            <button class="alert" onClick={() => setView("backup")}>
              <Icon.warn size={18} /><span>Backup key not saved</span><b>Save</b>
            </button>
          )}
          <div class="balance-card">
            <div class="bal-top">
              <span class="label">TO SPEND{!network.real ? " · TEST" : ""}</span>
              <span class="bal">
                <b>{balance ? money(Math.max(0, balance.usdc - owed)) : "…"}</b>
                {owed > 0 && <span class="mono-dim">{money(owed)} owed</span>}
              </span>
            </div>
            <button class="icon-btn dim bal-refresh" onClick={onRefresh} aria-label="Refresh"><Icon.refresh size={16} /></button>
            <div class="row">
              <button class="btn-primary sm" onClick={() => setView("topup")}><Icon.plus size={15} /> Top up</button>
              <button class="pill" onClick={() => setView("send")}><Icon.send size={15} /> Send back</button>
              <button class="icon-btn bal-history" onClick={() => setView("history")} aria-label="Payment history"><Icon.chevron size={18} /></button>
            </div>
          </div>
        </>}
      </div>

      <div class="you-list">
        <Row icon={<Icon.card size={18} />} label="Subscriptions" meta={subs.length ? String(subs.length) : ""} onClick={() => setView("subs")} />
        <Row icon={<Icon.folder size={18} />} label="Purchases" onClick={() => setView("purchases")} />
        <Row icon={<Icon.sliders size={18} />} label="General" onClick={() => setView("general")} />
      </div>
      <p class="mono-dim pad foot-note">Everything here lives on this device.</p>
    </div>
  );
}
