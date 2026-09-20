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
    contentType: typeof body === "string" && body.trim().startsWith("<") ? "text/html" : "application/json",
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
    assert.equal(parsed.hostname, "novelneko.fr", `unapproved host ${parsed.hostname}`);
    if (parsed.pathname === "/webnovels/webnovel.json") return response(fixtures.catalogue);
    if (parsed.pathname === "/webnovels/fixture-aurore/") return response(fixtures.novel);
    if (parsed.pathname === "/webnovels/fixture-brume/") return response(fixtures.brume);
    if (parsed.pathname === "/webnovels/fixture-unsafe/") return response(fixtures.unsafe);
    if (parsed.pathname === "/webnovels/fixture-empty/") return response(fixtures.empty);
    if (parsed.pathname === "/webnovels/fixture-aurore/chapters/chapitre_001.txt") {
      return response(fixtures.chapter);
    }
    if (parsed.pathname.startsWith("/webnovels/fixture-aurore/chapters/")) {
      return response("Not Found", 404);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("NovelNeko discovery, search, details, chapters and text match expected.json", async () => {
  const fixtures = {
    catalogue: await fixture("webnovel.json"),
    novel: await fixture("novel.html"),
    brume: await fixture("novel-brume.html"),
    unsafe: await fixture("novel-unsafe.html"),
    empty: await fixture("novel-empty.html"),
    chapter: await fixture("chapitre_001.txt"),
  };
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(router(fixtures));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discovery);
  for (const section of expected.discovery.sections) {
    for (const item of section.items) {
      assert.ok(item.id && item.title && item.href && typeof item.image === "string", "item schema");
      assert.match(item.href, /^https:\/\/novelneko\.fr\//);
      assert.ok(item.image === "" || item.image.startsWith("https://"), "cover must be HTTPS");
    }
  }
  // Duplicates, unsafe titles and untitled entries never reach the catalogue.
  assert.deepEqual(
    plain((await module.discoveryHome()).sections[0].items.map(({ id }) => ({ id }))),
    [{ id: "fixture-aurore" }, { id: "fixture-brume" }],
  );
  assert.deepEqual(plain(await module.discoveryFeed("webnovels", 1)), {
    items: expected.discovery.sections[0].items,
    hasMore: false,
  });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), expected.search);
  // Accent-insensitive matching: "brume" matches "Brume", and the Ecchi
  // genre on Fixture Brume never blocks a mainstream title.
  assert.deepEqual(
    plain((await module.searchResults("BRUME", 1)).items.map(({ id }) => ({ id }))),
    [{ id: "fixture-brume" }],
  );
  assert.deepEqual(plain(await module.extractDetails("fixture-aurore")), expected.details);
  assert.deepEqual(
    plain(await module.extractChapters("https://novelneko.fr/webnovels/fixture-aurore/")),
    expected.chapters,
  );
  // The complete chapter list is never capped: Brume declares 2 chapters.
  assert.equal((await module.extractChapters("fixture-brume")).length, 2);
  assert.equal(
    await module.extractText("https://novelneko.fr/webnovels/fixture-aurore/lecture.html?chapitre=1"),
    expected.text,
  );
});

test("NovelNeko rejects unsafe, empty, challenge and invalid inputs", async () => {
  const fixtures = {
    catalogue: await fixture("webnovel.json"),
    novel: await fixture("novel.html"),
    brume: await fixture("novel-brume.html"),
    unsafe: await fixture("novel-unsafe.html"),
    empty: await fixture("novel-empty.html"),
    chapter: await fixture("chapitre_001.txt"),
  };
  const module = await load(router(fixtures));

  await assert.rejects(() => module.extractDetails("fixture-unsafe"), /safety filter/i);
  await assert.rejects(() => module.extractChapters("fixture-empty"), /no chapter list/i);
  await assert.rejects(
    () => module.extractText("https://novelneko.fr/webnovels/fixture-aurore/lecture.html?chapitre=9"),
    /HTTP 404|unavailable/i,
  );
  await assert.rejects(() => module.extractDetails("https://evil.example/novel/x"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("https://novelneko.fr/lightnovels/mushoku-tensei/"), /novel URL|identifier/i);
  await assert.rejects(() => module.extractText("not a url \\"), /identifier|host/i);
  await assert.rejects(
    () => module.extractText("https://novelneko.fr/webnovels/fixture-aurore/lecture.html"),
    /chapter number/i,
  );
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown", 1)),
    plain(await module.discoveryFeed("webnovels", 1)),
  );
  assert.ok((await module.discoveryFeed("webnovels", 1)).items.length > 0, "default feed must be non-empty");
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("webnovels", 0)),
    plain(await module.discoveryFeed("webnovels", 1)),
  );
  assert.deepStrictEqual(
    plain(await module.searchResults("aurore", 0)),
    plain(await module.searchResults("aurore", 1)),
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("aurore", 2)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.discoveryFeed("webnovels", 3)), { items: [], hasMore: false });
  assert.deepStrictEqual(
    plain(await module.searchResults("requête qui ne matche rien du tout", 1)),
    { items: [], hasMore: false },
  );
});

test("NovelNeko uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    const parsed = new URL(url);
    if (parsed.pathname === "/webnovels/webnovel.json") return response(await fixture("webnovel.json"));
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

test("NovelNeko degrades failed feeds to empty lists instead of throwing", async () => {
  const catalogue = await fixture("webnovel.json");
  void catalogue;
  const module = await load(async () => {
    throw new Error("NovelNeko catalogue request failed with HTTP 500.");
  });

  const home = await module.discoveryHome();
  assert.deepEqual(plain(home), { sections: [{ id: "webnovels", title: "Web-Novels", items: [] }] });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), { items: [], hasMore: false });
});

test("NovelNeko degrades challenge, empty and malformed responses to empty lists", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));
  assert.deepEqual(plain(await module.discoveryHome()), {
    sections: [{ id: "webnovels", title: "Web-Novels", items: [] }],
  });
  assert.deepEqual(plain(await module.searchResults("aurore", 1)), { items: [], hasMore: false });
  await assert.rejects(() => module.extractDetails("fixture-aurore"), /challenge/i);

  const emptyModule = await load(async () => response(""));
  assert.deepEqual(plain(await emptyModule.discoveryFeed("webnovels", 1)), { items: [], hasMore: false });

  const malformedModule = await load(async () => response("ceci n'est pas du JSON {"));
  assert.deepEqual(plain(await malformedModule.discoveryFeed("webnovels", 1)), { items: [], hasMore: false });
});

test("NovelNeko manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/novelneko-wn/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/novelneko-wn/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
