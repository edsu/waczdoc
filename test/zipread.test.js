import { test } from "node:test";
import assert from "node:assert/strict";
import { openZip } from "../src/zipread.js";
import { FIXTURE_1 } from "./helpers.js";

test("openZip lists the expected WACZ entries", () => {
  const zip = openZip(FIXTURE_1);
  try {
    const names = zip.names();
    assert.ok(names.includes("datapackage.json"), "has datapackage.json");
    assert.ok(
      names.some((n) => /^indexes\/.*\.cdx/.test(n)),
      "has a CDX index"
    );
    assert.ok(
      names.some((n) => /^archive\/.*\.warc/.test(n)),
      "has a WARC"
    );
  } finally {
    zip.close();
  }
});

test("openZip reads and decompresses an entry", () => {
  const zip = openZip(FIXTURE_1);
  try {
    const pkg = JSON.parse(zip.read("datapackage.json").toString("utf8"));
    assert.ok(Array.isArray(pkg.resources), "datapackage has resources[]");
  } finally {
    zip.close();
  }
});

test("reading a missing entry throws", () => {
  const zip = openZip(FIXTURE_1);
  try {
    assert.throws(() => zip.read("does/not/exist"), /not found/i);
  } finally {
    zip.close();
  }
});
