/**
 * Talking to the artist's own node.
 *
 * No tokens, no relay, no Cloudflare API. Cloudflare Access has already
 * authenticated the browser and sets a cookie, so these are plain same-origin
 * requests to endpoints the node exposes under /manage.
 *
 * This is the whole point of the self-hosted editor: nothing of Amply's is
 * involved in an artist editing their own music.
 */
export function nodeApi() {
  const base = location.origin;

  async function req(method, path, { body, headers } = {}) {
    const res = await fetch(`${base}/manage${path}`, {
      method,
      headers,
      body,
      credentials: "same-origin", // the Access cookie
    });
    if (res.status === 401) {
      throw new Error("Your sign-in expired. Reload the page to sign in again.");
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // The server says why in {"error": "..."}; show the words, not the JSON.
      let said = detail;
      try { said = JSON.parse(detail)?.error || detail; } catch { /* plain text */ }
      throw new Error(String(said).slice(0, 300) || `Your streaming service returned ${res.status}.`);
    }
    return res;
  }

  return {
    async whoami() {
      return (await req("GET", "/whoami")).json();
    },
    async readManifest() {
      const res = await fetch(`${base}/manifest.json`, { cache: "no-store" });
      if (!res.ok) return null;
      return res.json().catch(() => null);
    },
    async writeManifest(manifest) {
      await req("PUT", "/manifest", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest, null, 2),
      });
    },
    async putObject(key, file) {
      await req("PUT", `/${key}`, {
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
    },
    /** A published file's size in bytes, or null. Same origin, so the
     *  Access cookie rides along and every header is readable. */
    async sizeOf(url) {
      const res = await fetch(url, { method: "HEAD", credentials: "same-origin" });
      if (!res.ok) return null;
      return Number(res.headers.get("Content-Length")) || null;
    },
    /** Who has been listening, and how much. A ledger, never a history. */
    async listeners() {
      return (await req("GET", "/listeners")).json();
    },

    /** Stop serving a wallet, or start again. */
    async setBlocked(pubkey, blocked) {
      await req("POST", "/block", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, blocked }),
      });
    },

    /** What subscriptions this service sells, if any. Never the Stripe key. */
    async stripeStatus() {
      return (await req("GET", "/stripe")).json();
    },

    /** Connect the artist's Stripe account, or change the plans. The key may
     *  be left out when changing plans: the server keeps the one it has. */
    async connectStripe(key, plans) {
      return (await req("POST", "/stripe/connect", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key || undefined, plans }),
      })).json();
    },

    /** Links in the artist's Stripe for the songs and albums they sell; the
     *  key only when connecting for this alone. Returns { sales: [{ item, url }] }. */
    async stripeSales(key, items) {
      return (await req("POST", "/stripe/sales", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key || undefined, items }),
      })).json();
    },

    async disconnectStripe() {
      await req("POST", "/stripe/disconnect", { headers: { "Content-Type": "application/json" }, body: "{}" });
    },

    /** Delete a wallet's record outright, including any bar on it. */
    async removeListener(pubkey) {
      await req("POST", "/remove", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey }),
      });
    },

    async deleteObject(key) {
      await req("DELETE", `/${key}`);
    },
  };
}
