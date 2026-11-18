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
import { transferRequest, DOLLAR_AMOUNTS, oneTapReady, topupUrl, CARD_AMOUNTS, CASH_APP } from "./topup.js";
import { mayOfferPasskey, createPasskeySeed, restorePasskeySeed, NoPasskeySecret } from "../../spec/passkey-wallet.mjs";

/** What this device's passkey is called, for the button. */
const isPhone = () => /iPhone|iPad|Android/i.test(navigator.userAgent || "");
import { Icon } from "./icons.jsx";
import { ask } from "./sheets.jsx";

export const money = (usd) =>
  usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `${Number((usd * 100).toFixed(2))}¢`;

export function Copy({ text, label = "Copy", onCopied }) {
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
      onCopied?.();
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
  const [kept, setKept] = useState(false);   // copied or shared somewhere, at least once

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
      <p class="dim">Your money lives on this phone, and this key is the only way back to it.
      Save it in your Notes or password manager, somewhere private. You'll also need it to use
      Amply on another device.</p>
      <p class="note-line warn-ink"><Icon.warn size={15} /> {onHomeScreen()
        ? "Deleting this app deletes the wallet. Without the key, the money in it is gone."
        : "Clearing your browser's data deletes the wallet. Without the key, the money in it is gone."}</p>
      {key ? (
        <>
          <p class="mono-box secret">{key}</p>
          <div class="row">
            {typeof navigator !== "undefined" && navigator.share && (
              <button class="pill" onClick={() => navigator.share({ title: "My Amply backup key", text: key }).then(() => setKept(true), () => {})}>
                <Icon.send size={15} /> Save to Notes…
              </button>
            )}
            <Copy text={key} onCopied={() => setKept(true)} />
            <button class="btn-primary" onClick={done} disabled={!kept}>{cta}</button>
          </div>
          {!kept && <p class="dim small">Copy it or save it first, then paste it somewhere private.</p>}
          <div>
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
  const [passkey, setPasskey] = useState(false);     // offer Face ID and the like?
  const [noSecret, setNoSecret] = useState(false);   // this device's passkey couldn't
  useEffect(() => { mayOfferPasskey().then(setPasskey); }, []);

  async function run(fn) {
    setBusy(true); setError(null);
    try { onMade(await fn()); }
    catch (e) {
      if (e instanceof NoPasskeySecret) setNoSecret(true);
      else if (e.name !== "Cancelled") setError(e.message);
    }
    finally { setBusy(false); }
  }
  const make = () => run(async () => (await machinery()).wallet.createWallet());
  const viaPasskey = (seedFn) => run(async () => {
    const seed = await seedFn();
    const pair = (await machinery()).wallet.adoptSeed(seed);
    markBackupSaved(pair.publicKey.toBase58());   // the passkey is the backup
    return pair;
  });
  const restore = () => run(async () => {
    const pair = (await machinery()).wallet.restoreWallet(backup);
    markBackupSaved(pair.publicKey.toBase58());   // pasted from somewhere, so saved somewhere
    return pair;
  });

  return (
    <div class="panel stack">
      <h2>Pay as you listen</h2>
      <ol class="steps">
        <li><Icon.key size={18} /> Make a wallet: a pocket for money, kept on this phone. One tap, nothing to sign up for.</li>
        <li><Icon.card size={18} /> Add a few dollars. At ½¢ a minute, a common price, $10 is about 33 hours of listening.</li>
        <li><Icon.send size={18} /> Listen. Artists are paid straight from it as you go.</li>
      </ol>
      <p class="dim small">Artists keep everything except small card and network fees. Amply takes nothing.</p>
      {noSecret && (
        <div class="note-box stack" role="alert">
          <b>This device's passkey can't hold a wallet yet.</b>
          <span class="dim small">{isPhone()
            ? "Set up with a backup code instead. It works the same; just keep the code somewhere safe."
            : <>Try again and choose <b>Use a phone</b> (or your phone's name) in the window that appears: your
              phone's Face ID or fingerprint will do it. Or set up with a backup code.</>}</span>
        </div>
      )}
      {!restoring ? (
        <div class="stack">
          {passkey && (
            <>
              <button class="btn-primary" onClick={() => viaPasskey(createPasskeySeed)} disabled={busy}>
                {busy ? "…" : isPhone() ? "Make my wallet with Face ID or fingerprint" : "Make my wallet with a passkey"}
              </button>
              <span class="dim small">{isPhone()
                ? "No recovery words. Your phone's keychain keeps it, and it works on your other devices too."
                : "Uses Touch ID, Windows Hello, or your phone: pick whichever your computer offers. No recovery words."}</span>
            </>
          )}
          <div class="row">
            <button class={passkey ? "pill" : "btn-primary"} onClick={make} disabled={busy}>
              {passkey ? "Use a backup code instead" : busy ? "…" : "Make my wallet"}
            </button>
            {passkey && <button class="pill" onClick={() => viaPasskey(restorePasskeySeed)} disabled={busy}><Icon.key size={15} /> I've used Amply before</button>}
            <button class="pill" onClick={() => setRestoring(true)}><Icon.key size={15} /> I have a backup code</button>
          </div>
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
/** A "?" that shows its explanation only when tapped: short screens, detail on request. */
export function Hint({ label = "More about this", children }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" class={`hint-q${open ? " on" : ""}`} aria-expanded={open} aria-label={label}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>?</button>
      {open && <span class="dim small hint-text">{children}</span>}
    </>
  );
}

export function TopUp({ address, balance, network }) {
  const [cashQr, setCashQr] = useState(null);
  const [qr, setQr] = useState(null);

  async function showCashQr(e) {
    if (!e.currentTarget.open || cashQr) return;
    const { renderSVG } = await import("uqr");
    setCashQr(renderSVG(address));
  }
  async function showQr(e) {
    if (!e.currentTarget.open || qr) return;
    const { renderSVG } = await import("uqr");
    setQr(renderSVG(transferRequest(address, DOLLAR_AMOUNTS[0], { mint: network.usdc })));
  }

  if (!network.real) {
    return <p class="dim">Test network — use a faucet for test USDC.</p>;
  }

  return (
    <div class="stack">
      <section class="choice stack">
        <b>Add money by card</b>
        <span class="dim small">On Stripe's secure page. Your wallet ends in <b class="mono">{address.slice(-4)}</b>:
          Stripe's page shows the same.{" "}
          <Hint label="How paying by card works">If Stripe asks where to send it, paste your address; if it asks for
            a network, choose <b>Solana</b>. The first time, Stripe may ask for ID: that's Stripe's own check. At ½¢
            a minute, a common price, $10 is about 33 hours of listening.</Hint></span>
        <div class="row">
          {CARD_AMOUNTS.map((n) => (
            <a key={n} class={n === 20 ? "btn-primary sm" : "pill"} href={topupUrl(address, { amount: n })}
              target="_blank" rel="noopener noreferrer">${n}</a>
          ))}
        </div>
      </section>

      <details class="choice more" onToggle={showCashQr}>
        <summary>Cash App <span class="dim small">· US · no fee right now</span></summary>
        <span class="dim small">Copy your address, then pay it in Cash App.{" "}
          <Hint label="How Cash App works">In Cash App, go to <b>Pay</b>, paste the address in the search box,
            enter an amount and pay. It arrives here in a minute or so. Needs your ID verified in Cash App. Not
            available in New York.</Hint></span>
        <div class="row">
          <Copy text={address} label="Copy address" />
          <a class="pill" href={CASH_APP} target="_blank" rel="noopener noreferrer">Open Cash App <Icon.external size={13} /></a>
        </div>
        {cashQr && (
          <figure class="cash-qr">
            <div class="qr" dangerouslySetInnerHTML={{ __html: cashQr }} />
            <figcaption class="dim small">On a computer? Scan this with your phone instead of pasting.</figcaption>
          </figure>
        )}
      </details>

      <details class="more">
        <summary>Already use a crypto wallet?</summary>
        <span class="dim small">Send <b>USDC</b> on the <b>Solana</b> network to:</span>
        <p class="mono-box">{address}</p>
        <div class="row">
          <Copy text={address} label="Copy address" />
          {oneTapReady(balance) && DOLLAR_AMOUNTS.map((n) => (
            <a key={n} class="pill" href={transferRequest(address, n, { mint: network.usdc })}>${n} in one tap</a>
          ))}
        </div>
        {oneTapReady(balance) && (
          <details class="more" onToggle={showQr}>
            <summary><Icon.qr size={15} /> Scan instead</summary>
            {qr ? <figure><div class="qr" dangerouslySetInnerHTML={{ __html: qr }} /><figcaption>${DOLLAR_AMOUNTS[0]} USDC</figcaption></figure>
              : <p class="dim">…</p>}
          </details>
        )}
      </details>
    </div>
  );
}

/** Getting money back out: dollars first, then the SOL that paid their fee. */
export function SendBack({ pair, balance, onRefresh, nodes = [] }) {
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
      if (balance?.usdc > 0) {
        const r = await pay.sendDollarsOut(pair, where, "all", { nodes });
        sent.push(money(r.micros / 1e6));
        if (r.fee) sent.push(`${money(r.fee / 1e6)} fee to the artist who paid the network fee`);
      }
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
        {/* Only an older wallet that once held SOL for fees has any to send. */}
        {balance?.sol > 0.001 && <button class="pill" disabled={busy} onClick={() => go(true)}>Send everything</button>}
      </div>
      {said && <p class={`note-line${said.bad ? " warn-ink" : ""}`} role="status">{said.text}</p>}
    </div>
  );
}
