/**
 * You: the money, and everything that is yours on this device.
 */
import { useState } from "preact/hooks";
import { Icon } from "./icons.jsx";
import { money, SetUp, TopUp, SendBack, SaveBackup } from "./wallet-ui.jsx";
import { backupSaved, machinery } from "./paying.js";
import { NETWORKS, networkName, useNetwork } from "./networks.js";
import { isSubscribed, subscriptionUntil, originOf } from "./identify.js";
import { nameOf } from "./screens.jsx";
import { ask } from "./sheets.jsx";

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
    <div class="screen">
      <div class="head">
        <button class="circle-btn" onClick={onBack} aria-label="Back"><Icon.back size={17} /></button>
        <h1 class="h-sub">{title}</h1>
      </div>
      <div class="pad">{children}</div>
    </div>
  );
}

export function You({ pair, setPair, balance, owed, onRefresh, entries, onOpenArtist, view, setView, themeName, onTheme, purchases }) {
  const [where, setWhere] = useState(networkName);
  const network = NETWORKS[where];
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
    setPair(null);
    back();
  }

  if (view === "topup" && pair) return <Sub title="Top up" onBack={back}><TopUp address={pair.publicKey.toBase58()} balance={balance} network={network} /></Sub>;
  if (view === "send" && pair) return <Sub title="Send back" onBack={back}><SendBack pair={pair} balance={balance} onRefresh={onRefresh} /></Sub>;
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
  if (view === "purchases") return <Sub title="Purchases" onBack={back}>{purchases}</Sub>;
  if (view === "network") {
    return (
      <Sub title="Network" onBack={back}>
        <div class="segs">
          {["mainnet", "devnet"].map((n) => (
            <button key={n} class={`seg${where === n ? " on" : ""}`} onClick={() => { useNetwork(n); setWhere(n); onRefresh?.(); }}>
              {n === "mainnet" ? "Real money" : "Test"}
            </button>
          ))}
        </div>
        <p class="dim small">Same key on both. Artists are only paid on the network they ask for.</p>
      </Sub>
    );
  }

  return (
    <div class="screen">
      <div class="head"><h1>You</h1></div>
      <div class="pad stack">
        {!pair ? <SetUp onMade={setPair} /> : <>
          {!saved && (
            <button class="alert" onClick={() => setView("backup")}>
              <Icon.warn size={18} /><span>Backup key not saved</span><b>Save</b>
            </button>
          )}
          <div class="balance-card">
            <span class="label">TO SPEND{!network.real ? " · TEST" : ""}</span>
            <div class="bal">
              <b>{balance ? money(Math.max(0, balance.usdc - owed)) : "…"}</b>
              {owed > 0 && <span class="mono-dim">{money(owed)} owed</span>}
              <button class="icon-btn dim" onClick={onRefresh} aria-label="Refresh"><Icon.refresh size={16} /></button>
            </div>
            {balance && !(balance.sol > 0.001) && <span class="note-line warn-ink small"><Icon.warn size={13} /> No SOL for fees</span>}
            <div class="row">
              <button class="btn-primary sm" onClick={() => setView("topup")}><Icon.plus size={15} /> Top up</button>
              <button class="pill" onClick={() => setView("send")}><Icon.send size={15} /> Send back</button>
            </div>
          </div>
        </>}
      </div>

      <div class="you-list">
        <Row icon={<Icon.card size={18} />} label="Subscriptions" meta={subs.length ? String(subs.length) : ""} onClick={() => setView("subs")} />
        <Row icon={<Icon.folder size={18} />} label="Purchases" onClick={() => setView("purchases")} />
        {pair && <Row icon={<Icon.key size={18} />} label="Backup key" meta={saved ? "saved" : "not saved"} tone={saved ? "" : "warn-ink"} onClick={() => setView("backup")} />}
        {pair && <Row icon={<Icon.globe size={18} />} label="Network" meta={network.real ? "Solana" : "Test"} onClick={() => setView("network")} />}
        <Row icon={themeName === "dark" ? <Icon.sun size={18} /> : <Icon.moon size={18} />} label={themeName === "dark" ? "Light mode" : "Dark mode"} onClick={onTheme} />
        <a class="you-row" href="/paying" target="_blank" rel="noopener">
          <span class="you-icon"><Icon.help size={18} /></span><span class="t">How paying works</span><Icon.external size={14} />
        </a>
        {pair && <Row icon={<Icon.trash size={18} />} label="Remove wallet" tone="warn-ink" onClick={forget} />}
      </div>
      <p class="mono-dim pad foot-note">Everything here lives on this device.</p>
    </div>
  );
}
