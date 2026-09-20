"use strict";

// Novel Neko Light Novel (https://novelneko.fr) — French fan-translation
// publication module for the Light-Novels catalogue: downloadable PDF/EPUB
// volumes linked as volumes/tomeN.pdf from each novel page. Catalogue entries
// live in the static JSON index /lightnovels/lightnovel.json. Web novels
// (online text chapters) are served by the sibling novelneko-wn text module:
// one module serves one terminal path, so both formats work instead of
// competing.
(() => {
  const BASE_URL = "https://novelneko.fr";
  const CATALOG_URL = `${BASE_URL}/lightnovels/lightnovel.json`;
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.~-]{0,120}$/;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  const JSON_HEADERS = {
    Accept: "application/json,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only (same doctrine as the NovelFrance,
  // NovelDeLAube and NovelNeko text modules): broad maturity/romance-subgenre
  // tags are not blocked, the module stays rated "suggestive", never "safe".
  const UNSAFE_MARKERS = [
    "r 18",
    "x rated",
    "nsfw",
    "hentai",
    "porn",
    "pornographique",
    "smut",
    "explicit",
    "erotic",
    "erotique",
    "erotisme",
    "sexuel",
    "sexuelle",
    "sexual",
    "lemon",
    "lime",
  ];
  const STATUS_MAP = { "terminé": "Completed", "en cours": "Ongoing", "en pause": "On hold" };
  const FEEDS = { lightnovels: "Light-Novels" };

  function resolveFeed(feedID) {
    // The light-novel catalogue is the default feed: whatever feed name a
    // client asks for, it receives the novel list instead of an empty
    // screen. Feed names are routing hints, and a wrong hint must never
    // cost the user their library.
    const feed = String(feedID || "").trim().toLowerCase();
    if (feed === "light-novels" || feed === "light novels" || feed === "lightnovel"
      || feed === "light" || feed === "catalogue" || feed === "all") return "lightnovels";
    if (Object.prototype.hasOwnProperty.call(FEEDS, feed)) return feed;
    return "lightnovels";
  }

  const catalogueCache = { data: null };
  const detailsCache = new Map();
  const resourcesCache = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else resolve();
    });
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function cleanText(value) {
    if (typeof value !== "string") return "";
    return decodeEntities(value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "))
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasUnsafeMarker(value) {
    const normalized = fold(value);
    return UNSAFE_MARKERS.some((marker) => (` ${normalized} `).includes(` ${marker} `));
  }

  function allowedHost(hostname) {
    return String(hostname || "").toLowerCase() === "novelneko.fr";
  }

  function absoluteURL(value, base) {
    if (typeof value !== "string") return "";
    const input = value.trim();
    if (!input) return "";
    try {
      const url = new URL(input, base || BASE_URL);
      if (url.protocol !== "https:" || !allowedHost(url.hostname)) return "";
      url.hash = "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function novelPageURL(slug) {
    return `${BASE_URL}/lightnovels/${slug}/`;
  }

  function normalizeNovelSlug(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Novel Neko Light identifier is invalid.");
    const input = value.trim();
    if (SLUG_PATTERN.test(input)) return input;
    let url;
    try {
      url = new URL(input, BASE_URL);
    } catch (_) {
      throw new Error("Novel Neko Light identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.hash) {
      throw new Error("Novel Neko Light identifier host or URL is not allowed.");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    // Light-novel pages live at /lightnovels/<slug>/ only.
    if (segments.length < 2 || segments[0].toLowerCase() !== "lightnovels") {
      throw new Error("Novel Neko Light identifier is not a novel URL.");
    }
    if (!SLUG_PATTERN.test(segments[1])) throw new Error("Novel Neko Light identifier is invalid.");
    return segments[1];
  }

  function isChallengePage(body) {
    return /(?:cf-chl-|cf-turnstile|challenge-platform|just a moment|access denied|verify you are human)/i
      .test(String(body || "").slice(0, 65536));
  }

  async function responseBody(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string" && body) return body;
    }
    if (typeof response.body === "string") return response.body;
    if (typeof response.body === "object" && response.body !== null) return response.body;
    return "";
  }

  async function requestURL(url, headers, responseClass) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Novel Neko Light requires the fetchv2 bridge.");
    const requestURLValue = absoluteURL(url);
    if (!requestURLValue) throw new Error("Novel Neko Light request URL is not public or host-confined.");
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURLValue,
          { ...headers },
          "GET",
          null,
          { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass },
        );
        const status = Number(response && response.status);
        if (!response || response.bodyDropped) throw new Error("Novel Neko Light response exceeded the module limit.");
        const finalURL = response.finalUrl || response.url;
        if (finalURL && !absoluteURL(finalURL)) {
          throw new Error("Novel Neko Light redirected to a non-public or unapproved host.");
        }
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`Novel Neko Light request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        const body = await responseBody(response);
        if (!body) throw new Error("Novel Neko Light returned an empty response.");
        if (isChallengePage(body)) throw new Error("Novel Neko Light returned a browser challenge.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|exceeded the module limit/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("Novel Neko Light request failed.");
  }

  async function requestHTML(url) {
    const body = await requestURL(url, DEFAULT_HEADERS, "html");
    if (typeof body !== "string" || !body) throw new Error("Novel Neko Light returned a malformed page.");
    return body;
  }

  async function requestCatalogueJSON() {
    const body = await requestURL(CATALOG_URL, JSON_HEADERS, "json");
    if (typeof body === "object" && body !== null) return body;
    if (typeof body !== "string" || !body) throw new Error("Novel Neko Light returned a malformed catalogue.");
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error("Novel Neko Light returned malformed JSON.");
    }
  }

  function safeCatalogueItem(entry) {
    if (!entry || typeof entry !== "object") return null;
    const rawTitle = cleanText(entry.title);
    if (!rawTitle) return null;
    // Explicit sexual markers are excluded everywhere; mainstream genre
    // labels (Ecchi, Harem, Mature...) never block a title on their own.
    if (hasUnsafeMarker(rawTitle)) return null;
    const rawLink = String(entry.link || "").trim();
    if (!rawLink) return null;
    const href = absoluteURL(rawLink, `${BASE_URL}/lightnovels/`);
    if (!href) return null;
    let slug = "";
    try {
      const url = new URL(href);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length < 2 || segments[0].toLowerCase() !== "lightnovels") return null;
      if (!SLUG_PATTERN.test(segments[1])) return null;
      slug = segments[1];
    } catch (_) {
      return null;
    }
    const page = `${BASE_URL}/lightnovels/${slug}/`;
    const image = absoluteURL(String(entry.image || "").trim(), `${BASE_URL}/lightnovels/`) || "";
    return {
      id: slug,
      href: page,
      url: page,
      title: rawTitle,
      image,
      cover: image,
      author: "",
      authors: [],
      genres: [],
      status: "",
      language: "fr",
    };
  }

  async function loadCatalogue() {
    if (catalogueCache.data) return catalogueCache.data;
    const parsed = await requestCatalogueJSON();
    if (!Array.isArray(parsed)) throw new Error("Novel Neko Light catalogue is malformed.");
    const seen = new Set();
    const items = [];
    for (const entry of parsed) {
      const item = safeCatalogueItem(entry);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    catalogueCache.data = items;
    return items;
  }

  async function feedPage(feed, page = 1) {
    // Page numbers are coerced, never rejected: some clients paginate from
    // zero and a crash here would take down the whole Discover screen.
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!Object.prototype.hasOwnProperty.call(FEEDS, feed)) {
      throw new Error("Novel Neko Light discovery feed is unknown.");
    }
    // The catalogue lives in a single JSON index; only page 1 carries items.
    if (requestedPage !== 1) return { items: [], hasMore: false };
    // Browsing must never crash the source screen: any fetch or parse
    // failure degrades to an empty list. Challenge, login and malformed
    // content on detail/resource paths still fail closed elsewhere.
    try {
      return { items: await loadCatalogue(), hasMore: false };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function safeFeed(feed, page) {
    try {
      return await feedPage(feed, page);
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function discoveryHome() {
    try {
      const catalogue = await safeFeed("lightnovels", 1);
      return {
        sections: [
          { id: "lightnovels", title: FEEDS.lightnovels, items: catalogue.items },
        ],
      };
    } catch (_) {
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedID, page = 1) {
    try {
      return await feedPage(resolveFeed(feedID), page);
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function searchResults(query, page = 1) {
    const text = typeof query === "object" && query !== null
      ? String(query.text || "")
      : String(query || "");
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!text.trim() || requestedPage !== 1) return { items: [], hasMore: false };
    // The site exposes no search endpoint: filter the JSON catalogue
    // client-side with an accent-insensitive substring match on the title
    // and the source slug.
    const folded = fold(text);
    if (!folded) return { items: [], hasMore: false };
    try {
      const catalogue = await loadCatalogue();
      const seen = new Set();
      const items = [];
      for (const item of catalogue) {
        if (seen.has(item.id)) continue;
        if (!fold(item.title).includes(folded) && !fold(item.id).includes(folded)) continue;
        seen.add(item.id);
        items.push(item);
      }
      return { items, hasMore: false };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  function sideInfo(html, labels) {
    // Side panel rows render as "<div><strong>Label :</strong> value</div>".
    // Light-novel pages use English labels ("Status :").
    const names = Array.isArray(labels) ? labels : [labels];
    for (const label of names) {
      const pattern = new RegExp(
        `<div>\\s*<strong>\\s*${label}\\s*:?\\s*<\\/strong>\\s*([^<]*)<\\/div>`,
        "i",
      );
      const match = String(html || "").match(pattern);
      if (match && cleanText(match[1])) return cleanText(match[1]);
    }
    return "";
  }

  function parseGenres(html) {
    const block = String(html || "").match(/<div class="genres">([\s\S]*?)<\/div>/i);
    if (!block) return [];
    const genres = [];
    const pattern = /<span[^>]*>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = pattern.exec(block[1])) !== null) {
      const genre = cleanText(match[1]);
      if (genre) genres.push(genre);
    }
    return [...new Set(genres)];
  }

  function parseVolumes(html, pageURL) {
    // Light-novel volumes are direct download links (volumes/tomeN.pdf,
    // volumes/tomeN.epub). Only links actually present in the page are
    // returned: formats are never guessed. "First/last" buttons duplicate the
    // "Tome N" rows, so links are deduplicated by URL, keeping "Tome N".
    const found = new Map();
    const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const href = absoluteURL(decodeEntities(match[1]).trim(), pageURL);
      if (!href) continue;
      let pathname = "";
      try {
        pathname = new URL(href).pathname;
      } catch (_) {
        continue;
      }
      if (!/\/volumes\//i.test(pathname)) continue;
      const file = pathname.split("/").filter(Boolean).pop() || "";
      const extension = file.match(/\.([A-Za-z0-9]+)$/);
      if (!extension) continue;
      const format = extension[1].toLowerCase();
      if (format !== "pdf" && format !== "epub") continue;
      const label = cleanText(match[2]);
      const existing = found.get(href);
      const isTomeLabel = (text) => /^tome\s+\d/i.test(String(text || ""));
      if (!existing) {
        found.set(href, { url: href, format, label });
      } else if (!isTomeLabel(existing.label) && isTomeLabel(label)) {
        found.set(href, { url: href, format, label });
      } else if (!existing.label && label) {
        found.set(href, { url: href, format, label });
      }
    }
    // Reading order is oldest-first. The page mixes "first/last" buttons
    // ahead of a newest-first list, so entries are sorted by volume number
    // (stable for several formats of the same tome) instead of reversing.
    const entries = [...found.values()].map((entry, order) => ({ ...entry, order }));
    entries.sort((a, b) => (volumeOrder(a) - volumeOrder(b)) || (a.order - b.order));
    return entries.map(({ url, format, label }) => ({ url, format, label }));
  }

  function volumeOrder(volume) {
    const source = `${volume.label} ${String(volume.url).split("/").filter(Boolean).pop() || ""}`;
    const parsed = source.match(/tome\s*(\d+(?:[.\-]\d+)?)/i);
    if (parsed) {
      const number = Number(parsed[1].replace("-", "."));
      if (Number.isFinite(number) && number >= 0 && number <= 100000) return number;
    }
    return Number.POSITIVE_INFINITY;
  }

  async function extractDetails(id) {
    const slug = normalizeNovelSlug(id);
    const cacheKey = slug.toLowerCase();
    if (detailsCache.has(cacheKey)) return detailsCache.get(cacheKey);
    const pageURL = novelPageURL(slug);
    const html = await requestHTML(pageURL);
    const rawTitle = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
    if (!rawTitle) throw new Error("Novel Neko Light title is empty after cleaning.");
    const genres = parseGenres(html);
    if ([rawTitle, ...genres].some(hasUnsafeMarker)) {
      throw new Error("Novel Neko Light title failed the safety filter.");
    }
    const rawStatus = sideInfo(html, ["Status", "Statut"]);
    const status = STATUS_MAP[rawStatus.toLowerCase()] || rawStatus;
    const author = sideInfo(html, ["Auteur", "Author"]);
    const translator = sideInfo(html, ["Traducteur", "Translator"]);
    let description = "";
    const synopsis = html.match(/<div class="synopsis-box">([\s\S]*?)<\/div>/i);
    if (synopsis) description = cleanText(synopsis[1]).replace(/^Synopsis\s*:?\s*/i, "");
    let image = "";
    const cover = html.match(/<img[^>]*class="cover"[^>]*src="([^"]+)"[^>]*>/i)
      || html.match(/<img[^>]*src="([^"]+)"[^>]*class="cover"[^>]*>/i);
    if (cover) image = absoluteURL(decodeEntities(cover[1]).trim(), pageURL);
    const href = absoluteURL(pageURL);
    const details = {
      id: slug,
      href,
      url: href,
      title: rawTitle,
      description,
      image,
      cover: image,
      author,
      authors: author ? [author] : [],
      translator,
      genres: [...new Set(genres)],
      status,
      language: "fr",
    };
    detailsCache.set(cacheKey, details);
    return details;
  }

  async function extractResources(id) {
    const slug = normalizeNovelSlug(id);
    const cacheKey = slug.toLowerCase();
    if (resourcesCache.has(cacheKey)) return resourcesCache.get(cacheKey);
    const details = await extractDetails(id);
    const pageURL = novelPageURL(slug);
    const html = await requestHTML(pageURL);
    // File bodies are never fetched here: the app downloads them. Only the
    // links observed on the novel page are returned, oldest volume first.
    const resources = parseVolumes(html, pageURL).map((volume) => {
      const label = volume.label || "Tome";
      return {
        format: volume.format,
        url: volume.url,
        fileName: `${details.title} - ${label}.${volume.format}`,
        headers: { Referer: pageURL },
      };
    });
    resourcesCache.set(cacheKey, resources);
    return resources;
  }

  const handlers = { searchResults, extractDetails, extractResources, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
