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
    json: async () => { throw new Error("not json"); },
  };
}

async function load(fetchv2) {
  const source = await readFile(path.join(root, "index.js"), "utf8");
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: path.join(root, "index.js") }).runInContext(context);
  return context.SynthetiqModule;
}

test("Sushi Scan degrades blocked browse and search to empty lists", async () => {
  const challenge = await fixture("challenge.html");
  const expected = JSON.parse(await fixture("expected.json"));
  const module = await load(async () => response(challenge));

  assert.deepEqual(plain(await module.discoveryHome()), expected.discoveryBlocked);
  assert.deepEqual(plain(await module.discoveryFeed("browse", 1)), expected.emptyList);
  // Unknown feeds resolve to the catalogue feed, never to an error.
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("unknown", 1)),
    plain(await module.discoveryFeed("browse", 1)),
  );
  assert.deepEqual(plain(await module.searchResults("naruto", 1)), expected.emptyList);
  // Details, chapters and images fail closed on the challenge.
  await assert.rejects(() => module.extractDetails("https://sushiscan.net/serie-inventee/"), /challenge/i);
  await assert.rejects(() => module.extractChapters("https://sushiscan.net/serie-inventee/"), /challenge/i);
  await assert.rejects(() => module.extractImages("https://sushiscan.net/serie-inventee/chapitre-1/"), /challenge/i);
});

test("Sushi Scan rejects error, empty and malformed responses", async () => {
  const failed = await load(async () => response("Not Found", 404));
  assert.deepEqual(plain(await failed.discoveryHome()), {
    sections: [{ id: "browse", title: "Catalogue", items: [] }],
  });
  assert.deepEqual(plain(await failed.searchResults("naruto", 1)), { items: [], hasMore: false });
  await assert.rejects(() => failed.extractDetails("https://sushiscan.net/serie-inventee/"), /HTTP 404/i);

  const empty = await load(async () => response(""));
  assert.deepEqual(plain(await empty.discoveryFeed("browse", 1)), { items: [], hasMore: false });
  await assert.rejects(() => empty.extractChapters("https://sushiscan.net/serie-inventee/"), /empty/i);

  // A readable page without observed selectors is rejected, never guessed.
  const unknown = await load(async () => response(await fixture("readable-unknown.html")));
  await assert.rejects(() => unknown.extractDetails("https://sushiscan.net/serie-inventee/"), /not supported yet/i);
  await assert.rejects(() => unknown.extractChapters("https://sushiscan.net/serie-inventee/"), /not supported yet/i);
  await assert.rejects(() => unknown.extractImages("https://sushiscan.net/serie-inventee/chapitre-1/"), /not supported yet/i);
});

test("Sushi Scan rejects invalid and off-host identifiers", async () => {
  const challenge = await fixture("challenge.html");
  const module = await load(async () => response(challenge));

  // A bare slug resolves to a site URL and then fails on the challenge.
  await assert.rejects(() => module.extractDetails("just-a-slug"), /challenge|not a series URL|invalid/i);
  await assert.rejects(() => module.extractDetails("https://sushiscan.net/"), /not a series URL/i);
  await assert.rejects(() => module.extractDetails("https://evil.example/manga/x"), /host|identifier/i);
  await assert.rejects(() => module.extractDetails("http://sushiscan.net/serie/"), /host|identifier/i);
  await assert.rejects(() => module.extractImages("not a url \\"), /challenge|identifier|host/i);
  assert.deepStrictEqual(
    plain(await module.discoveryFeed("browse", 0)),
    plain(await module.discoveryFeed("browse", 1)),
  );
  assert.deepStrictEqual(plain(await module.searchResults("", 1)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.searchResults("naruto", 2)), { items: [], hasMore: false });
  assert.deepStrictEqual(plain(await module.discoveryFeed("browse", 3)), { items: [], hasMore: false });
});

test("Sushi Scan uses only bridge-safe request headers", async () => {
  const seen = [];
  const module = await load(async (url, headers, method) => {
    seen.push({ headers, method });
    return response(await fixture("challenge.html"));
  });
  await module.discoveryHome();
  await module.searchResults("naruto", 1);
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!("User-Agent" in call.headers), "User-Agent must not be set on fetchv2");
    assert.ok(!("Host" in call.headers), "Host must not be set on fetchv2");
  }
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
