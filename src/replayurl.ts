// Undoes wabac's URL rewriting in a serialized replayed page.
//
// wabac rewrites every URL in a page it serves so that subresource requests go
// back through the replay server:
//
//   http://127.0.0.1:8090/w/coll/:<hash>/20230105164613im_/https://example.org/a.jpg
//   \_________ replay origin _______/\__ coll path __/\_ ts+mod _/\_ original _/
//
// That is exactly right for replay and exactly wrong for output meant to
// outlive the process: the origin is an ephemeral localhost port. Every URL in
// a page extracted this way needs the prefix taken back off.
//
// The rewritten form is anchored to the replay server's own origin, which we
// know, so only URLs pointing at it are touched -- an archived page that
// happens to contain something shaped like a timestamp modifier is left alone.

// The segment wabac inserts before the original URL: a capture timestamp plus
// an optional "modifier" naming the kind of resource (mp_ for a page, im_ for
// an image, cs_ for a stylesheet, and so on). The timestamp is normally 14
// digits, but can be a single digit when we ask replay to pick a capture.
const TS_MOD = String.raw`\d{1,14}[a-z]{0,3}_`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Absolute form: the full replay origin, then wabac's collection path (which
// varies), then the timestamp segment.
function absolutePattern(origin: string): RegExp {
  return new RegExp(`${escapeRegExp(origin)}/[^\\s"'<>]*?/${TS_MOD}/`, "g");
}

// Root-relative form. wabac also emits prefixes with the origin left off --
// href="/w/coll/.../20230105201232mp_/https://example.org/a" -- which the
// absolute pattern cannot see. There is no origin to anchor to here, so anchor
// on the "/w/" replay prefix instead (render.ts is what puts it there), and
// require the match to start at a quote, bracket or whitespace so this only
// ever fires on a whole attribute value rather than mid-URL.
const RELATIVE = new RegExp(`(^|["'(\\s])/w/[^\\s"'<>]*?/${TS_MOD}/`, "g");

// Strip replay prefixes throughout a serialized document. Applied to the HTML
// rather than to the extracted Markdown so that href, src, srcset and inline
// url() are all covered by one pass, before anything tries to resolve them.
export function unrewriteHtml(html: string, origin: string): string {
  return html.replace(absolutePattern(origin), "").replace(RELATIVE, "$1");
}

// Strip the replay prefix from a single URL, for the odd value that reaches us
// outside the document body. Returns the URL unchanged if it isn't rewritten.
export function unrewriteUrl(url: string, origin: string): string {
  return url.replace(absolutePattern(origin), "").replace(RELATIVE, "$1");
}
