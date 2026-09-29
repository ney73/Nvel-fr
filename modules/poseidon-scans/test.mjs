import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(root, "fixtures", name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
    contentType: "text/html",
    bodyDropped: false,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function load(fetchv2) {
  const source = await readFile(path.join(root, "index.js"), "utf8");
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: path.join(root, "index.js") }).runInContext(context);
  return context.SynthetiqModule;
}

function router(fixtures) {
  return async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "poseidon-scans.net", `unapproved host ${parsed.hostname}`);
    if (parsed.pathname === "/api/search") {
      if (/introuvable/i.test(parsed.searchParams.get("q") || "")) return response(fixtures.searchEmpty);
      return response(fixtures.search);
    }
    if (parsed.pathname === "/api/manga/lastchapters") return response(fixtures.lastchapters);
    if (/^\/api\/manga\/[^/]+\/\d+$/.test(parsed.pathname)) {
      if (parsed.pathname === "/api/manga/fixture-one/1") return response(fixtures.chapters);
      return response("Not Found", 404);
    }
    if (/^\/serie\/fixture-one\/chapter\/\d+\/?$/.test(parsed.pathname)) return response(fixtures.pages);
    if (parsed.pathname === "/serie/fixture-one" || parsed.pathname === "/serie/fixture-one/") {
      return response(fixtures.details);
    }
    if (parsed.pathname === "/") return response(fixtures.home);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function loadFixtures() {
  return {
    home: await fixture("home.rsc"),
    search: await fixture("search.json"),
    searchEmpty: await fixture("search-empty.json"),
    lastchapters: await fixture("lastchapters.json"),
    details: await fixture("details.rsc"),
    chapters: await fixture("chapters.json"),
    pages: await fixture("pages.rsc"),
  };
}

test("Poseidon Scans discovery, search, details, chapters and images match expected.json", async () => {
  const fixtures = await loadFixtures();
  const expected = JSON.parse(await fixture("expected.json"));
  let chapterCalls = 0;
  const module = await load(async (url, headers, method, body, options) => {
    if (/\/serie\/fixture-one\/chapter\/\d+/.test(url)) chapterCalls += 1;
    return router(fixtures)(url, headers, method, body, options);
  });

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    assert.ok(["popular", "latest"].includes(section.id), "stable section id");
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
      assert.match(item.href, /^https:\/\/poseidon-scans\.net\/serie\//);
      assert.match(item.image, /^https:\/\/poseidon-scans\.net\/api\/covers\//);
      assert.equal(item.coverUrl, item.cover, "cover alias must match");
    }
  }
  // Duplicates and explicit titles never reach the catalogue.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id, title }) => ({ id, title }))),
    [
      { id: "https://poseidon-scans.net/serie/fixture-one", title: "Fixture One" },
      { id: "https://poseidon-scans.net/serie/fixture-two", title: "Fixture Two" },
    ],
  );
  assert.deepEqual(plain(await module.discoveryFeed("latest", 1)), {
    items: expected.discovery.sections[1].items,
    hasMore: false,
  });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), expected.search);
  assert.deepEqual(plain(await module.extractDetails(expected.details.id)), expected.details);
  assert.deepEqual(
    plain(await module.extractDetails("fixture-one")),
    expected.details,
    "bare slugs resolve too",
  );
  // The complete chapter list is newest-first, never capped, and drops the
  // premium-gated chapter (badge on the series card plus the API window flag
  // it); every chapter carries the series cover for library screens.
  const chapters = await module.extractChapters(expected.details.id);
  assert.deepEqual(plain(chapters), expected.chapters);
  assert.deepEqual(
    plain(chapters.map(({ number }) => ({ number }))),
    [{ number: 5 }, { number: 3 }, { number: 2 }, { number: 1 }],
  );
  assert.ok(chapters.every((chapter) => chapter.url.startsWith("https://poseidon-scans.net/serie/fixture-one/chapter/")));
  assert.ok(chapters.every((chapter) => chapter.coverUrl === expected.details.cover));
  assert.deepEqual(plain(chapters[0].manga), {
    id: expected.details.id,
    href: expected.details.href,
    url: expected.details.url,
    title: expected.details.title,
    cover: expected.details.cover,
  });
  // Page images keep document order through the site's bounded image route,
  // foreign mirrors and duplicates excluded.
  const images = await module.extractImages(chapters[0].id);
  assert.deepEqual(plain(images), expected.images);
  for (const image of images) {
    const imageURL = new URL(image.url);
    assert.equal(imageURL.pathname, "/_next/image");
    assert.equal(imageURL.searchParams.get("w"), "1200");
    assert.equal(imageURL.searchParams.get("q"), "75");
    assert.match(imageURL.searchParams.get("url") || "", /^https:\/\/poseidon-scans\.net\/api\/chapters\//);
    assert.equal(image.headers.Referer, "https://poseidon-scans.net/serie/fixture-one/chapter/5");
  }
  assert.equal(chapterCalls, 1, "a successful chapter page must be fetched once");
  // This pageImages module exposes no text or publication terminal.
  assert.equal(typeof module.extractText, "undefined", "poseidon-scans must not expose text");
  assert.equal(typeof module.extractResources, "undefined", "poseidon-scans must not expose resources");
});

test("Poseidon Scans rejects unsafe, empty, foreign and invalid inputs", async () => {
  const fixtures = await loadFixtures();
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("https://evil.example/serie/fixture-one"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("https://poseidon-scans.net/series"), /series path|identifier/i);
  await assert.rejects(() => module.extractChapters("not a url \\\\"), /identifier|host/i);
  await assert.rejects(() => module.extractImages("https://evil.example/serie/fixture-one/chapter/5"), /host|identifier/i);
  await assert.rejects(() => module.extractImages("fixture-one"), /chapter path|identifier/i);
  await assert.rejects(() => module.extractImages("https://poseidon-scans.net/serie/fixture-one/chapter/0"), /chapter/i);
  // Unknown series have no chapter payload: strict failure, not an invention.
  await assert.rejects(() => module.extractChapters("fixture-unknown"), /HTTP 404|no chapter list/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown-feed", 1)),
    plain(await module.discoveryFeed("latest", 1)),
  );
  assert.deepStrictEqual(
    plain(await module.searchResults("fixture", 0)),
    plain(await module.searchResults("fixture", 1)),
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("hentai", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("zzzintrouvable", 1)),
    { items: [], hasMore: false },
  );
});

test("Poseidon Scans uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    return response(await fixture("home.rsc"));
  });
  await module.discoveryHome();
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!("User-Agent" in call.headers), "User-Agent must not be set on fetchv2");
    assert.ok(!("Host" in call.headers), "Host must not be set on fetchv2");
  }
});

test("Poseidon Scans degrades failed feeds to empty lists instead of throwing", async () => {
  const module = await load(async () => {
    throw new Error("Poseidon Scans request failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await module.discoveryFeed("latest", 1)), { items: [], hasMore: false });
});

test("Poseidon Scans degrades challenge, empty and malformed responses safely", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("fixture-one"), /challenge/i);
  await assert.rejects(() => module.extractChapters("fixture-one"), /challenge/i);
  await assert.rejects(() => module.extractImages("https://poseidon-scans.net/serie/fixture-one/chapter/5"), /challenge/i);

  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("latest", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response(await fixture("malformed.html")));
  assert.deepEqual(plain(await malformedModule.discoveryFeed("latest", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain((await malformedModule.searchResults("fixture", 1)).items), []);
});

test("Poseidon Scans does not retry a timed-out chapter handler", async () => {
  let calls = 0;
  const module = await load(async (url) => {
    calls += 1;
    assert.match(url, /\/chapter\/44$/);
    throw new Error("fixture timeout");
  });

  await assert.rejects(
    module.extractImages("https://poseidon-scans.net/serie/fixture-one/chapter/44"),
    /fixture timeout/,
  );
  assert.equal(calls, 1, "a chapter timeout must not fan out into nested retries");
});

test("Poseidon Scans manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/poseidon-scans/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/poseidon-scans/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
