import { test } from "node:test";
import assert from "node:assert/strict";
import { articleToMarkdown } from "../dist/markdown.js";

// articleToMarkdown takes the serialized DOM of an already-replayed page, so
// these run without a browser. The replay half is covered by e2e.test.js.
const JOB = {
  url: "https://example.org/acting-my-age",
  timestamp: "20230105202119",
  title: null,
};

const ARTICLE = `<html><head><title>Acting My Age</title>
<meta name="author" content="Hanif Abdurraqib">
<meta name="description" content="On growing older in public">
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article>
<h1>Acting My Age</h1>
<p>The aesthetics of being old are detached from the reality of adulthood,
and that gap is where the trouble starts. It has been this way for a while.</p>
<blockquote><p>A pull quote worth keeping.</p></blockquote>
<h2>A section heading</h2>
<ul><li>first item</li><li>second item</li></ul>
<p>Read <a href="https://example.org/more">more about it</a>, or see
<img src="https://example.org/img/a.png" alt="a picture">.</p>
</article>
<footer>Copyright notice nobody wants.</footer>
</body></html>`;

test("extracts the article as markdown", async () => {
  const md = await articleToMarkdown(ARTICLE, JOB, false);
  assert.match(md, /aesthetics of being old/);
  // The article, not the furniture around it.
  assert.doesNotMatch(md, /Copyright notice/);
  assert.doesNotMatch(md, /<article|<nav|<div/);
});

test("structure survives the conversion", async () => {
  const md = await articleToMarkdown(ARTICLE, JOB, false);
  assert.match(md, /^#+ A section heading/m, "subheading");
  assert.match(md, /^> A pull quote worth keeping\./m, "blockquote");
  assert.match(md, /^[-*] first item$/m, "list");
  assert.match(md, /\[more about it\]\(https:\/\/example\.org\/more\)/, "link");
  assert.match(md, /!\[[^\]]*\]\(https:\/\/example\.org\/img\/a\.png\)/, "image");
});

// The <h1> is the article title, which defuddle reports as metadata and removes
// from the body -- so it belongs in the front matter, not twice in the output.
test("the title is not repeated as a heading in the body", async () => {
  const md = await articleToMarkdown(ARTICLE, JOB, true);
  assert.match(md, /^title: "Acting My Age"$/m);
  assert.doesNotMatch(md, /^#+ Acting My Age/m);
});

test("front matter carries the page's metadata and capture time", async () => {
  const md = await articleToMarkdown(ARTICLE, JOB, true);
  const block = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(block, "starts with a front matter block");
  assert.match(block[1], /^title: "Acting My Age"$/m);
  assert.match(block[1], /^url: "https:\/\/example\.org\/acting-my-age"$/m);
  assert.match(block[1], /^archived: "2023-01-05T20:21:19Z"$/m);
  assert.match(block[1], /^author: "Hanif Abdurraqib"$/m);
});

test("front matter values are escaped, not just quoted", async () => {
  const tricky = ARTICLE.replace("<title>Acting My Age</title>", '<title>He said "no": a story</title>');
  const md = await articleToMarkdown(tricky, JOB, true);
  // JSON string escaping keeps this parseable as a YAML double-quoted scalar.
  assert.match(md, /^title: "He said \\"no\\": a story"$/m);
});

// Some publishers double-encode their own meta tags, so the once-decoded value
// is the literal text "&#8220;...". Readable output beats faithful nonsense.
test("double-encoded metadata is decoded rather than passed through", async () => {
  const doubled = ARTICLE.replace(
    'content="On growing older in public"',
    'content="On growing older &amp;#8220;in public&amp;#8221;"'
  );
  const md = await articleToMarkdown(doubled, JOB, true);
  assert.match(md, /^description: "On growing older “in public”"$/m);
  assert.doesNotMatch(md, /&#8220;/);
});

test("markup inside a metadata value is kept as text, not stripped", async () => {
  const withTag = ARTICLE.replace("<title>Acting My Age</title>", "<title>Use &lt;b&gt; sparingly</title>");
  const md = await articleToMarkdown(withTag, JOB, true);
  assert.match(md, /^title: "Use <b> sparingly"$/m);
});

test("--no-front-matter writes just the content", async () => {
  const md = await articleToMarkdown(ARTICLE, JOB, false);
  assert.doesNotMatch(md, /^---/);
  assert.match(md, /aesthetics of being old/);
});

test("a malformed capture timestamp is omitted rather than guessed", async () => {
  const md = await articleToMarkdown(ARTICLE, { ...JOB, timestamp: "2" }, true);
  assert.doesNotMatch(md, /^archived:/m);
  assert.match(md, /^url:/m, "the rest of the front matter is still written");
});

// A page that assembles its content in JavaScript, replayed but with the script
// never having run, has nothing to extract. Reported, not written as an empty
// file.
test("a page with no article is reported as such", async () => {
  const shell = `<html><head><title>App</title></head><body><div id="root"></div></body></html>`;
  await assert.rejects(() => articleToMarkdown(shell, JOB, true), /no article content found/);
});
