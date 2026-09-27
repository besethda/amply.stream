/**
 * The wallet, as the listener sees it: setting it up, topping it up, sending
 * it back, and saving its key.
 *
 * Short on words by design. The consequences are a pocket's — nobody can
 * reverse a payment or recover the key — and the few lines here say so; the
 * longer explanation lives at /paying, one tap away.
 */
import { useState, useEffect } from "preact/hooks";
import { machinery, markBackupSaved, onHomeScreen } from "./paying.js";
import { transferRequest, DOLLAR_AMOUNTS, FEE_SOL, oneTapReady } from "./topup.js";
import { Icon } from "./icons.jsx";
import { ask } from "./sheets.jsx";

export const money = (usd) =>
  usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `${Number((usd * 100).toFixed(2))}¢`;

export function Copy({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button class="pill" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); }
      catch { window.prompt("Copy this:", text); }
    }}>
      {done ? <Icon.check size={15} /> : <Icon.copy size={15} />} {done ? "Copied" : label}
    </button>
  );
}

/**
 * Saving the backup key. It is the only way back into the wallet, and the way
 * to use the same wallet — money and subscriptions — on another device.
 */
export function SaveBackup({ pair, onSaved, cta = "Saved" }) {
  const [key, setKey] = useState(null);

  async function reveal() {
    const { wallet } = await machinery();
    setKey(wallet.backupOf(pair));
  }
  function done() {
    markBackupSaved(pair.publicKey.toBase58());
    onSaved?.();
  }

  return (
    <div class="stack">
      <p class="dim">Your key is your wallet. Keep it private — it's how you get back in, or use
      Amply on another device.</p>
      {onHomeScreen() && <p class="note-line warn-ink"><Icon.warn size={15} /> Deleting this app deletes the wallet.</p>}
      {key ? (
        <>
          <p class="mono-box secret">{key}</p>
          <div class="row">
            <Copy text={key} />
            <button class="btn-primary" onClick={done}>{cta}</button>
          </div>
        </>
      ) : (
        <button class="btn-primary" onClick={reveal}><Icon.eye size={17} /> Show my key</button>
      )}
    </div>
  );
}

/** Before there is a wallet. */
export function SetUp({ onMade }) {
  const [restoring, setRestoring] = useState(false);
  const [backup, setBackup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(fn) {
    setBusy(true); setError(null);
    try { onMade(await fn()); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const make = () => run(async () => (await machinery()).wallet.createWallet());
  const restore = () => run(async () => {
    const pair = (await machinery()).wallet.restoreWallet(backup);
    markBackupSaved(pair.publicKey.toBase58());   // pasted from somewhere, so saved somewhere
    return pair;
  });

  return (
    <div class="panel stack">
      <h2>Pay by the minute</h2>
      <ol class="steps">
        <li><Icon.key size={18} /> Make a wallet here</li>
        <li><Icon.card size={18} /> Buy USDC + $1 of SOL in Phantom</li>
        <li><Icon.send size={18} /> Send it here</li>
      </ol>
      <p class="mono-dim">~30¢ once · ~0.1¢ a payment · 0% to Amply</p>
      {!restoring ? (
        <div class="row">
          <button class="btn-primary" onClick={make} disabled={busy}>{busy ? "…" : "Make my wallet"}</button>
          <button class="pill" onClick={() => setRestoring(true)}><Icon.key size={15} /> I have a key</button>
        </div>
      ) : (
        <>
          <textarea class="input mono" rows="3" value={backup} placeholder="Paste your backup key"
            aria-label="Backup key" onInput={(e) => setBackup(e.target.value)} />
          <div class="row">
            <button class="btn-primary" onClick={restore} disabled={busy || !backup.trim()}>Restore</button>
            <button class="pill" onClick={() => setRestoring(false)}>Back</button>
          </div>
        </>
      )}
      <a class="link-dim" href="/paying" target="_blank" rel="noopener"><Icon.help size={15} /> How it works</a>
      {error && <p class="note-line warn-ink" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Getting money in. Three ticks that fill in as money arrives; the last step
 * is one tap (a Solana Pay link) once the wallet exists on the network, and by
 * hand the first time, because a request can't reach an account that doesn't
 * exist yet.
 */
export function TopUp({ address, balance, network }) {
  const [qr, setQr] = useState(null);
  const hasDollars = balance?.usdc > 0;
  const hasFee = balance?.sol > 0.001;
  const tick = (done, n) => <span class={`tick${done ? " done" : ""}`}>{done ? <Icon.check size={13} /> : n}</span>;

  async function showQr(e) {
    if (!e.currentTarget.open || qr) return;
    const { renderSVG } = await import("uqr");
    setQr({
      dollars: renderSVG(transferRequest(address, DOLLAR_AMOUNTS[0], { mint: network.usdc })),
      fee: renderSVG(transferRequest(address, FEE_SOL)),
    });
  }

  if (!network.real) {
    return <p class="dim">Test network — use a faucet for test USDC and SOL.</p>;
  }

  return (
    <div class="stack">
      <ol class="setup">
        <li>{tick(hasDollars || hasFee, 1)}<div>
          <b>Phantom</b> <a class="link-dim" href="https://phantom.com" target="_blank" rel="noopener">phantom.com <Icon.external size={13} /></a>
        </div></li>
        <li>{tick(hasDollars && hasFee, 2)}<div>
          <b>Buy USDC + ~$1 SOL</b>
          <span class="dim small">Pick USDC itself — not "Cash". Always the Solana network.</span>
        </div></li>
        <li>{tick(hasDollars && hasFee, 3)}{!balance ? <div><b>Send it here</b></div> : !oneTapReady(balance) ? (
          <div class="stack">
            <b>Send it here — by hand, first time</b>
            <p class="mono-box">{address}</p>
            <Copy text={address} label="Copy address" />
            <span class="dim small">In Phantom: Send → SOL → $1, then Send → USDC.</span>
          </div>
        ) : (
          <div class="stack">
            <b>One tap</b>
            <div class="row">
              {DOLLAR_AMOUNTS.map((n) => (
                <a key={n} class="btn-primary sm" href={transferRequest(address, n, { mint: network.usdc })}>${n}</a>
              ))}
              <a class="pill" href={transferRequest(address, FEE_SOL)}>{FEE_SOL} SOL</a>
            </div>
          </div>
        )}</li>
      </ol>

      {oneTapReady(balance) && (
        <details class="more" onToggle={showQr}>
          <summary><Icon.qr size={15} /> Scan instead</summary>
          {qr ? (
            <div class="qr-pair">
              <figure><div class="qr" dangerouslySetInnerHTML={{ __html: qr.dollars }} /><figcaption>${DOLLAR_AMOUNTS[0]} USDC</figcaption></figure>
              <figure><div class="qr" dangerouslySetInnerHTML={{ __html: qr.fee }} /><figcaption>{FEE_SOL} SOL</figcaption></figure>
            </div>
          ) : <p class="dim">…</p>}
        </details>
      )}
      <details class="more">
        <summary><Icon.copy size={15} /> Address</summary>
        <p class="mono-box">{address}</p>
        <Copy text={address} />
      </details>
    </div>
  );
}

/** Getting money back out: dollars first, then the SOL that paid their fee. */
export function SendBack({ pair, balance, onRefresh }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const short = (a) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

  async function go(everything) {
    const where = to.trim();
    if (!where) return setSaid({ bad: true, text: "Paste an address first." });
    if (!(await ask({ title: `Send ${everything ? "everything" : "all the dollars"}?`, body: `To ${short(where)}. This can't be undone.`, confirm: "Send", danger: true }))) return;
    setBusy(true); setSaid(null);
    try {
      const { pay } = await machinery();
      const sent = [];
      if (balance?.usdc > 0) { await pay.sendDollarsOut(pair, where, "all"); sent.push(money(balance.usdc)); }
      if (everything) { await pay.sendSolOut(pair, where); sent.push("SOL"); }
      setSaid({ text: sent.length ? `Sent ${sent.join(" + ")}` : "Nothing to send." });
      onRefresh?.();
    } catch (e) {
      setSaid({ bad: true, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="stack">
      <input class="input mono" type="text" value={to} placeholder="Solana address (Phantom → Receive)"
        aria-label="Send to" onInput={(e) => setTo(e.target.value)} autocomplete="off" spellcheck={false} />
      <div class="row">
        <button class="btn-primary" disabled={busy} onClick={() => go(false)}>Send dollars</button>
        <button class="pill" disabled={busy} onClick={() => go(true)}>Send everything</button>
      </div>
      <p class="mono-dim">"Everything" includes the SOL — then nothing can be paid until you top up.</p>
      {said && <p class={`note-line${said.bad ? " warn-ink" : ""}`} role="status">{said.text}</p>}
    </div>
  );
}
