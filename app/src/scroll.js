/**
 * The page's scroll, held still while a sheet is open. iOS scrolls the page
 * behind anything that doesn't stop it, and `overflow: hidden` on the body
 * isn't enough there, so the body is pinned where it was and let go after.
 * While pinned, `pageScroll` and `setPageScroll` read and set where it will
 * be put back, so a screen change made from a sheet lands in the right place.
 */
let locks = 0, held = 0;

export function lockScroll() {
  if (typeof document === "undefined") return () => {};
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

export const pageScroll = () => (locks ? held : window.scrollY);

export function setPageScroll(y) {
  if (locks) held = y;
  else window.scrollTo(0, y);
}
