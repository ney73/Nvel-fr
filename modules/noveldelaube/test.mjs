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
      parsed.hostname === "noveldelaube.com" || parsed.hostname.endsWith(".noveldelaube.com"),
      `unapproved host ${parsed.hostname}`,
    );
    if (parsed.pathname === "/notre_catalogue") return response(fixtures.catalogue);
    if (parsed.pathname === "/creations_originales") return response(fixtures.originals);
    if (parsed.pathname === "/notre_catalogue/Fixture_Dawn_A") return response(fixtures.novel);
    if (parsed.pathname === "/notre_catalogue/Fixture_Unsafe") return response(fixtures.unsafe);
    if (parsed.pathname === "/notre_catalogue/Fixture_Empty") return response(fixtures.empty);
    if (parsed.pathname.endsWith("/chapitre-un")) return response(fixtures.chapter);
    if (parsed.pathname.endsWith("/chapitre-vide")) return response(fixtures.chapterEmpty);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("NovelDeLAube discovery, search, details, chapters and text match expected.json", async () => {
  const fixtures = {
    catalogue: await fixture("catalogue.html"),
    originals: await fixture("originals.html"),
    novel: await fixture("novel.html"),
    unsafe: await fixture("novel-unsafe.html"),
    empty: await fixture("novel-empty.html"),
    chapter: await fixture("chapter.html"),
    chapterEmpty: await fixture("chapter-empty.html"),
  };
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(router(fixtures));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
      assert.match(item.href, /^https:\/\/[^/]*noveldelaube\.com\//);
      assert.ok(item.image === "" || item.image.startsWith("https://"), "cover must be HTTPS");
    }
  }
  assert.deepEqual(plain(await module.discoveryFeed("catalogue", 1)), {
    items: expected.discovery.sections[0].items,
    hasMore: false,
  });
  assert.deepEqual(plain(await module.searchResults("dawn", 1)), expected.search);
  assert.deepEqual(plain(await module.extractDetails("Fixture_Dawn_A")), expected.details);
  assert.deepEqual(
    plain(await module.extractChapters("https://www.noveldelaube.com/notre_catalogue/Fixture_Dawn_A")),
    expected.chapters,
  );
  assert.equal(
    await module.extractText("https://noveldelaube.com/notre_catalogue/Fixture_Dawn_A/tome_1/chapitre-un"),
    expected.text,
  );
});

test("NovelDeLAube rejects unsafe, empty, challenge and invalid inputs", async () => {
  const fixtures = {
    catalogue: await fixture("catalogue.html"),
    originals: await fixture("originals.html"),
    novel: await fixture("novel.html"),
    unsafe: await fixture("novel-unsafe.html"),
    empty: await fixture("novel-empty.html"),
    chapter: await fixture("chapter.html"),
    chapterEmpty: await fixture("chapter-empty.html"),
  };
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("Fixture_Unsafe"), /safety filter/i);
  await assert.rejects(() => module.extractChapters("Fixture_Empty"), /no chapter list/i);
  await assert.rejects(
    () => module.extractText("https://noveldelaube.com/notre_catalogue/Fixture_Dawn_A/tome_1/chapitre-vide"),
    /unavailable/i,
  );
  await assert.rejects(() => module.extractDetails("https://evil.example/novel/x"), /host|identifier/i);
  await assert.rejects(() => module.extractText("not a url \\"), /identifier|host/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown", 1)),
    plain(await module.discoveryFeed("all", 1)),
  );
  assert.ok((await module.discoveryFeed("all", 1)).items.length > 0, "default feed must be non-empty");
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("catalogue", 0)),
    plain(await module.discoveryFeed("catalogue", 1)),
  );
  assert.deepStrictEqual(
    plain(await module.searchResults("dawn", 0)),
    plain(await module.searchResults("dawn", 1)),
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("dawn", 2)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.discoveryFeed("catalogue", 3)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("https://evil.example/novel/x"), /host|identifier/i);
  await assert.rejects(() => module.extractText("not a url \\"), /identifier|host/i);
});

test("NovelDeLAube uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    const parsed = new URL(url);
    if (parsed.pathname === "/notre_catalogue") return response(await fixture("catalogue.html"));
    if (parsed.pathname === "/creations_originales") return response(await fixture("originals.html"));
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

test("NovelDeLAube degrades failed feeds to empty lists instead of throwing", async () => {
  const catalogue = await fixture("catalogue.html");
  const module = await load(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/notre_catalogue") return response(catalogue);
    throw new Error("NovelDeLAube originals page failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home.sections.map(({ id }) => ({ id }))), [
    { id: "all" },
    { id: "originals" },
  ]);
  assert.equal(home.sections[0].items.length, 2);
  assert.deepEqual(plain(home.sections[1].items), []);
  const search = await module.searchResults("dawn", 1);
  assert.deepEqual(plain(search.items.map(({ id }) => ({ id }))), [
    { id: "Fixture_Dawn_A" },
    { id: "Fixture_Dawn_B" },
  ]);

  const downModule = await load(async () => {
    throw new Error("NovelDeLAube catalogue page failed with HTTP 500.");
  });
  assert.deepEqual(plain(await downModule.discoveryHome()), { sections: [
    { id: "all", title: "Catalogue", items: [] },
    { id: "originals", title: "Originals", items: [] },
  ] });
  assert.deepEqual(plain(await downModule.searchResults("dawn", 1)), { items: [], hasMore: false });
});

test("NovelDeLAube falls back to loose title/link pairing and the www host", async () => {
  const loose = await fixture("catalogue-loose.html");
  const looseModule = await load(async () => response(loose));
  const looseFeed = await looseModule.discoveryFeed("catalogue", 1);
  assert.deepStrictEqual(plain(looseFeed.items.map(({ id, title, image }) => ({ id, title, image }))), [
    { id: "Fixture_Loose_A", title: "Fixture Loose A", image: "" },
    { id: "Fixture_Loose_B", title: "Fixture Loose B", image: "" },
  ]);

  const catalogue = await fixture("catalogue.html");
  const calls = [];
  const retryModule = await load(async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === "noveldelaube.com") throw new Error("apex host unreachable");
    if (parsed.pathname === "/notre_catalogue") return response(catalogue);
    throw new Error(`Unexpected URL: ${url}`);
  });
  const retryFeed = await retryModule.discoveryFeed("catalogue", 1);
  assert.equal(retryFeed.items.length, 2);
  assert.ok(calls.some((url) => new URL(url).hostname === "www.noveldelaube.com"), "www retry expected");
});

test("NovelDeLAube falls back to the embedded novel list when cards are absent", async () => {
  const html = '<html><body><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"CollectionPage",'
    + '"mainEntity":{"@type":"ItemList","itemListElement":['
    + '{"@type":"ListItem","position":1,"url":"https://www.noveldelaube.com/notre_catalogue/Fixture_Legacy","name":"Fixture Legacy"}'
    + ']}}</script></body></html>';
  const module = await load(async () => response(html));
  const feed = await module.discoveryFeed("catalogue", 1);
  assert.deepEqual(plain(feed.items.map(({ id, title, image }) => ({ id, title, image }))), [
    { id: "Fixture_Legacy", title: "Fixture Legacy", image: "" },
  ]);
});

test("NovelDeLAube degrades challenge and empty responses to empty lists", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [
    { id: "all", title: "Catalogue", items: [] },
    { id: "originals", title: "Originals", items: [] },
  ] });
  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("catalogue", 1)), { items: [], hasMore: false });
});

test("NovelDeLAube maps Saijo no Osewa to its Rich Girl Caretaker display title", async () => {
  const card = (slug, title) => '<div class="card kado_project"><div class="row">'
    + `<img src="https://www.noveldelaube.com/images/image_project/${slug}.webp" alt="${title}"/>`
    + `<h3 class="card-title h3-project">${title}</h3>`
    + '<div class="col-12 col-xl-5 fw-bold">Genre :</div><div class="col-12 col-xl-7">Comédie, Romance, School Life</div>'
    + `<a class="btn btn-secondary voirplus-project" href="/notre_catalogue/${slug}">Voir plus »</a>`
    + "</div></div>";
  const html = `<html><body>${card("Saijo_no_Osewa", "Saijo no Osewa - Takane no Hana")}</body></html>`;
  const module = await load(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/creations_originales") return response("<html></html>");
    return response(html);
  });

  const home = await module.discoveryHome();
  assert.equal(home.sections[0].items[0].title, "Rich Girl Caretaker");
  assert.equal(home.sections[0].items[0].id, "Saijo_no_Osewa");
  assert.deepEqual(
    plain((await module.searchResults("Rich Girl Caretaker", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "Saijo_no_Osewa" }],
  );
  assert.deepEqual(
    plain((await module.searchResults("Saijo no Osewa", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "Saijo_no_Osewa" }],
  );
  assert.deepEqual(
    plain((await module.searchResults("saijo", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "Saijo_no_Osewa" }],
  );
});

test("NovelDeLAube manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/noveldelaube/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/noveldelaube/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
