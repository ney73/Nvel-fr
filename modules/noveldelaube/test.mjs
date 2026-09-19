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
  await assert.rejects(() => module.discoveryFeed("unknown", 1), /feed is unknown/i);
  await assert.rejects(() => module.discoveryFeed("catalogue", 0), /pagination page is invalid/i);
  await assert.rejects(() => module.searchResults("dawn", 0), /pagination page is invalid/i);
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("dawn", 2)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.discoveryFeed("catalogue", 3)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("https://evil.example/novel/x"), /host|identifier/i);
  await assert.rejects(() => module.extractText("not a url \\"), /identifier|host/i);
});

test("NovelDeLAube rejects browser challenges and empty responses", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  await assert.rejects(() => module.discoveryHome(), /challenge/i);
  const emptyModule = await load(async () => response(""));
  await assert.rejects(() => emptyModule.discoveryHome(), /empty response/i);
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
