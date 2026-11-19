/**
 * The page's scroll, held still while a sheet is open. iOS scrolls the page
 * behind anything that doesn't stop it, and `overflow: hidden` on the body
 * isn't enough there, so the body is pinned where it was and let go after.
 * While pinned, `pageScroll` and `setPageScroll` read and set where it will
 * be put back, so a screen change made from a sheet lands in the right place.
 *
 * On a desktop the page itself doesn't scroll: the main panel between the
 * sidebar and the player does (desktop.jsx). It registers itself here, and
 * every read and write of "the page's scroll" goes to it instead.
 */
let locks = 0, held = 0;
let scroller = null;

/** The element that scrolls instead of the page, or null for the page. */
export function setScroller(el) { scroller = el || null; }

export function lockScroll() {
  if (typeof document === "undefined") return () => {};
  // A panel that scrolls on its own isn't moved by the page behind a sheet.
  if (scroller) return () => {};
  if (locks++ === 0) {
    held = window.scrollY;
    Object.assign(document.body.style, { position: "fixed", top: `-${held}px`, left: "0", right: "0" });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--locks > 0) return;
    Object.assign(document.body.style, { position: "", top: "", left: "", right: "" });
    window.scrollTo(0, held);
  };
}

export const pageScroll = () => (scroller ? scroller.scrollTop : locks ? held : window.scrollY);

export function setPageScroll(y) {
  if (scroller) scroller.scrollTop = y;
  else if (locks) held = y;
  else window.scrollTo(0, y);
}

/** Back to the top, gently: a second tap on the tab you're already on. */
export function scrollToTop() {
  (scroller || window).scrollTo({ top: 0, behavior: "smooth" });
}
