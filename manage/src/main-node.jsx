/**
 * The editor, running on the artist's own node.
 *
 * This is the default. Cloudflare Access has already authenticated the browser
 * before this file was served, so there is no sign-in step here and no token to
 * manage. Amply is not involved at all: this page, the audio, the manifest and
 * the person editing them are all on infrastructure the artist owns.
 */
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { Editor, Banner } from "./ui.jsx";
import { nodeApi } from "./node-api.js";
import { takeCoinbaseAnswer } from "./coinbase.js";

const api = nodeApi();

// Back from Connect Coinbase in the window it opened: hand the answer to the
// editor that asked (it's listening), and close. If this is that editor's own
// tab (no new window was allowed), it carries on and reads the answer itself.
if (takeCoinbaseAnswer()) window.close();

function App() {
  const [state, setState] = useState({ phase: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const [who, manifest] = await Promise.all([api.whoami(), api.readManifest()]);
        setState({
          phase: "ready",
          who,
          // A node with no manifest has never published. The editor says so
          // rather than claiming everything is live.
          published: manifest !== null,
          manifest: manifest || {
            amply: 1,
            updated: new Date().toISOString(),
            artist: { name: location.host.split(".")[0] },
            content: { explicit: false },
            payment: [],
            releases: [],
          },
        });
      } catch (e) {
        setState({ phase: "error", error: e.message });
      }
    })();
  }, []);

  if (state.phase === "loading") return <p class="lead">Loading your music…</p>;

  if (state.phase === "error") {
    return (
      <section class="card">
        <h1>Couldn't load</h1>
        <Banner kind="error">{state.error}</Banner>
        <p class="muted">
          If this keeps happening, your streaming service may need setting up again at{" "}
          <a href="https://amply.stream/start">amply.stream/start</a>.
        </p>
      </section>
    );
  }

  return (
    <Editor
      api={api}
      // Shared as the artist's own domain once they have attached one; the
      // editor itself always lives at the workers.dev address.
      // Only ever an https address: it becomes a link, and a link can run script.
      node={{ slug: location.host.split(".")[0], url: /^https:\/\/[^\s"<>]+$/.test(state.who?.home || "") ? state.who.home : location.origin }}
      initial={state.manifest}
      published={state.published}
      version={state.who?.version || null}
      // Opened with the key from before signup: no Cloudflare sign-in to leave.
      temporary={state.who?.temporary || null}
      onSignOut={state.who?.temporary ? undefined : () => location.assign("/cdn-cgi/access/logout")}
    />
  );
}

render(<App />, document.getElementById("app"));
