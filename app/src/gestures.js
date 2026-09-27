/**
 * Swipes, for the places a phone music app is expected to have them.
 *
 * Returns touch handlers to spread onto an element. While the finger moves,
 * `onDrag(dx, dy)` can follow it (to slide a sheet down with the finger); when
 * it lifts, one of `left`, `right`, `up`, `down` fires if the swipe was long or
 * fast enough, and `onCancel` otherwise. Mostly-horizontal and mostly-vertical
 * swipes are told apart so scrolling a list isn't mistaken for a skip.
 *
 * In a component, use `useSwipe` (below), not this directly.
 */
import { useRef, useMemo, useEffect } from "preact/hooks";

export function swipe({ left, right, up, down, onDrag, onCancel, distance = 60, speed = 0.45 } = {}) {
  let x0 = 0, y0 = 0, t0 = 0, axis = null, active = false;

  return {
    onTouchStart(e) {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); axis = null; active = true;
    },
    onTouchMove(e) {
      if (!active) return;
      const t = e.touches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (axis) onDrag?.(axis === "x" ? dx : 0, axis === "y" ? dy : 0);
    },
    onTouchEnd(e) {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      const ms = Math.max(1, Date.now() - t0);
      const far = (d) => Math.abs(d) > distance || Math.abs(d) / ms > speed;
      const fire = (fn) => { if (!fn) return false; fn(); return true; };
      if (axis === "x" && far(dx) && fire(dx < 0 ? left : right)) return;
      if (axis === "y" && far(dy) && fire(dy < 0 ? up : down)) return;
      onCancel?.();
    },
    onTouchCancel() { active = false; onCancel?.(); },
  };
}

/**
 * `swipe` for a component: the same tracker for the component's whole life,
 * always calling the latest handlers. Built afresh on every render instead,
 * a redraw mid-swipe (the player redraws several times a second) would hand
 * the finger to a tracker that never saw it go down, and the swipe would
 * stop following and be forgotten.
 */
export function useSwipe(options) {
  const latest = useRef(options);
  latest.current = options;
  return useMemo(() => {
    // Only the directions it handles: one it doesn't must still spring back.
    const call = (name) => (latest.current[name] ? (...args) => latest.current[name]?.(...args) : undefined);
    const { distance, speed } = latest.current;
    return swipe({
      left: call("left"), right: call("right"), up: call("up"), down: call("down"),
      onDrag: call("onDrag"), onCancel: call("onCancel"), distance, speed,
    });
  }, []);
}

/**
 * Pull down to close, as Now playing and every sheet do: the panel follows
 * the finger from anywhere on it, and snaps on letting go — flicked down,
 * closed; moving back up, open; otherwise closed if pulled far enough,
 * however slowly. Only when whatever is under the finger is scrolled to the
 * top; otherwise a pull scrolls, as usual. It's decided on the finger's first
 * movement: once iOS starts scrolling or bouncing, it won't hand the gesture
 * back. `skip` names what never starts a pull (a scrubber). `onPull(f, ease)`
 * hears how far down it is, 0 to 1, to fade what's behind.
 *
 * Returns `dismiss`, to slide it away the same way from a button.
 */
export function usePullDown(ref, onClose, { skip = null, onPull = null, on = true } = {}) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const pullRef = useRef(onPull); pullRef.current = onPull;
  const dismiss = useRef(() => {
    const el = ref.current;
    if (!el) return closeRef.current();
    el.style.transition = "transform .22s ease-in";
    el.style.transform = "translateY(100%)";
    pullRef.current?.(1, true);
    setTimeout(() => closeRef.current(), 200);
  }).current;

  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    el.style.transition = ""; el.style.transform = "";
    pullRef.current?.(0, false);
    // Scrolled to the top, from the finger up to the panel itself.
    const atTop = (node) => {
      for (let n = node; n && n !== el.parentNode; n = n.parentNode) if (n.scrollTop > 0) return false;
      return true;
    };
    let g = null;
    const start = (e) => {
      if (e.touches.length !== 1 || (skip && e.target.closest?.(skip))) { g = null; return; }
      const p = e.touches[0];
      g = { x: p.clientX, y: p.clientY, node: e.target, top: atTop(e.target), mode: null, dy: 0, trail: [] };
    };
    const move = (e) => {
      if (!g) return;
      const p = e.touches[0], dx = p.clientX - g.x, dy = p.clientY - g.y;
      if (!g.mode) {
        const down = g.top && atTop(g.node) && dy > 0 && dy >= Math.abs(dx);
        if (down && e.cancelable) e.preventDefault();   // before iOS takes it for a scroll
        if (Math.hypot(dx, dy) < 8) return;
        g.mode = down ? "close" : "other";
        if (down) { el.style.transition = "none"; document.activeElement?.blur?.(); }
      }
      if (g.mode !== "close") return;
      if (e.cancelable) e.preventDefault();
      g.dy = Math.max(0, dy);
      // Where the finger has been lately, for how it's moving when let go.
      const now = performance.now();
      g.trail.push([now, g.dy]);
      while (g.trail.length > 2 && now - g.trail[0][0] > 100) g.trail.shift();
      el.style.transform = `translateY(${g.dy}px)`;
      pullRef.current?.(Math.min(1, g.dy / Math.max(1, el.offsetHeight)), false);
    };
    const end = () => {
      if (g?.mode === "close") {
        const [t0, y0] = g.trail[0] || [0, 0], last = g.trail[g.trail.length - 1] || [0, 0];
        const speed = (last[1] - y0) / Math.max(1, last[0] - t0);   // px/ms, down is positive
        const past = g.dy > Math.min(110, el.offsetHeight * 0.3);
        if ((speed > 0.4 && g.dy > 24) || (past && speed > -0.2)) dismiss();
        else { el.style.transition = "transform .2s ease"; el.style.transform = ""; pullRef.current?.(0, true); }
      }
      g = null;
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [on]);
  return dismiss;
}

/**
 * Swiping a song's row sideways, as mail apps do: the row follows the finger,
 * what the swipe will do shows underneath, and letting go past `reach` does
 * it; the row slides back either way. A mostly-up-or-down movement is left to
 * scroll the list. `slide` finds the part that moves; `onSide(side, ready)`
 * hears which side is showing and whether letting go would act.
 */
export function useRowSwipe(ref, { left, right, on = true, reach = 76, slide = ".track-slide", onSide } = {}) {
  const latest = useRef({ left, right, onSide }); latest.current = { left, right, onSide };
  useEffect(() => {
    const row = ref.current;
    if (!row || !on) return;
    let g = null, swallow = false;
    const part = () => row.querySelector(slide);
    const start = (e) => {
      if (e.touches.length !== 1) { g = null; return; }
      const p = e.touches[0];
      g = { x: p.clientX, y: p.clientY, mode: null, dx: 0 };
    };
    const move = (e) => {
      if (!g) return;
      if (row.classList.contains("lifted")) { g = null; return; }   // being dragged into place instead
      const p = e.touches[0], dx = p.clientX - g.x, dy = p.clientY - g.y;
      if (!g.mode) {
        if (Math.hypot(dx, dy) < 8) return;
        g.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? "swipe" : "scroll";
        if (g.mode === "swipe") { const el = part(); if (el) el.style.transition = "none"; }
      }
      if (g.mode !== "swipe") return;
      if (e.cancelable) e.preventDefault();
      // Past the point where it acts, it drags heavier.
      const d = Math.abs(dx), eased = d <= reach ? d : reach + (d - reach) * 0.35;
      g.dx = Math.sign(dx) * eased;
      const el = part();
      if (el) el.style.transform = `translateX(${g.dx}px)`;
      latest.current.onSide?.(dx < 0 ? "left" : "right", d >= reach);
    };
    const end = () => {
      if (g?.mode === "swipe") {
        const fire = Math.abs(g.dx) >= reach ? (g.dx < 0 ? latest.current.left : latest.current.right) : null;
        const el = part();
        if (el) { el.style.transition = "transform .25s cubic-bezier(.2, .8, .2, 1)"; el.style.transform = ""; }
        setTimeout(() => latest.current.onSide?.(null, false), 250);
        swallow = true; setTimeout(() => { swallow = false; }, 350);   // the tap a swipe ends in isn't a tap
        fire?.();
      }
      g = null;
    };
    const click = (e) => { if (swallow) { e.stopPropagation(); e.preventDefault(); } };
    row.addEventListener("touchstart", start, { passive: true });
    row.addEventListener("touchmove", move, { passive: false });
    row.addEventListener("touchend", end);
    row.addEventListener("touchcancel", end);
    row.addEventListener("click", click, true);
    return () => {
      row.removeEventListener("touchstart", start);
      row.removeEventListener("touchmove", move);
      row.removeEventListener("touchend", end);
      row.removeEventListener("touchcancel", end);
      row.removeEventListener("click", click, true);
    };
  }, [on]);
}

/**
 * Press and hold a row, then drag it into place: the queue, a playlist, a
 * local album. Holding still for a moment lifts the row (a finger that moves
 * first is scrolling, and is left to scroll); then it follows the finger, the
 * rows it passes slide aside, the list scrolls when the finger nears an edge,
 * and letting go calls `onMove(from, to)`. Rows are the list's children
 * marked `data-reorder`. Mouse too: hold the button down.
 */
const HOLD_MS = 380;
export function useReorder(ref, { onMove, on = true } = {}) {
  const latest = useRef(onMove); latest.current = onMove;
  useEffect(() => {
    const list = ref.current;
    if (!list || !on) return;
    let hold = null, d = null, swallow = false, raf = 0;

    const scrollerOf = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const o = getComputedStyle(n).overflowY;
        if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n;
      }
      return null;   // the page itself
    };
    const scrollOf = (s) => (s ? s.scrollTop : window.scrollY);
    const scrollBy = (s, by) => (s ? (s.scrollTop += by) : window.scrollBy(0, by));

    function lift(row, y) {
      const rows = [...list.querySelectorAll(":scope > [data-reorder]")];
      const from = rows.indexOf(row);
      if (from < 0) return;
      const scroller = scrollerOf(list);
      const top0 = scrollOf(scroller);
      d = {
        row, rows, from, to: from, y0: y, top0, y, scroller,
        mids: rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 + top0; }),
        h: row.getBoundingClientRect().height,
      };
      row.classList.add("lifted");
      list.classList.add("reordering");
      for (const r of rows) if (r !== row) r.style.transition = "transform .18s ease";
      navigator.vibrate?.(8);
      follow();
      raf = requestAnimationFrame(edge);
    }
    function follow() {
      const dy = d.y + scrollOf(d.scroller) - (d.y0 + d.top0);
      d.row.style.transform = `translateY(${dy}px) scale(1.02)`;
      const mid = d.mids[d.from] + dy;
      let to = d.from;
      while (to < d.rows.length - 1 && mid > d.mids[to + 1]) to++;
      while (to > 0 && mid < d.mids[to - 1]) to--;
      d.to = to;
      d.rows.forEach((r, i) => {
        if (r === d.row) return;
        const by = d.from < to && i > d.from && i <= to ? -d.h : d.from > to && i >= to && i < d.from ? d.h : 0;
        r.style.transform = by ? `translateY(${by}px)` : "";
      });
    }
    // Near the top or bottom of the screen, keep scrolling while held there.
    function edge() {
      if (!d) return;
      const box = d.scroller ? d.scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      const zone = 70;
      const by = d.y < box.top + zone ? -Math.ceil((box.top + zone - d.y) / 8) : d.y > box.bottom - zone - 120 ? Math.ceil((d.y - (box.bottom - zone - 120)) / 8) : 0;
      if (by) { scrollBy(d.scroller, by); follow(); }
      raf = requestAnimationFrame(edge);
    }
    function drop() {
      cancelAnimationFrame(raf);
      const { row, rows, from, to } = d;
      d = null;
      for (const r of rows) { r.style.transition = "none"; r.style.transform = ""; }
      row.classList.remove("lifted");
      list.classList.remove("reordering");
      requestAnimationFrame(() => rows.forEach((r) => { r.style.transition = ""; }));
      swallow = true; setTimeout(() => { swallow = false; }, 400);   // letting go isn't a tap
      if (to !== from) latest.current?.(from, to);
    }
    const cancelHold = () => { clearTimeout(hold); hold = null; };

    // ── touch ──
    let t0 = null;
    const tstart = (e) => {
      if (e.touches.length !== 1) return cancelHold();
      const row = e.target.closest?.("[data-reorder]");
      if (!row || row.parentElement !== list) return;
      const p = e.touches[0];
      t0 = { x: p.clientX, y: p.clientY };
      cancelHold();
      hold = setTimeout(() => { hold = null; lift(row, t0.y); }, HOLD_MS);
    };
    const tmove = (e) => {
      const p = e.touches[0];
      if (hold && t0 && Math.hypot(p.clientX - t0.x, p.clientY - t0.y) > 8) cancelHold();   // scrolling
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();       // not a pull to close Now playing, either
      d.y = p.clientY;
      follow();
    };
    const tend = (e) => { cancelHold(); if (d) { e.stopPropagation(); drop(); } };
    // A held finger mustn't open the phone's text-selection menu.
    const menu = (e) => { if (d || hold) e.preventDefault(); };

    // ── mouse ──
    const mdown = (e) => {
      if (e.button !== 0) return;
      const row = e.target.closest?.("[data-reorder]");
      if (!row || row.parentElement !== list) return;
      const y = e.clientY, x = e.clientX;
      cancelHold();
      hold = setTimeout(() => { hold = null; lift(row, y); }, HOLD_MS);
      const mmove = (ev) => {
        if (hold && Math.hypot(ev.clientX - x, ev.clientY - y) > 6) cancelHold();
        if (d) { ev.preventDefault(); d.y = ev.clientY; follow(); }
      };
      const mup = () => { cancelHold(); if (d) drop(); removeEventListener("mousemove", mmove); removeEventListener("mouseup", mup); };
      addEventListener("mousemove", mmove);
      addEventListener("mouseup", mup);
    };
    const click = (e) => { if (swallow) { e.stopPropagation(); e.preventDefault(); } };

    list.addEventListener("touchstart", tstart, { passive: true });
    list.addEventListener("touchmove", tmove, { passive: false });
    list.addEventListener("touchend", tend);
    list.addEventListener("touchcancel", tend);
    list.addEventListener("contextmenu", menu);
    list.addEventListener("mousedown", mdown);
    list.addEventListener("click", click, true);
    return () => {
      cancelHold(); cancelAnimationFrame(raf);
      list.removeEventListener("touchstart", tstart);
      list.removeEventListener("touchmove", tmove);
      list.removeEventListener("touchend", tend);
      list.removeEventListener("touchcancel", tend);
      list.removeEventListener("contextmenu", menu);
      list.removeEventListener("mousedown", mdown);
      list.removeEventListener("click", click, true);
    };
  }, [on]);
}
