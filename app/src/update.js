/**
 * Picking up a new version of the app.
 *
 * A home-screen app is mostly resumed, not reloaded: tapping its icon brings
 * back the page already in memory, old code and all, and nothing asks for a
 * newer one. So each build is stamped (see build.mjs), and the app compares
 * its stamp with the one published beside it when it opens: started, or come
 * back to after a long while (app.jsx).
 *
 * A newer one is loaded only when that interrupts nothing: nothing playing,
 * nor paused so recently that the listener is coming back to it.
 */
export const IDLE_MS = 10 * 60 * 1000;     // away or paused this long: fair to reload

export function createUpdater({
  current = globalThis.AMPLY_BUILD,
  audio,                                     // the player's element
  get = () => fetch("/app/version.json", { cache: "no-store" }),
  reload = () => location.reload(),
  now = () => Date.now(),
  // Which build a reload was last tried for, this session: never twice for
  // the same one, so a stubborn cache can't set it reloading in a loop.
  tried = {
    get: () => { try { return sessionStorage.getItem("amply.update.tried"); } catch { return null; } },
    set: (v) => { try { sessionStorage.setItem("amply.update.tried", v); } catch { /* private mode */ } },
  },
} = {}) {
  let pausedAt = now(), waiting = null;
  audio?.addEventListener?.("pause", () => { pausedAt = now(); });
  audio?.addEventListener?.("play", () => { pausedAt = Infinity; });

  /** Nothing loaded, or paused long enough ago. */
  const idle = () => !audio || !audio.src || (audio.paused && now() - pausedAt >= IDLE_MS);

  return {
    /** Look for a newer build; load it if that interrupts nothing. */
    async check() {
      if (!current) return "unknown";        // a build without a stamp: nothing to compare
      if (!waiting) {
        let latest;
        try {
          const res = await get();
          if (!res.ok) return "unknown";
          latest = (await res.json())?.build;
        } catch { return "unknown"; }         // no signal: try again later
        if (!latest || latest === current || latest === tried.get()) return "current";
        waiting = latest;
      }
      if (!idle()) return "waiting";
      tried.set(waiting);
      reload();
      return "reloaded";
    },
    /** Whether a reload now would interrupt nothing. */
    idle,
  };
}
