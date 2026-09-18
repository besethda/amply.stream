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
      throw new Error(detail.slice(0, 200) || `The node returned ${res.status}.`);
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
    async deleteObject(key) {
      await req("DELETE", `/${key}`);
    },
  };
}
