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

async function load(fetchv2, pagev2) {
  const source = await readFile(path.join(root, "index.js"), "utf8");
  const bridges = { URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, fetchv2 };
  if (pagev2 !== undefined) bridges.pagev2 = pagev2;
  const context = vm.createContext(bridges);
  context.globalThis = context;
  new vm.Script(source, { filename: path.join(root, "index.js") }).runInContext(context);
  return context.SynthetiqModule;
}

function router(fixtures) {
  return async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.ok(
      ["www.scan-manga.com", "static.scan-manga.com"].includes(parsed.hostname),
      `unapproved host ${parsed.hostname}`,
    );
    if (parsed.pathname === "/17107/Fixture-Aurore.html") return response(fixtures.details);
    if (parsed.pathname === "/17275/Fixture-Boreal.html") return response(fixtures.details);
    if (parsed.pathname === "/scanlation/liste_series.html") {
      if (/introuvable/i.test(parsed.searchParams.get("q") || "")) return response(fixtures.searchEmpty);
      return response(fixtures.search);
    }
    if (parsed.pathname === "/TOP-Manga-Webtoon-47.html") return response(fixtures.home);
    if (parsed.pathname === "/" || parsed.searchParams.has("home") || parsed.searchParams.has("po")) {
      return response(fixtures.home);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function pageRouter(fixtures, seen) {
  return async (task) => {
    seen.push(task);
    assert.equal(typeof task.url, "string");
    assert.ok(task.url.startsWith("https://www.scan-manga.com/lecture-en-ligne/"), "pagev2 must open the chapter URL");
    assert.equal(typeof task.returnScript, "string", "pagev2 must evaluate a render script");
    return { evaluatedData: JSON.parse(fixtures.images).evaluatedData };
  };
}

async function loadFixtures() {
  return {
    home: await fixture("home.html"),
    search: await fixture("search.html"),
    searchEmpty: await fixture("search-empty.html"),
    details: await fixture("details.html"),
    images: await fixture("images.json"),
  };
}

test("Scan-Manga discovery, search, details, chapters and images match expected.json", async () => {
  const fixtures = await loadFixtures();
  const expected = JSON.parse(await fixture("expected.json"));
  const seen = [];
  const module = await load(router(fixtures), pageRouter(fixtures, seen));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
      assert.match(item.href, /^https:\/\/www\.scan-manga\.com\/\d+/);
      assert.ok(item.image.startsWith("https://static.scan-manga.com/"), "cover must be an absolute static URL");
      assert.equal(item.coverUrl, item.cover, "cover alias must match");
    }
  }
  // Unsafe titles and duplicates never reach the catalogue.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id }) => ({ id }))),
    [{ id: "17107/Fixture-Aurore" }, { id: "17275/Fixture-Boreal" }],
  );
  assert.deepEqual(plain((await module.discoveryFeed("top", 1)).items), expected.discovery.sections[0].items);
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), expected.search);
  assert.deepEqual(
    plain((await module.searchResults("FIXTURE", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "17107/Fixture-Aurore" }, { id: "17275/Fixture-Boreal" }],
  );
  assert.deepEqual(plain(await module.extractDetails("17107/Fixture-Aurore")), expected.details);
  assert.deepEqual(
    plain(await module.extractDetails("https://www.scan-manga.com/17107/Fixture-Aurore.html")),
    expected.details,
  );
  // The complete chapter list is never capped, stays oldest-first, and drops
  // external mirrors plus unsafe entries.
  const chapters = await module.extractChapters("17107/Fixture-Aurore");
  assert.deepEqual(plain(chapters), expected.chapters);
  assert.ok(chapters.every((chapter) => chapter.url.startsWith("https://www.scan-manga.com/lecture-en-ligne/")));
  assert.equal(chapters.some((chapter) => chapter.number === 99), false);
  // Page images come from the app-owned WebKit snapshot, in render order.
  const images = await module.extractImages("Fixture-Aurore-Chapitre-3-FR_573871");
  assert.deepEqual(plain(images), expected.images);
  for (const image of images) {
    assert.match(image.url, /^https:\/\/static\.scan-manga\.com\//);
    assert.equal(image.headers.Referer, "https://www.scan-manga.com/lecture-en-ligne/Fixture-Aurore-Chapitre-3-FR_573871.html");
  }
  assert.ok(seen.length > 0 && seen.every((task) => typeof task.returnScript === "string"));
  // This pageImages module exposes no text terminal.
  assert.equal(typeof module.extractText, "undefined", "scan-manga must not expose text");
  assert.equal(typeof module.extractResources, "undefined", "scan-manga must not expose resources");
});

test("Scan-Manga rejects unsafe, empty, foreign and invalid inputs", async () => {
  const fixtures = await loadFixtures();
  const module = await load(router(fixtures), pageRouter(fixtures, []));

  await assert.rejects(() => module.extractDetails("https://evil.example/17107/Fixture-Aurore.html"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("https://www.scan-manga.com/team-1268/DASSOU-Scan.html"), /series path|identifier/i);
  await assert.rejects(() => module.extractDetails("Favoris.html"), /series path|identifier/i);
  await assert.rejects(() => module.extractChapters("not a url \\\\"), /identifier|host/i);
  await assert.rejects(() => module.extractImages("https://evil.example/lecture-en-ligne/x.html"), /host|identifier/i);
  await assert.rejects(() => module.extractImages("17107/Fixture-Aurore"), /chapter path|identifier/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown-feed", 1)),
    plain(await module.discoveryFeed("latest", 1)),
  );
  assert.ok((await module.discoveryFeed("latest", 1)).items.length > 0, "default feed must be non-empty");
  assert.deepStrictEqual(
    plain(await module.searchResults("fixture", 2)),
    { items: [], hasMore: false },
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("hentai", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("zzzintrouvable", 1)),
    { items: [], hasMore: false },
  );
});

test("Scan-Manga extracts images only through the pagev2 bridge", async () => {
  const fixtures = await loadFixtures();
  const bridgeless = await load(router(fixtures));
  await assert.rejects(
    () => bridgeless.extractImages("Fixture-Aurore-Chapitre-3-FR_573871"),
    /pagev2/i,
  );

  const foreign = await load(router(fixtures), async () => ({
    evaluatedData: ["https://evil.example/page1.jpg"],
  }));
  await assert.rejects(() => foreign.extractImages("Fixture-Aurore-Chapitre-3-FR_573871"), /no page images/i);

  const empty = await load(router(fixtures), async () => ({ evaluatedData: [] }));
  await assert.rejects(() => empty.extractImages("Fixture-Aurore-Chapitre-3-FR_573871"), /no page images/i);
});

test("Scan-Manga uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    return response(await fixture("home.html"));
  }, async () => ({ evaluatedData: [] }));
  await module.discoveryHome();
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!("User-Agent" in call.headers), "User-Agent must not be set on fetchv2");
    assert.ok(!("Host" in call.headers), "Host must not be set on fetchv2");
  }
});

test("Scan-Manga degrades failed feeds to empty lists instead of throwing", async () => {
  const module = await load(async () => {
    throw new Error("Scan-Manga request failed with HTTP 500.");
  }, async () => ({ evaluatedData: [] }));

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await module.discoveryFeed("top", 1)), { items: [], hasMore: false });
});

test("Scan-Manga degrades challenge, empty and malformed responses safely", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge), async () => ({ evaluatedData: [] }));
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("17107/Fixture-Aurore"), /challenge/i);
  await assert.rejects(() => module.extractChapters("17107/Fixture-Aurore"), /challenge/i);

  const emptyModule = await load(async () => response(""), async () => ({ evaluatedData: [] }));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("top", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response(await fixture("malformed.html")), async () => ({ evaluatedData: [] }));
  assert.deepEqual(plain(await malformedModule.discoveryFeed("top", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain((await malformedModule.searchResults("fixture", 1)).items), []);
});

test("Scan-Manga manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/scan-manga/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/scan-manga/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
