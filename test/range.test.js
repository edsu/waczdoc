import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/server.js";

const TOTAL = 1000;

test("no range header serves the whole file", () => {
  assert.equal(parseRange(undefined, TOTAL), null);
  assert.equal(parseRange("", TOTAL), null);
});

test("closed range bytes=a-b", () => {
  assert.deepEqual(parseRange("bytes=0-99", TOTAL), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-199", TOTAL), { start: 100, end: 199 });
});

test("open-ended range bytes=a- runs to the end", () => {
  assert.deepEqual(parseRange("bytes=500-", TOTAL), { start: 500, end: 999 });
});

test("suffix range bytes=-N returns the LAST N bytes", () => {
  // This is the case wabac uses to read the end-of-central-directory record.
  assert.deepEqual(parseRange("bytes=-100", TOTAL), { start: 900, end: 999 });
});

test("suffix larger than the file clamps to start", () => {
  assert.deepEqual(parseRange("bytes=-5000", TOTAL), { start: 0, end: 999 });
});

test("end beyond EOF is clamped", () => {
  assert.deepEqual(parseRange("bytes=0-99999", TOTAL), { start: 0, end: 999 });
});

test("start past EOF is unsatisfiable (416)", () => {
  assert.deepEqual(parseRange("bytes=2000-3000", TOTAL), { unsatisfiable: true });
});

test("malformed range header serves the whole file", () => {
  assert.equal(parseRange("bytes=abc", TOTAL), null);
  assert.equal(parseRange("weird", TOTAL), null);
});
