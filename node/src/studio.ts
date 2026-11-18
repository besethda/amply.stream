/**
 * The editor as an app on the artist's Home Screen: its manifest and icons.
 *
 * Served by the streaming service itself, outside /manage and its sign-in:
 * they say nothing about anyone (a name, colours, a logo), and the editor must
 * keep working even if amply.stream is gone, so nothing here points there.
 */
// The editor's own icon: the logo on black, so it's told apart from the
// listening app (orange on white) on an artist's Home Screen.
import icon180 from "../studio/icon-180.png";
import icon192 from "../studio/icon-192.png";
import icon512 from "../studio/icon-512.png";

export const ICONS: Record<string, Uint8Array> = {
  "/studio/icon-180.png": icon180,
  "/studio/icon-192.png": icon192,
  "/studio/icon-512.png": icon512,
};

/** The favicon, the same as amply.stream's (site/favicon.svg, which a test
 *  keeps it equal to), served from here so the artist's page and editor
 *  never depend on amply.stream for it. */
export const FAVICON_PATH = "/favicon.svg";
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="#f6711e"><title>Amply</title><circle cx="8.2" cy="24.6" r="6.2"/><circle cx="23.4" cy="23.6" r="6.2"/><rect x="11.8" y="3.2" width="2.6" height="21.6" rx="1.3"/><rect x="27" y="6.4" width="2.6" height="17.4" rx="1.3"/><rect x="15.825" y="6" width="2.3" height="8.5" rx="1.15"/><rect x="19.55" y="3.8" width="2.3" height="12.6" rx="1.15"/><rect x="23.275" y="7" width="2.3" height="8" rx="1.15"/></svg>`;

export const MANIFEST_PATH = "/studio.webmanifest";

export const studioManifest = () => JSON.stringify({
  name: "Amply — your music",
  short_name: "Your music",
  description: "Publish your music, set your prices, see who listens.",
  start_url: "/manage",
  scope: "/manage",
  display: "standalone",
  background_color: "#000000",   // the launch screen, around the black icon
  theme_color: "#ffffff",
  icons: [
    { src: "/studio/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
