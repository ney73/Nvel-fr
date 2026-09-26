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
    assert.equal(parsed.hostname, "j-garden.fr", `unapproved host ${parsed.hostname}`);
    if (parsed.pathname === "/fixture-aurore/") return response(fixtures.details);
    if (parsed.pathname === "/fixture-gate/") return response(fixtures.gated);
    if (parsed.pathname === "/fixture-aurore-t-1/") return response(fixtures.post);
    if (parsed.pathname.startsWith("/page/")) return response(fixtures.searchPage2);
    if (parsed.pathname === "/" && !parsed.searchParams.has("s")) return response(fixtures.home);
    if (parsed.searchParams.has("s")) {
      const query = parsed.searchParams.get("s") || "";
      if (/introuvable/i.test(query)) return response(fixtures.searchEmpty);
      if (/exclu/i.test(query)) return response(fixtures.searchExcluded);
      return response(fixtures.search);
    }
    if (["/jg-manga/", "/jg-ln/", "/actualites/", "/series-en-terminees/"].includes(parsed.pathname)) {
      return response(fixtures.home);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function loadFixtures() {
  return {
    home: await fixture("home.html"),
    search: await fixture("search.html"),
    searchPage2: await fixture("search-page-2.html"),
    searchEmpty: await fixture("search-empty.html"),
    searchExcluded: await fixture("search-excluded.html"),
    details: await fixture("details.html"),
    gated: await fixture("details-gated.html"),
    post: await fixture("post.html"),
  };
}

test("JGarden discovery, search, details, chapters and resources match expected.json", async () => {
  const fixtures = await loadFixtures();
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(router(fixtures));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
      assert.match(item.href, /^https:\/\/j-garden\.fr\//);
      assert.ok(item.image === "" || item.image.startsWith("https://"), "cover must be HTTPS");
      assert.ok(!item.href.includes("#"), "href must not carry a fragment");
    }
  }
  // Banner without alt text falls back to the humanized slug, duplicates merge.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }, { id: "fixture-boreal" }, { id: "fixture-aurore-t-1" }, { id: "fixture-boreal-t-1" }],
  );
  assert.deepEqual(plain(await module.discoveryFeed("manga", 1)).items, expected.discovery.sections[0].items);
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), expected.search);
  // Second search page carries the remaining item and closes pagination.
  const page2 = await module.searchResults("fixture", 2);
  assert.deepEqual(plain(page2.items.map(({ id }) => ({ id }))), [{ id: "fixture-cendre" }]);
  assert.equal(page2.hasMore, false);
  assert.deepEqual(plain(await module.extractDetails("fixture-aurore")), expected.details);
  assert.deepEqual(
    plain(await module.extractDetails("https://j-garden.fr/fixture-aurore/")),
    expected.details,
  );
  // The complete volume list is never capped and stays oldest-first,
  // including volumes with no download button yet.
  const chapters = await module.extractChapters("fixture-aurore");
  assert.deepEqual(plain(chapters), expected.chapters);
  assert.ok(chapters.every((chapter) => chapter.id.startsWith("fixture-aurore#volume-")));
  const resources = await module.extractResources("fixture-aurore");
  assert.deepEqual(plain(resources), expected.resources);
  for (const resource of resources) {
    assert.ok(["pdf", "epub"].includes(resource.format), "resource format");
    assert.match(resource.url, /^https:\/\/j-garden\.fr\//);
    assert.ok(resource.fileName.endsWith(`.${resource.format}`), "file extension");
    assert.equal(resource.headers.Referer, "https://j-garden.fr/fixture-aurore/");
  }
  // Ad-gated shortener links are excluded from downloads but their volumes
  // stay listed as chapters.
  const gatedChapters = await module.extractChapters("https://j-garden.fr/fixture-gate/");
  assert.deepEqual(
    plain(gatedChapters.map(({ title, number }) => ({ title, number }))),
    [{ title: "Volume 1", number: 1 }, { title: "Volume 2", number: 2 }],
  );
  assert.deepEqual(plain(await module.extractResources("fixture-gate")), []);
  // A release post carries no volume list: no invented chapters.
  const postChapters = await module.extractChapters("fixture-aurore-t-1");
  assert.deepEqual(plain(postChapters), []);
  // This publication module exposes no text terminal.
  assert.equal(typeof module.extractText, "undefined", "jgarden must not expose text");
  assert.equal(typeof module.extractImages, "undefined", "jgarden must not expose images");
});

test("JGarden rejects unsafe, empty, listing and invalid inputs", async () => {
  const fixtures = await loadFixtures();
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("https://evil.example/fixture-aurore/"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("jg-manga"), /listing|identifier/i);
  await assert.rejects(() => module.extractDetails("https://j-garden.fr/jg-manga/"), /listing|identifier/i);
  await assert.rejects(() => module.extractDetails("https://j-garden.fr/wp-json/"), /endpoint|identifier/i);
  await assert.rejects(() => module.extractChapters("not a url \\\\"), /identifier|host/i);
  await assert.rejects(() => module.extractResources("https://evil.example/fixture-aurore/"), /host|identifier/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown-feed", 1)),
    plain(await module.discoveryFeed("manga", 1)),
  );
  assert.ok((await module.discoveryFeed("manga", 1)).items.length > 0, "default feed must be non-empty");
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("manga", 0)),
    plain(await module.discoveryFeed("manga", 1)),
  );
  assert.deepStrictEqual(
    plain(await module.searchResults("fixture", 0)),
    plain(await module.searchResults("fixture", 1)),
  );
  // Explicit sexual markers never reach the catalogue, on queries or titles.
  assert.deepStrictEqual(plain(await module.searchResults("hentai", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain((await module.searchResults("exclu", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }],
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("zzzintrouvable", 1)),
    { items: [], hasMore: false },
  );
});

test("JGarden uses only bridge-safe request headers", async () => {
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

test("JGarden degrades failed feeds to empty lists instead of throwing", async () => {
  const module = await load(async () => {
    throw new Error("JGarden request failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await module.discoveryFeed("manga", 1)), { items: [], hasMore: false });
});

test("JGarden degrades challenge, empty and malformed responses safely", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [] });
  assert.deepEqual(plain(await module.searchResults("fixture", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("fixture-aurore"), /challenge/i);
  await assert.rejects(() => module.extractChapters("fixture-aurore"), /challenge/i);
  await assert.rejects(() => module.extractResources("fixture-aurore"), /challenge/i);

  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("manga", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response(await fixture("malformed.html")));
  assert.deepEqual(plain(await malformedModule.discoveryFeed("manga", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await malformedModule.searchResults("fixture", 1)).items, []);
});

test("JGarden manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/j-garden/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/j-garden/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
