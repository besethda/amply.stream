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
import { transferRequest, DOLLAR_AMOUNTS, FEE_SOL, oneTapReady, topupUrl, CARD_AMOUNTS, COINBASE_AMOUNTS, coinbaseOffered, coinbaseLink, CASH_APP } from "./topup.js";
import { signText } from "./identify.js";
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
function Hint({ label = "More about this", children }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" class={`hint-q${open ? " on" : ""}`} aria-expanded={open} aria-label={label}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>?</button>
      {open && <span class="dim small hint-text">{children}</span>}
    </>
  );
}

export function TopUp({ address, balance, network, pair, needsFee = true }) {
  const [qr, setQr] = useState(null);
  const [coinbase, setCoinbase] = useState(false);       // set up on the relay?
  const [opening, setOpening] = useState(null);           // the amount being opened
  const [said, setSaid] = useState(null);
  const [cashQr, setCashQr] = useState(null);
  useEffect(() => { coinbaseOffered().then(setCoinbase); }, []);

  /** Open Coinbase with everything filled in. The window opens on the tap, so
   *  no pop-up blocker stops it, and is pointed at Coinbase once the relay
   *  has the session. */
  async function viaCoinbase(amount) {
    setSaid(null); setOpening(amount);
    const w = window.open("", "_blank");
    try {
      const url = await coinbaseLink(address, amount, (text) => signText(pair, text));
      if (w) { w.opener = null; w.location.href = url; } else location.href = url;
    } catch (e) {
      w?.close();
      setSaid(e.message);
    } finally { setOpening(null); }
  }

  async function showCashQr(e) {
    if (!e.currentTarget.open || cashQr) return;
    const { renderSVG } = await import("uqr");
    setCashQr(renderSVG(address));
  }
  const hasDollars = balance?.usdc > 0;
  // Where every artist followed pays its listeners' network fees, there's no
  // SOL to add: the step isn't shown at all.
  const hasFee = balance?.sol > 0.001 || !needsFee;
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
      <div class="stack">
        <div class="row two-steps">
          <span class={`tick${hasDollars ? " done" : ""}`}>{hasDollars ? <Icon.check size={13} /> : 1}</span> Dollars
          {needsFee && <><span class={`tick${hasFee ? " done" : ""}`}>{hasFee ? <Icon.check size={13} /> : 2}</span> $1 for fees, once</>}
        </div>
        <b>Add money</b>
        <span class="dim small">Use whichever you already have. Amply never sees your bank or card details.</span>

        {coinbase && (
          <section class="choice stack">
            <b>Coinbase <span class="dim small">· most countries</span> <Hint label="About Coinbase">Opens Coinbase
              with everything filled in. About 0.5% from a bank, 2.5% by card. You'll need a Coinbase account;
              it's free.</Hint></b>
            <div class="row">
              {COINBASE_AMOUNTS.map((n) => (
                <button key={n} class={n === 30 ? "btn-primary sm" : "pill"} disabled={opening !== null}
                  onClick={() => viaCoinbase(n)}>{opening === n ? "Opening…" : `$${n}`}</button>
              ))}
            </div>
            {said && <p class="note-line warn-ink small" role="alert">{said}</p>}
          </section>
        )}

        <details class="choice more" onToggle={showCashQr}>
          <summary>Cash App <span class="dim small">· US</span></summary>
          <span class="dim small">Copy your address, then pay it in Cash App.{" "}
            <Hint label="How Cash App works">In Cash App, go to <b>Pay</b>, paste the address in the search box,
              enter an amount and pay. Cash App sends it as digital dollars (USDC) for you, and it arrives here in a
              minute or so. Free while Cash App's offer lasts. Not available in New York.</Hint></span>
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

        <details class="choice more" open={!coinbase}>
          <summary>Card <span class="dim small">· US</span></summary>
        <span class="dim small">Pick an amount and pay on Stripe's page.{" "}
          <Hint label="How paying by card works">Stripe's secure page opens. If it asks where to send it, paste your
            address; if it asks for a network, choose <b>Solana</b>. The first time, Stripe may ask for ID: that's
            Stripe's own check, not Amply's, and takes a couple of minutes. At ½¢ a minute, a common price, $10 is
            about 33 hours of listening.</Hint></span>
        <div class="row">
          {CARD_AMOUNTS.map((n) => (
            <a key={n} class={n === 20 ? "btn-primary sm" : "pill"} href={topupUrl(address, { amount: n })}
              target="_blank" rel="noopener noreferrer">${n}</a>
          ))}
        </div>
        </details>
        {!hasFee && (
          <div class="stack">
            <b>{hasDollars ? "One last thing: $1 for fees" : "Then, once: $1 for fees"}{" "}
              <Hint label="About the fee">Each payment has a tiny network fee, paid in a coin called SOL. A one-off
                $1 covers thousands of payments. Same steps, on the same Stripe page.</Hint></b>
            <div class="row">
              <a class={hasDollars ? "btn-primary sm" : "pill"} href={topupUrl(address, { currency: "sol" })}
                target="_blank" rel="noopener noreferrer">Add $1 for fees <Icon.external size={13} /></a>
            </div>
          </div>
        )}
      </div>

      <details class="more">
        <summary>Already use a crypto wallet? Send from it instead</summary>
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

      </details>

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
