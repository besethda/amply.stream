import { render } from "preact";
import { App } from "./app.jsx";
import { applyTheme } from "./looks.js";

// Before the first paint, so a dark app doesn't flash white.
applyTheme();
// The fonts, added here rather than in the page's head, where their
// stylesheet would hold up the first paint (and the logo) on a slow
// connection. The logo waits for them a moment instead (splash.js).
const fonts = document.createElement("link");
fonts.rel = "stylesheet";
fonts.href = "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap";
document.head.appendChild(fonts);
render(<App />, document.getElementById("app"));

// Only so the app can be installed to a home screen and opened offline. It
// caches this app's own shell and nothing else: no artist's audio, no
// manifests, nothing that would amount to Amply holding a copy of anyone's
// music.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/app/sw.js").catch(() => {}));
}
