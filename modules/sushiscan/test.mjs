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
    assert.ok(
      parsed.hostname === "sushiscan.net" || parsed.hostname.endsWith(".sushiscan.net"),
      `unapproved host ${parsed.hostname}`,
    );
    if (parsed.pathname === "/catalogue/fixture-aurore/") return response(fixtures.details);
    if (parsed.pathname === "/catalogue/fixture-boreal/") return response(fixtures.details);
    if (parsed.pathname === "/fixture-aurore-chapitre-3/") return response(fixtures.chapter);
    if (parsed.pathname === "/fixture-aurore-chapitre-2/") return response(fixtures.chapterFallback);
    if (parsed.searchParams.has("s")) {
      if (/introuvable/i.test(parsed.searchParams.get("s") || "")) return response(fixtures.searchEmpty);
      if (/exclu/i.test(parsed.searchParams.get("s") || "")) return response(fixtures.searchExcluded);
      return response(fixtures.search);
    }
    if (parsed.pathname === "/" || parsed.pathname === "/catalogue/") return response(fixtures.home);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function loadFixtures() {
  return {
    home: await fixture("home.html"),
    search: await fixture("search.html"),
    searchEmpty: await fixture("search-empty.html"),
    searchExcluded: await fixture("search-excluded.html"),
    details: await fixture("details.html"),
    chapter: await fixture("chapter.html"),
    chapterFallback: await fixture("chapter-fallback.html"),
  };
}

test("Sushi Scan discovery, search, details, chapters and images match expected.json", async () => {
  const fixtures = await loadFixtures();
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(router(fixtures));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
      assert.match(item.href, /^https:\/\/sushiscan\.net\/catalogue\//);
      assert.ok(item.image.startsWith("https://sushiscan.net/"), "cover must be an absolute source URL");
      assert.ok(!item.image.includes("?ver="), "cover must drop the cache-busting query");
      assert.equal(item.coverUrl, item.cover, "cover alias must match");
    }
  }
  // Unsafe titles and duplicates never reach the catalogue.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }, { id: "fixture-boreal" }],
  );
  assert.deepEqual(plain((await module.discoveryFeed("catalogue", 1)).items), expected.discovery.sections[0].items);
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), expected.search);
  assert.deepEqual(
    plain((await module.searchResults("FIXTURE", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }, { id: "fixture-cendre" }],
  );
  assert.deepEqual(plain(await module.extractDetails("fixture-aurore")), expected.details);
  assert.deepEqual(
    plain(await module.extractDetails("https://sushiscan.net/catalogue/fixture-aurore/")),
    expected.details,
  );
  // The complete chapter list is never capped, stays oldest-first, and drops
  // the unsafe entry.
  const chapters = await module.extractChapters("fixture-aurore");
  assert.deepEqual(plain(chapters), expected.chapters);
  assert.ok(chapters.every((chapter) => chapter.url.startsWith("https://sushiscan.net/fixture-aurore-")));
  // Page images come from the embedded reader payload, in payload order,
  // foreign mirrors excluded.
  const images = await module.extractImages("fixture-aurore-chapitre-3");
  assert.deepEqual(plain(images), expected.images);
  for (const image of images) {
    assert.match(image.url, /^https:\/\/c\.sushiscan\.net\//);
    assert.equal(image.headers.Referer, "https://sushiscan.net/fixture-aurore-chapitre-3/");
  }
  // An empty default source falls back to the first source carrying images.
  const fallback = await module.extractImages("fixture-aurore-chapitre-2");
  assert.deepEqual(
    plain(fallback.map(({ url }) => ({ url }))),
    [
      { url: "https://c1.sushiscan.net/wp-content/uploads97/FixtureAuroreChap2-01.webp" },
      { url: "https://c1.sushiscan.net/wp-content/uploads97/FixtureAuroreChap2-02.webp" },
    ],
  );
  // This pageImages module exposes no text terminal.
  assert.equal(typeof module.extractText, "undefined", "sushiscan must not expose text");
  assert.equal(typeof module.extractResources, "undefined", "sushiscan must not expose resources");
});

test("Sushi Scan rejects unsafe, empty, foreign and invalid inputs", async () => {
  const fixtures = await loadFixtures();
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("https://evil.example/catalogue/fixture-aurore/"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("https://sushiscan.net/genres/aventure/"), /series path|identifier/i);
  await assert.rejects(() => module.extractDetails("genres/aventure"), /series path|identifier/i);
  await assert.rejects(() => module.extractChapters("not a url \\\\"), /identifier|host/i);
  await assert.rejects(() => module.extractImages("https://evil.example/fixture-aurore-chapitre-3/"), /host|identifier/i);
  await assert.rejects(() => module.extractImages("fixture-aurore"), /chapter path|identifier/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown-feed", 1)),
    plain(await module.discoveryFeed("latest", 1)),
  );
  assert.ok((await module.discoveryFeed("latest", 1)).items.length > 0, "default feed must be non-empty");
  assert.deepStrictEqual(
    plain(await module.searchResults("fixture", 0)),
    plain(await module.searchResults("fixture", 1)),
  );
  // Explicit titles and foreign hosts never reach the catalogue.
  assert.deepEqual(
    plain((await module.searchResults("exclu", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }],
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("hentai", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("zzzintrouvable", 1)),
    { items: [], hasMore: false },
  );
});

test("Sushi Scan uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    return response(await fixture("home.html"));
  });
  await module.discoveryHome();
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!("User-Agent" in call.headers), "User-Agent must not be set on fetchv2");
    assert.ok(!("Host" in call.headers), "Host must not be set on fetchv2");
  }
});

test("Sushi Scan degrades failed feeds to empty lists instead of throwing", async () => {
  const module = await load(async () => {
    throw new Error("Sushi Scan request failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await module.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });
});

test("Sushi Scan degrades challenge, empty and malformed responses safely", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("fixture-aurore"), /challenge/i);
  await assert.rejects(() => module.extractChapters("fixture-aurore"), /challenge/i);
  await assert.rejects(() => module.extractImages("fixture-aurore-chapitre-3"), /challenge/i);

  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response(await fixture("malformed.html")));
  assert.deepEqual(plain(await malformedModule.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain((await malformedModule.searchResults("fixture", 1)).items), []);
});

test("Sushi Scan manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/sushiscan/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/sushiscan/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
