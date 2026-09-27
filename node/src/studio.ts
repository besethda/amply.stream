/**
 * The editor as an app on the artist's Home Screen: its manifest and icons.
 *
 * Served by the streaming service itself, outside /manage and its sign-in:
 * they say nothing about anyone (a name, colours, a logo), and the editor must
 * keep working even if amply.stream is gone, so nothing here points there.
 */
import icon180 from "../../site/app/icon-180.png";
import icon192 from "../../site/app/icon-192.png";
import icon512 from "../../site/app/icon-512.png";

export const ICONS: Record<string, Uint8Array> = {
  "/studio/icon-180.png": icon180,
  "/studio/icon-192.png": icon192,
  "/studio/icon-512.png": icon512,
};

export const MANIFEST_PATH = "/studio.webmanifest";

export const studioManifest = () => JSON.stringify({
  name: "Amply — your music",
  short_name: "Your music",
  description: "Publish your music, set your prices, see who listens.",
  start_url: "/manage",
  scope: "/manage",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    { src: "/studio/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
