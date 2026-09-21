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
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
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
    assert.ok(["anime-sama.to", "cdn.jsdelivr.net"].includes(parsed.hostname), `unapproved host ${parsed.hostname}`);
    if (url === "https://anime-sama.to/") return response(fixtures.catalogue);
    if (url === "https://anime-sama.to/catalogue/") return response(fixtures.cataloguePage);
    if (url === "https://anime-sama.to/catalogue/fixture-aurore/scan/vf/") return response(fixtures.series);
    if (url === "https://anime-sama.to/catalogue/fixture-lueur/scan/vf/") return response(fixtures.seriesLueur);
    if (url === "https://anime-sama.to/catalogue/fixture-anime/scan/vf/") return response("Not Found", 404);
    if (url.startsWith("https://anime-sama.to/s2/scans/get_nb_chap_et_img.php")) {
      if (url.includes("Fixture%20Aurore") || url.includes("Fixture%20Lueur")) {
        return response(fixtures.chapters);
      }
      return response(fixtures.chaptersError);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("Anime Sama discovery, search, details, chapters and images match expected.json", async () => {
  const fixtures = {
    catalogue: await fixture("catalogue.html"),
    cataloguePage: await fixture("catalogue-page.html"),
    series: await fixture("series.html"),
    seriesLueur: await fixture("series-lueur.html"),
    chapters: await fixture("chapters.json"),
    chaptersError: await fixture("chapters-error.json"),
  };
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(router(fixtures));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const item of expected.discovery.sections[0].items) {
    assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
    assert.match(item.href, /^https:\/\/anime-sama\.to\/catalogue\//);
    assert.ok(item.image === "" || item.image.startsWith("https://"), "cover must be HTTPS");
  }
  // Duplicates, unsafe titles, untitled cards and anime-only homepage
  // cards never surface; catalogue-only works are appended after.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }, { id: "fixture-brume" }, { id: "fixture-lueur" }, { id: "fixture-anime" }],
  );
  assert.deepEqual(plain(await module.discoveryFeed("scans", 1)), {
    items: expected.discovery.sections[0].items,
    hasMore: false,
  });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), expected.search);
  assert.deepEqual(
    plain((await module.searchResults("BRUME", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "fixture-brume" }],
  );
  assert.deepEqual(plain(await module.extractDetails("fixture-aurore")), expected.details);
  // Catalogue-only works resolve too; status mapping applies (Terminé).
  const lueur = await module.extractDetails("fixture-lueur");
  assert.equal(lueur.title, "Fixture Lueur");
  assert.equal(lueur.status, "Completed");
  assert.equal((await module.extractChapters("fixture-lueur")).length, 3);
  // Works without a scan version are excluded with a clear message.
  await assert.rejects(() => module.extractDetails("fixture-anime"), /no scan version/i);
  assert.deepEqual(
    plain(await module.extractChapters("https://anime-sama.to/catalogue/fixture-aurore/scan/vf/")),
    expected.chapters,
  );
  // Complete chapter list, oldest-first, never capped.
  assert.equal((await module.extractChapters("fixture-aurore")).length, 3);
  const images = await module.extractImages(expected.chapters[0].id);
  assert.deepEqual(plain(images), expected.images);
  for (const image of images) {
    assert.match(image.url, /^https:\/\/anime-sama\.to\/s2\/scans\//);
    assert.equal(image.headers.Referer, "https://anime-sama.to/catalogue/fixture-aurore/scan/vf/");
  }
});

test("Anime Sama rejects unsafe, empty, challenge and invalid inputs", async () => {
  const fixtures = {
    catalogue: await fixture("catalogue.html"),
    cataloguePage: await fixture("catalogue-page.html"),
    series: await fixture("series.html"),
    seriesLueur: await fixture("series-lueur.html"),
    chapters: await fixture("chapters.json"),
    chaptersError: await fixture("chapters-error.json"),
  };
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("https://evil.example/manga/x"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("https://anime-sama.to/"), /not a series URL/i);
  await assert.rejects(() => module.extractDetails("https://anime-sama.to/catalogue/"), /not a series URL/i);
  await assert.rejects(() => module.extractImages("https://anime-sama.to/catalogue/fixture-aurore/scan/vf/"), /not a chapter URL/i);
  await assert.rejects(() => module.extractImages("not a url \\"), /identifier|host|chapter/i);
  await assert.rejects(
    () => module.extractChapters("https://anime-sama.to/catalogue/fixture-pp/scan/vf/"),
    /Unexpected URL|no chapter data|failed/i,
  );
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown", 1)),
    plain(await module.discoveryFeed("scans", 1)),
  );
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("scans", 0)),
    plain(await module.discoveryFeed("scans", 1)),
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("aurore", 2)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.discoveryFeed("scans", 3)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("requête qui ne matche rien du tout", 1)),
    { items: [], hasMore: false },
  );
});

test("Anime Sama uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    if (url === "https://anime-sama.to/") return response(await fixture("catalogue.html"));
    throw new Error(`Unexpected URL: ${url}`);
  });
  await module.discoveryHome();
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!("User-Agent" in call.headers), "User-Agent must not be set on fetchv2");
    assert.ok(!("Host" in call.headers), "Host must not be set on fetchv2");
  }
});

test("Anime Sama degrades failed feeds to empty lists instead of throwing", async () => {
  const catalogue = await fixture("catalogue.html");
  void catalogue;
  const module = await load(async () => {
    throw new Error("Anime Sama request failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), {
    sections: [{ id: "scans", title: "Scans", items: [] }],
  });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), { items: [], hasMore: false });
});

test("Anime Sama degrades challenge, empty and malformed responses to empty lists", async () => {
  const module = await load(async () => response("<html><head><title>Just a moment...</title></head></html>"));
  assert.deepEqual(plain(await module.discoveryHome()), {
    sections: [{ id: "scans", title: "Scans", items: [] }],
  });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("fixture-aurore"), /challenge/i);

  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("scans", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response("<html><body>sans structure</body></html>"));
  await assert.rejects(() => malformedModule.extractDetails("fixture-aurore"), /empty after cleaning/i);
});

test("Anime Sama manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/anime-sama/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/anime-sama/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
