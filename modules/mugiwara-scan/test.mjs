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
      ["www.mugiwara-no-streaming.com", "scans.mugiwara-no-streaming.com", "static.mugiwara-no-streaming.com"]
        .includes(parsed.hostname),
      `unapproved host ${parsed.hostname}`,
    );
    if (parsed.pathname === "/sitemap.xml") return response(fixtures.sitemap);
    if (parsed.pathname === "/api/taille-proxy") {
      if (parsed.searchParams.get("slug") === "FixtureAurore") return response(fixtures.chapters);
      return response("Not Found", 404);
    }
    if (parsed.pathname === "/catalogue/fixture-aurore" || parsed.pathname === "/catalogue/fixture-aurore/") {
      return response(fixtures.details);
    }
    if (parsed.pathname === "/catalogue/fixture-boreal") return response(fixtures.detailsAnime);
    if (parsed.pathname === "/catalogue/fixture-interdit") return response(fixtures.detailsAdult);
    if (parsed.pathname === "/catalogue/fixture-versions") return response(fixtures.detailsVersions);
    if (parsed.pathname === "/catalogue/fixture-unknown") return response("Not Found", 404);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function loadFixtures() {
  return {
    sitemap: await fixture("sitemap.xml"),
    details: await fixture("details.html"),
    detailsAnime: await fixture("details-anime.html"),
    detailsAdult: await fixture("details-adult.html"),
    detailsVersions: await fixture("details-versions.html"),
    chapters: await fixture("chapters.json"),
  };
}

test("Mugiwara No Scans discovery, search, details, chapters and images match expected.json", async () => {
  const fixtures = await loadFixtures();
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(router(fixtures));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    assert.equal(section.id, "catalogue", "stable section id");
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href, "item schema");
      assert.match(item.href, /^https:\/\/www\.mugiwara-no-streaming\.com\/catalogue\//);
    }
  }
  // Duplicates and episode/scan subpages never reach the catalogue.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id, title }) => ({ id, title }))),
    [
      { id: "https://www.mugiwara-no-streaming.com/catalogue/fixture-aurore", title: "Fixture Aurore" },
      { id: "https://www.mugiwara-no-streaming.com/catalogue/fixture-boreal", title: "Fixture Boreal" },
      { id: "https://www.mugiwara-no-streaming.com/catalogue/fixture-interdit", title: "Fixture Interdit" },
    ],
  );
  assert.deepEqual(plain(await module.discoveryFeed("catalogue", 1)), {
    items: expected.discovery.sections[0].items,
    hasMore: false,
  });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), expected.search);
  assert.deepEqual(
    plain((await module.searchResults("FIXTURE", 1)).items.map(({ id }) => ({ id }))),
    [
      { id: "https://www.mugiwara-no-streaming.com/catalogue/fixture-aurore" },
      { id: "https://www.mugiwara-no-streaming.com/catalogue/fixture-boreal" },
      { id: "https://www.mugiwara-no-streaming.com/catalogue/fixture-interdit" },
    ],
  );
  assert.deepEqual(plain(await module.extractDetails(expected.details.id)), expected.details);
  assert.deepEqual(
    plain(await module.extractDetails("fixture-aurore")),
    expected.details,
    "bare slugs resolve too",
  );
  // Anime-only works are excluded with a clear message, and their chapter
  // list degrades to a clean empty array instead of failing the screen.
  await assert.rejects(() => module.extractDetails("fixture-boreal"), /no scan version/i);
  assert.deepEqual(plain(await module.extractChapters("fixture-boreal")), []);
  // Server-flagged adult titles are rejected, never listed for reading.
  await assert.rejects(() => module.extractDetails("fixture-interdit"), /adult-only/i);
  // The taille-proxy map yields the complete chapter list, oldest-first,
  // never capped, every chapter carrying the series cover.
  const chapters = await module.extractChapters(expected.details.id);
  assert.deepEqual(plain(chapters), expected.chapters);
  assert.deepEqual(
    plain(chapters.map(({ number }) => ({ number }))),
    [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }],
  );
  assert.ok(chapters.every((chapter) => chapter.url.includes("/scans/original#chapitre-")));
  assert.ok(chapters.every((chapter) => chapter.coverUrl === expected.details.cover));
  assert.deepEqual(plain(chapters[0].manga), {
    id: expected.details.id,
    href: expected.details.href,
    url: expected.details.url,
    title: expected.details.title,
    cover: expected.details.cover,
  });
  // A series with spin-off versions[] uses its own top-level token: the
  // taille map is requested with the main IMAGE_URL, never the spin-off's.
  const tailleSlugs = [];
  const versionsModule = await load(async (url, headers, method, body, options) => {
    if (new URL(url).pathname === "/api/taille-proxy") {
      tailleSlugs.push(new URL(url).searchParams.get("slug"));
    }
    return router(fixtures)(url, headers, method, body, options);
  });
  const versionChapters = await versionsModule.extractChapters("fixture-versions");
  assert.deepEqual(
    plain(versionChapters.map(({ number }) => ({ number }))),
    [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }],
  );
  assert.ok(versionChapters.every((chapter) => chapter.id.includes("/catalogue/fixture-versions/scans/")));
  assert.deepEqual(tailleSlugs, ["FixtureAurore"]);
  // Page images follow the scans host pattern in order, with the scans page
  // as Referer.
  const images = await module.extractImages(chapters[0].id);
  assert.deepEqual(plain(images), expected.images);
  for (const image of images) {
    assert.match(image.url, /^https:\/\/scans\.mugiwara-no-streaming\.com\/FixtureAurore\/1\/\d+\.jpg$/);
    assert.equal(image.headers.Referer, "https://www.mugiwara-no-streaming.com/catalogue/fixture-aurore/scans/original");
  }
  // This pageImages module exposes no text or publication terminal.
  assert.equal(typeof module.extractText, "undefined", "mugiwara-no-streaming must not expose text");
  assert.equal(typeof module.extractResources, "undefined", "mugiwara-no-streaming must not expose resources");
});

test("Mugiwara No Scans rejects unsafe, empty, foreign and invalid inputs", async () => {
  const fixtures = await loadFixtures();
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("https://evil.example/catalogue/fixture-aurore"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("https://www.mugiwara-no-streaming.com/populaires"), /catalogue path|identifier/i);
  await assert.rejects(() => module.extractChapters("not a url \\\\"), /identifier|host/i);
  await assert.rejects(
    () => module.extractImages("https://evil.example/catalogue/fixture-aurore/scans/original#chapitre-1"),
    /host|identifier|chapter/i,
  );
  await assert.rejects(() => module.extractImages("fixture-aurore"), /chapter URL|identifier/i);
  await assert.rejects(
    () => module.extractImages("https://www.mugiwara-no-streaming.com/catalogue/fixture-aurore/scans/original#chapitre-0"),
    /chapter number/i,
  );
  // Unknown titles have no taille payload: strict failure, not an invention.
  await assert.rejects(() => module.extractChapters("fixture-unknown"), /HTTP 404|no chapter list/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown-feed", 1)),
    plain(await module.discoveryFeed("catalogue", 1)),
  );
  assert.deepStrictEqual(
    plain(await module.searchResults("aurore", 0)),
    plain(await module.searchResults("aurore", 1)),
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("hentai", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("zzzintrouvable", 1)),
    { items: [], hasMore: false },
  );
});

test("Mugiwara No Scans uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    return response(await fixture("sitemap.xml"));
  });
  await module.discoveryHome();
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!("User-Agent" in call.headers), "User-Agent must not be set on fetchv2");
    assert.ok(!("Host" in call.headers), "Host must not be set on fetchv2");
  }
});

test("Mugiwara No Scans degrades failed feeds to empty lists instead of throwing", async () => {
  const module = await load(async () => {
    throw new Error("Mugiwara No Scans request failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await module.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });
});

test("Mugiwara No Scans degrades challenge, empty and malformed responses safely", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("fixture-aurore"), /challenge/i);
  await assert.rejects(() => module.extractChapters("fixture-aurore"), /challenge/i);
  await assert.rejects(
    () => module.extractImages("https://www.mugiwara-no-streaming.com/catalogue/fixture-aurore/scans/original#chapitre-1"),
    /challenge/i,
  );

  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response(await fixture("malformed.html")));
  assert.deepEqual(plain(await malformedModule.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain((await malformedModule.searchResults("aurore", 1)).items), []);
});

test("Mugiwara No Scans does not retry a timed-out chapter handler", async () => {
  let calls = 0;
  const module = await load(async () => {
    calls += 1;
    throw new Error("fixture timeout");
  });

  await assert.rejects(
    module.extractImages("https://www.mugiwara-no-streaming.com/catalogue/fixture-aurore/scans/original#chapitre-44"),
    /fixture timeout/,
  );
  assert.equal(calls, 1, "a chapter timeout must not fan out into nested retries");
});

test("Mugiwara No Scans manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/mugiwara-scan/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/mugiwara-scan/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
