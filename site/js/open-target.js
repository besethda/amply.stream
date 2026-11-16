// Open the folded answer a link points at (why#gdpr and the like), so a
// "Read more" from the editor lands on the answer, not a closed question.
function openTarget() {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id && document.getElementById(id);
  if (el && el.tagName === "DETAILS") { el.open = true; el.scrollIntoView(); }
}
addEventListener("hashchange", openTarget);
openTarget();
