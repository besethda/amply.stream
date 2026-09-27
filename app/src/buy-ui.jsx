/**
 * Buying, on screen: the sheet that buys a song or an album, and the list of
 * what's been bought, under You. The work is in buy.js and app.jsx.
 */
import { useState, useEffect } from "preact/hooks";
import { Icon } from "./icons.jsx";
import { money } from "./wallet-ui.jsx";
import { nameOf } from "./screens.jsx";
import { originOf } from "./identify.js";
import { offersOf, purchases } from "./buy.js";

/**
 * Buy an album or a song: by card on Stripe's page, or in USDC from the
 * wallet — whichever the artist takes. The buyer agrees, before anything
 * starts, that the download begins at once (which ends the right to return
 * it), and may make it a gift.
 */
export function BuyForm({ offer, onCard, onWallet }) {
  const [agree, setAgree] = useState(false);
  const [gift, setGift] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = (fn) => async () => { if (!agree || busy) return; setBusy(true); try { await fn(gift); } finally { setBusy(false); } };
  return (
    <div class="buy stack">
      <div class="buy-price"><b>{money(offer.price)}</b><span class="mono-dim">{offer.kind === "album" ? `${offer.tracks.length} songs` : "song"} · yours to keep</span></div>
      <label class="buy-check">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>Start the download straight away. I understand I can't return it once it has started.</span>
      </label>
      <label class="buy-gift">
        <span class="t"><b>It's a gift</b><span class="dim">You'll get a link to send.</span></span>
        <input type="checkbox" role="switch" checked={gift} onChange={(e) => setGift(e.target.checked)} aria-label="It's a gift" />
      </label>
      {offer.card && (
        <button class="btn-primary wide" disabled={!agree || busy} onClick={go(onCard)}>
          <Icon.card size={16} /> Pay by card
        </button>
      )}
      {offer.wallet && (
        <button class={`${offer.card ? "btn-quiet-solid" : "btn-primary"} wide`} disabled={!agree || busy} onClick={go(onWallet)}>
          {busy && !offer.card ? "Paying…" : `Pay ${money(offer.price)} in USDC`}
        </button>
      )}
      <p class="mono-dim small center">Paid to the artist directly. Amply takes nothing.</p>
    </div>
  );
}

/**
 * What this wallet has bought, artist by artist, as each artist's server
 * records it: which songs are on this phone, which can be downloaded again
 * (and how many times), and gifts nobody has claimed yet.
 */
export function Purchases({ pair, entries, owned, onDownload, onShareGift, onOpenArtist }) {
  const sellers = entries.filter((e) => offersOf(e).length);
  const [lists, setLists] = useState({});      // url → purchases, or { error }
  const [busy, setBusy] = useState(null);
  const load = (e) => purchases(pair, originOf(e.url))
    .then((p) => setLists((l) => ({ ...l, [e.url]: p })))
    .catch((err) => setLists((l) => ({ ...l, [e.url]: { error: err.message } })));
  useEffect(() => { if (pair) sellers.forEach(load); }, [pair, sellers.map((e) => e.url).join("|")]);

  if (!pair) return <p class="dim">Purchases belong to a wallet. Set one up under You, or restore yours with its backup key.</p>;
  if (!sellers.length) return <p class="dim">None of the artists you follow sell their music here yet.</p>;

  const titleOf = (e, id) => {
    for (const r of e.manifest.releases || []) {
      if (r.id === id) return { title: r.title, tracks: (r.tracks || []).map((t) => ({ id: t.id, title: t.title })) };
      const t = (r.tracks || []).find((x) => x.id === id);
      if (t) return { title: t.title, tracks: [{ id: t.id, title: t.title }] };
    }
    return { title: "Something no longer listed", tracks: [] };
  };

  const shown = sellers.filter((e) => { const p = lists[e.url]; return !p || p.error || p.owned?.length || p.gifts?.length; });
  if (Object.keys(lists).length === sellers.length && !shown.length) return <p class="dim">Nothing bought yet. Albums and songs for sale show a price.</p>;

  return (
    <div class="stack">
      {shown.map((e) => {
        const p = lists[e.url];
        return (
          <section class="bought" key={e.url}>
            <button class="bought-artist" onClick={() => onOpenArtist(e.url)}><b>{nameOf(e)}</b><Icon.chevron size={14} /></button>
            {!p && <p class="mono-dim small">Asking…</p>}
            {p?.error && <p class="warn-ink small">{p.error}</p>}
            {p?.owned?.map((s) => {
              const it = titleOf(e, s.item);
              return (
                <div class="bought-item" key={s.ref}>
                  <span class="bought-title">{it.title}</span>
                  {it.tracks.map((t) => {
                    const here = owned.has(`${e.url}#${t.id}`);
                    const left = p.limit - (s.downloads?.[t.id] || 0);
                    return (
                      <div class="bought-track" key={t.id}>
                        <span class="t">{t.title}</span>
                        {here ? <span class="badge">owned</span>
                          : left > 0
                            ? <button class="pill sm" disabled={busy === `${s.ref}#${t.id}`}
                                onClick={async () => { setBusy(`${s.ref}#${t.id}`); try { await onDownload(e, [t.id]); await load(e); } finally { setBusy(null); } }}>
                                <Icon.downSmall size={13} /> {left} left
                              </button>
                            : <span class="mono-dim small">no downloads left</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {p?.gifts?.map((s) => (
              <div class="bought-item gift" key={s.ref}>
                <span class="bought-title">{titleOf(e, s.item).title}</span>
                <div class="bought-track">
                  <span class="t dim">A gift, not claimed yet</span>
                  <button class="pill sm" onClick={() => onShareGift(e, s.gift, titleOf(e, s.item).title)}><Icon.share size={13} /> Send</button>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
