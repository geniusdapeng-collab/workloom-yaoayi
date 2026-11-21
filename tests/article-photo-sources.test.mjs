import test from "node:test";
import assert from "node:assert/strict";
import { discoverArticlePhotos, readCommonsPhotoSource } from "../src/services/article-photo-sources.mjs";
import { normalizeOpenImageAttribution } from "../src/domain/article-illustration-policy.mjs";

const canonicalPage = "https://commons.wikimedia.org/wiki/File:Courtyard.jpg";
const original = "https://upload.wikimedia.org/wikipedia/commons/7/74/Courtyard.jpg";
const sha = "3".repeat(40);
const sourcePage = ({ license = "http://creativecommons.org/licenses/by-sa/4.0/deed.en", upload = original + "?utm_source=commons.wikimedia.org", mime = "image/jpeg" } = {}) => ({
  title: "File:Courtyard.jpg",
  imageinfo: [{
    mime, width: 1600, height: 1120, size: 12345, sha1: sha, url: upload, descriptionurl: canonicalPage,
    extmetadata: {
      LicenseUrl: { value: license }, Artist: { value: '<a href="#photographer">Lan &amp; Chen</a>' },
      ImageDescription: { value: '<span>stone steps and an old courtyard</span>' },
    },
  }],
});
const response = (...pages) => new Response(JSON.stringify({ query: { pages } }), { status: 200 });

test("Commons lookup scopes requests to the file namespace and filters unlicensed and off-origin candidates", async () => {
  let requested;
  const search = await discoverArticlePhotos({ queries: [{ sectionKey: "courtyard", query: "Shandong stone courtyard" }], limit: 5 }, {
    fetchImpl: async url => {
      requested = url;
      return response(sourcePage(), sourcePage({ license: "https://creativecommons.org/licenses/by-nc/4.0/" }),
        sourcePage({ upload: "https://untrusted.org/wikipedia/commons/Courtyard.jpg" }), sourcePage({ mime: "image/svg+xml" }));
    },
  });
  assert.equal(requested.origin, "https://commons.wikimedia.org");
  assert.equal(requested.searchParams.get("gsrnamespace"), "6");
  assert.deepEqual(search.results.map(row => [row.sectionKey, row.state, row.candidates.length]), [["courtyard", "review_required", 1]]);
  const [selected] = search.results[0].candidates;
  assert.equal(selected.originalUrl, original);
  assert.equal(selected.landingUrl, canonicalPage);
  assert.equal(selected.credit, "Lan & Chen");
  assert.equal(selected.licenseId, "CC-BY-SA-4.0");
  assert.equal(selected.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(selected.reviewRequired, true);
});

test("source verification returns the official original digest and fails closed on query-bearing foreign origins", async () => {
  const actual = await readCommonsPhotoSource(canonicalPage, { fetchImpl: async url => {
    assert.equal(url.searchParams.get("titles"), "File:Courtyard.jpg");
    return response(sourcePage());
  } });
  assert.equal(actual.sha1, sha);
  assert.equal(actual.size, 12345);
  await assert.rejects(readCommonsPhotoSource(canonicalPage + "?key=not-a-license"), { code: "ARTICLE_PHOTO_SOURCE_INVALID" });
  await assert.rejects(readCommonsPhotoSource(canonicalPage, { fetchImpl: async () => response(sourcePage({ upload: original + "?unexpected=1" })) }),
    { code: "ARTICLE_PHOTO_SOURCE_UNVERIFIED" });
  await assert.rejects(readCommonsPhotoSource(canonicalPage, { fetchImpl: async () => new Response("", { status: 429 }) }),
    { code: "ARTICLE_PHOTO_SOURCE_UNAVAILABLE" });
});

test("public attribution preserves author and derivative instructions and rejects unsupported licenses", () => {
  const value = { landingUrl: canonicalPage, credit: "Lan & Chen", modifications: "裁切与轻度调色", title: "旧院石阶照片",
    licenseId: "CC-BY-SA-4.0", licenseUrl: "http://creativecommons.org/licenses/by-sa/4.0/deed.en" };
  const result = normalizeOpenImageAttribution(value);
  assert.equal(result.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(result.modifications, "裁切与轻度调色");
  assert.throws(() => normalizeOpenImageAttribution({ ...value, licenseUrl: "https://creativecommons.org/licenses/by-nd/4.0/" }),
    { code: "ARTICLE_IMAGE_LICENSE_INVALID" });
  assert.throws(() => normalizeOpenImageAttribution({ ...value, landingUrl: "http://127.0.0.1/private.png" }),
    { code: "INVALID_PUBLIC_URL" });
});
