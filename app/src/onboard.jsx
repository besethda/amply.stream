/**
 * Your ID: the first time a listener wants something that costs money.
 *
 * A screen of its own, like signing in on any site: nothing else on it, a
 * back button, and one thing to do per step. There's no account; the "ID" is
 * the wallet, made here and saved by the listener, because nobody else can
 * keep a copy. So saving it is the step, not a footnote:
 *
 *   1. Save your ID: with Face ID or a passkey (the phone's keychain keeps it
 *      and brings it to their other devices), or by hand, behind a warning
 *      and an "I've saved it". A wallet made by hand isn't kept on this device
 *      until they say so.
 *   2. Add money, when what they're about to do needs some.
 *
 * Then whatever they were doing carries on. Already have one? Their passkey,
 * or the saved key, brings it back.
 */
import { useState, useEffect } from "preact/hooks";
import { machinery, markBackupSaved, backupSaved } from "./paying.js";
import { mayOfferPasskey, createPasskeySeed, restorePasskeySeed, NoPasskeySecret } from "../../spec/passkey-wallet.mjs";
import { Copy, Hint, TopUp } from "./wallet-ui.jsx";
import { Icon } from "./icons.jsx";

const isPhone = () => /iPhone|iPad|Android/i.test(navigator.userAgent || "");

/**
 * `pair` is a wallet already on this device, if any (an older one, not yet
 * saved). `needsMoney`: end with adding money. `onDone(pair)` when finished;
 * `onClose()` for back on the first step.
 */
export function Onboard({ pair: existing = null, needsMoney = false, balance = null, network, onPair, onDone, onClose }) {
  const saved = existing && backupSaved(existing.publicKey.toBase58());
  const [step, setStep] = useState(existing && !saved ? "manual" : existing ? "money" : "id");
  const [pair, setPair] = useState(existing);
  const [passkey, setPasskey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { mayOfferPasskey().then(setPasskey); }, []);

  // Saved: on to money if it's needed, else done.
  const ready = (p) => {
    setPair(p);
    onPair?.(p);
    if (needsMoney && !(balance?.usdc > 0)) setStep("money");
    else onDone(p);
  };

  async function run(fn) {
    setBusy(true); setError(null);
    try { ready(await fn()); }
    catch (e) {
      if (e instanceof NoPasskeySecret) setError(isPhone()
        ? "This phone's passkeys can't hold an ID yet. Save it yourself instead."
        : "This computer's passkey can't hold an ID. Try again and pick your phone, or save it yourself.");
      else if (e?.name !== "Cancelled" && e?.name !== "NotAllowedError") setError(e?.message || "That didn't work. Try again.");
    } finally { setBusy(false); }
  }
  const viaPasskey = (seedFn) => run(async () => {
    const seed = await seedFn();
    const p = (await machinery()).wallet.adoptSeed(seed);
    markBackupSaved(p.publicKey.toBase58());   // the passkey is the backup
    return p;
  });

  const back = () => {
    setError(null);
    if (step === "id" || (step === "manual" && existing) || (step === "money" && existing && saved)) onClose();
    else if (step === "money") onDone(pair);
    else setStep("id");
  };

  return (
    <div class="onboard" role="dialog" aria-modal="true" aria-label="Your ID">
      <button class="onboard-back" onClick={back} aria-label="Back"><Icon.back size={20} /></button>
      <div class="onboard-body">
        {step === "id" && (
          <>
            <div class="onboard-icon"><Icon.key size={26} /></div>
            <h1>Save your ID <Hint label="What's my ID?">Your ID is how artists know it's you, and it holds the
              money you pay them with. It lives only on your devices: nobody, Amply included, can recover it for
              you. So save it once, and you can use it anywhere.</Hint></h1>
            {passkey && (
              <button class="btn-primary wide" onClick={() => viaPasskey(createPasskeySeed)} disabled={busy}>
                {busy ? "…" : isPhone() ? "Save with Face ID" : "Save with a passkey"}
              </button>
            )}
            <button class={passkey ? "btn-quiet-solid wide" : "btn-primary wide"} onClick={() => { setError(null); setStep("manual"); }} disabled={busy}>
              Save it myself
            </button>
            <button class="btn-quiet" onClick={() => { setError(null); setStep("restore"); }}>I already have one</button>
          </>
        )}

        {step === "manual" && <SaveByHand existing={existing} onSaved={ready} />}

        {step === "restore" && <Restore passkey={passkey} busy={busy}
          onPasskey={() => viaPasskey(restorePasskeySeed)}
          onKey={(key) => run(async () => {
            const p = (await machinery()).wallet.restoreWallet(key);
            markBackupSaved(p.publicKey.toBase58());   // pasted from somewhere, so saved somewhere
            return p;
          })} />}

        {step === "money" && pair && (
          <>
            <h1>Add money</h1>
            <TopUp address={pair.publicKey.toBase58()} balance={balance} network={network} />
            <button class="btn-quiet" onClick={() => onDone(pair)}>{balance?.usdc > 0 ? "Done" : "Later"}</button>
          </>
        )}

        {error && <p class="note-line warn-ink" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** The key, shown once, with a warning; kept only once they say it's saved. */
function SaveByHand({ existing, onSaved }) {
  const [pair, setPair] = useState(existing);
  const [key, setKey] = useState(null);
  const [kept, setKept] = useState(false);
  const [sure, setSure] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    (async () => {
      const { wallet } = await machinery();
      // A new one isn't stored on this device yet: only once it's saved.
      const p = existing || wallet.generateWallet();
      setPair(p);
      setKey(wallet.backupOf(p));
    })().catch((e) => setError(e.message));
  }, []);

  async function done() {
    try {
      const { wallet } = await machinery();
      if (!existing) wallet.keepWallet(pair);
      markBackupSaved(pair.publicKey.toBase58());
      onSaved(pair);
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      <h1>Save your ID</h1>
      <p class="note-line warn-ink"><Icon.warn size={15} /> If you lose it, it can't be recovered.</p>
      {key && <p class="mono-box secret">{key}</p>}
      <div class="row">
        {typeof navigator !== "undefined" && navigator.share && (
          <button class="pill" onClick={() => navigator.share({ title: "My Amply ID", text: key }).then(() => setKept(true), () => {})}>
            <Icon.send size={15} /> Save to Notes…
          </button>
        )}
        {key && <Copy text={key} onCopied={() => setKept(true)} />}
      </div>
      <label class="buy-check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>I've saved it somewhere safe</span>
      </label>
      <button class="btn-primary wide" onClick={done} disabled={!key || !kept || !sure}>Continue</button>
      {!kept && <p class="dim small">Copy it or save it first.</p>}
      {error && <p class="note-line warn-ink" role="alert">{error}</p>}
    </>
  );
}

function Restore({ passkey, busy, onPasskey, onKey }) {
  const [key, setKey] = useState("");
  return (
    <>
      <h1>Welcome back</h1>
      {passkey && <button class="btn-primary wide" onClick={onPasskey} disabled={busy}>{isPhone() ? "Use Face ID" : "Use my passkey"}</button>}
      <textarea class="input mono" rows="3" value={key} placeholder="Or paste your saved ID"
        aria-label="Your saved ID" onInput={(e) => setKey(e.target.value)} />
      <button class={passkey ? "btn-quiet-solid wide" : "btn-primary wide"} onClick={() => onKey(key.trim())} disabled={busy || !key.trim()}>Continue</button>
    </>
  );
}
