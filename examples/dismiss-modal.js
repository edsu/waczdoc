// Example --inject script: dismiss a "register / sign in to keep reading"
// modal captured in an archive so the underlying article prints.
//
// Clicking a site's own close button often won't work offline (its JS handler
// may not run in replay), so this removes the overlay element directly, which
// is reliable. Sites differ — open the captured page in your browser's
// devtools to find the overlay element and any scroll-lock class the site
// adds to <html>/<body>, then adjust the selectors below.
const OVERLAY_SELECTORS = [
  "dialog[open]",
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[class*="regwall"]',
  '[class*="paywall"]',
  '[class*="signin"]',
];
for (const el of document.querySelectorAll(OVERLAY_SELECTORS.join(","))) {
  if (el.tagName === "DIALOG" && el.open) {
    try {
      el.close();
    } catch {}
  }
  el.remove();
}
// Restore scrolling in case the modal locked the page.
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "auto";
