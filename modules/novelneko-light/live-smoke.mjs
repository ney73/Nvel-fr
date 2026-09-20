#!/usr/bin/env node
/**
 * Bounded live smoke proof for the Novel Neko Light publication module.
 * Lists catalogue, details and volume resources for one representative
 * title. File bodies are never downloaded: only links are returned.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function loadModule() {
  const source = await readFile(path.join(root, "modules", "novelneko-light", "index.js"), "utf8");
  const fetchv2 = async (url, headers = {}, method = "GET", body = null, options = {}) => {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: options.followRedirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      finalUrl: response.url,
      body: text,
      bodyDropped: false,
      text: async () => text,
    };
  };
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: "modules/novelneko-light/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

const module = await loadModule();
const home = await module.discoveryHome();
assert.ok(home.sections[0].items.length > 0, "light catalogue is empty");
const search = await module.searchResults("mushoku", 1);
assert.ok(search.items.length > 0, "no live light-novel search results");
const details = await module.extractDetails(search.items[0].id);
assert.ok(details.title, "details title is empty");
const resources = await module.extractResources(details.id);
assert.ok(resources.length > 0, "No open EPUB or PDF resource was returned");
for (const resource of resources) {
  assert.ok(["pdf", "epub"].includes(resource.format), `unexpected format ${resource.format}`);
  assert.match(resource.url, /^https:\/\/novelneko\.fr\/lightnovels\//);
}
console.log(JSON.stringify({
  source: "Novel Neko Light",
  title: details.title,
  catalogueItems: home.sections[0].items.length,
  searchItems: search.items.length,
  resources: resources.length,
  first: resources[0].url,
  last: resources[resources.length - 1].url,
}, null, 2));
