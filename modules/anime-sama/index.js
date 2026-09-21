"use strict";

// Anime Sama Manga (https://anime-sama.to) — French scan reader module.
//
// Scope: the Scans catalogue only (VF scan works). The anime streaming
// section (video embeds) and non-French scan editions (VA, special editions)
// are out of scope for this pageImages-type module.
// Observed data flow:
// - discovery unions three bounded pages: the sitemap (every standard
//   /catalogue/<slug>/scan/vf/ URL), the homepage scan cards and the
//   /catalogue/ page cards (real titles); scan availability for entries
//   without a proven scan link is confirmed lazily when opened;
// - covers always use the full vertical poster (contenu/<slug>.jpg, the same
//   file the series pages use) instead of the 16:9 banner thumbnails;
// - series scan page: #titreOeuvre (display title), #imgOeuvre (cover),
//   #avOeuvre (status line);
// - chapters: /s2/scans/get_nb_chap_et_img.php?oeuvre=<DisplayTitle> returns
//   {"1":<pages>,"2":<pages>,...};
// - pages: /s2/scans/<DisplayTitle>/<chap>/<i>.jpg ("<Title> pp" variant is
//   retried once when the primary title is reported missing, mirroring the
//   site's own reader logic).
(() => {
  const BASE_URL = "https://anime-sama.to";
  const CHAPTER_API = `${BASE_URL}/s2/scans/get_nb_chap_et_img.php?oeuvre=`;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
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
  // Explicit sexual-content markers only: mainstream genre labels never
  // block a title on their own. The module stays rated "suggestive".
  const UNSAFE_MARKERS = [
    "r 18", "x rated", "nsfw", "hentai", "porn", "pornographique", "smut",
    "explicit", "erotic", "erotique", "erotisme", "sexuel", "sexuelle",
    "sexual", "lemon", "lime",
  ];
  const STATUS_MAP = { "en cours": "Ongoing", "terminé": "Completed", "termine": "Completed", "en pause": "On hold" };
  const FEEDS = { scans: "Scans" };

  function resolveFeed(feedID) {
    const feed = String(feedID || "").trim().toLowerCase();
    if (feed === "catalogue" || feed === "all" || feed === "latest" || feed === "scans vf") return "scans";
    if (Object.prototype.hasOwnProperty.call(FEEDS, feed)) return feed;
    return "scans";
  }

  const catalogueCache = { data: null };
  const detailsCache = new Map();
  const chaptersCache = new Map();

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
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
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
    const host = String(hostname || "").toLowerCase();
    // Observed content hosts only: pages/API on anime-sama.to, covers on
    // jsDelivr and raw.githubusercontent (og:image).
    return host === "anime-sama.to"
      || host === "cdn.jsdelivr.net"
      || host === "raw.githubusercontent.com";
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

  function scanPageURL(slug) {
    return `${BASE_URL}/catalogue/${slug}/scan/vf/`;
  }

  function posterURL(slug) {
    // Full vertical poster: the same file the series pages use (#imgOeuvre).
    // Homepage thumbnails are 16:9 banner crops and are never used.
    return `https://cdn.jsdelivr.net/gh/Anime-Sama/IMG@img/contenu/${slug}.jpg`;
  }

  function titleWords(slug) {
    // Fallback title for sitemap-only entries (no card observed): readable
    // slug words. The exact display title resolves when details are opened.
    return String(slug || "")
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  function chapterID(slug, number) {
    return `${scanPageURL(slug)}#chapitre-${number}`;
  }

  function normalizeSlug(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Anime Sama identifier is invalid.");
    const input = value.trim();
    if (SLUG_PATTERN.test(input)) return input;
    let url;
    try {
      url = new URL(input, BASE_URL);
    } catch (_) {
      throw new Error("Anime Sama identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) {
      throw new Error("Anime Sama identifier host or URL is not allowed.");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    // /catalogue/<slug>/scan/<vf|va>/ (chapter fragments allowed).
    if (segments.length < 2 || segments[0].toLowerCase() !== "catalogue") {
      throw new Error("Anime Sama identifier is not a series URL.");
    }
    if (!SLUG_PATTERN.test(segments[1])) throw new Error("Anime Sama identifier is invalid.");
    return segments[1];
  }

  function normalizeChapterReference(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Anime Sama chapter identifier is invalid.");
    const input = value.trim();
    const hashIndex = input.indexOf("#chapitre-");
    if (hashIndex < 0) throw new Error("Anime Sama identifier is not a chapter URL.");
    const slug = normalizeSlug(input.slice(0, hashIndex));
    const number = Number(input.slice(hashIndex + "#chapitre-".length));
    if (!Number.isInteger(number) || number < 1 || number > 100000) {
      throw new Error("Anime Sama chapter number is invalid.");
    }
    return { slug, number, href: chapterID(slug, number) };
  }

  function isChallengePage(body) {
    // NOTE: the Cloudflare precursor script tag (challenge-platform) is
    // embedded in every readable page and must NOT count as a block.
    return /(?:cf-chl-|cf-turnstile|just a moment|access denied|verify you are human)/i
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
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Anime Sama requires the fetchv2 bridge.");
    const requestURLValue = absoluteURL(url);
    if (!requestURLValue) throw new Error("Anime Sama request URL is not public or host-confined.");
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
        if (!response || response.bodyDropped) throw new Error("Anime Sama response exceeded the module limit.");
        const finalURL = response.finalUrl || response.url;
        if (finalURL && !absoluteURL(finalURL)) {
          throw new Error("Anime Sama redirected to a non-public or unapproved host.");
        }
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`Anime Sama request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        const body = await responseBody(response);
        if (!body) throw new Error("Anime Sama returned an empty response.");
        if (typeof body === "string" && isChallengePage(body)) {
          throw new Error("Anime Sama returned a browser challenge.");
        }
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|exceeded the module limit/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("Anime Sama request failed.");
  }

  async function requestHTML(url) {
    const body = await requestURL(url, DEFAULT_HEADERS, "html");
    if (typeof body !== "string" || !body) throw new Error("Anime Sama returned a malformed page.");
    return body;
  }

  async function requestChapterMap(displayTitle, pageURL) {
    // The reader API answers {"<chap>":<pages>,...} or {"error":...}.
    // The "<Title> pp" variant is retried once, mirroring site logic.
    const candidates = [displayTitle, `${displayTitle} pp`];
    let lastError = null;
    for (const candidate of candidates) {
      const url = `${CHAPTER_API}${encodeURIComponent(candidate)}`;
      const headers = { ...JSON_HEADERS, Referer: pageURL };
      const body = await requestURL(url, headers, "json");
      const parsed = typeof body === "object" && body !== null ? body : JSON.parse(String(body));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !parsed.error) {
        return { map: parsed, provenTitle: candidate };
      }
      lastError = new Error(`Anime Sama has no chapter data for "${displayTitle}".`);
    }
    throw lastError || new Error("Anime Sama chapter data is unavailable.");
  }

  function chapterNumbers(map) {
    return Object.keys(map || {})
      .map((key) => Number(key))
      .filter((number) => Number.isInteger(number) && number >= 1 && number <= 100000)
      .sort((a, b) => a - b);
  }

  function parseCatalogueCards(html) {
    // Homepage scan cards link /catalogue/<slug>/scan/vf/ and carry a
    // card-title plus a jsDelivr cover. Anime cards (saison/vostfr/...)
    // are excluded here; the /catalogue/ page covers every work below.
    const items = [];
    const seen = new Set();
    const pattern = /<a\b[^>]*href="(\/catalogue\/[A-Za-z0-9_.~-]+\/scan\/vf\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const item = cardItem(match[1], match[2], seen);
      if (item) items.push(item);
    }
    return items;
  }

  function parseCatalogRoots(html, seen) {
    // The /catalogue/ page lists every work with series-root links
    // (/catalogue/<slug>) plus title, cover and synopsis. Scan availability
    // is confirmed lazily at details time (see extractDetails).
    const items = [];
    const pattern = /<a\b[^>]*href="https?:\/\/anime-sama\.to\/catalogue\/([A-Za-z0-9_.~-]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const item = cardItem(`/catalogue/${match[1]}/`, match[2], seen);
      if (item) items.push(item);
    }
    return items;
  }

  function cardItem(path, block, seen) {
    const href = absoluteURL(path);
    if (!href) return null;
    let slug = "";
    try {
      const segments = new URL(href).pathname.split("/").filter(Boolean);
      if (segments.length < 2 || segments[0].toLowerCase() !== "catalogue") return null;
      slug = segments[1];
    } catch (_) {
      return null;
    }
    if (!slug || !SLUG_PATTERN.test(slug) || seen.has(slug)) return null;
    const titleMatch = block.match(/card-title[^>]*>([^<]+)</i);
    if (!titleMatch) return null;
    const rawTitle = cleanText(titleMatch[1]);
    if (!rawTitle || hasUnsafeMarker(rawTitle)) return null;
    const image = posterURL(slug);
    seen.add(slug);
    const page = scanPageURL(slug);
    return {
      id: slug, href: page, url: page, title: rawTitle,
      image, cover: image, author: "", authors: [],
      genres: [], status: "", language: "fr",
    };
  }

  function parseSitemapSlugs(xml) {
    // Standard VF scan URLs only (/catalogue/<slug>/scan/vf/): VA and
    // special-edition variants (scan_noir-et-blanc, scan-vigilantes, ...)
    // need per-edition title mapping that has not been observed.
    const slugs = [];
    const seen = new Set();
    const pattern = /<loc>https:\/\/anime-sama\.to\/catalogue\/([A-Za-z0-9_.~-]+)\/scan\/vf\/<\/loc>/gi;
    let match;
    while ((match = pattern.exec(String(xml || ""))) !== null) {
      const slug = match[1];
      if (!SLUG_PATTERN.test(slug) || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
    return slugs;
  }

  async function loadCatalogue() {
    if (catalogueCache.data) return catalogueCache.data;
    // Three bounded pages, fetched in parallel and merged by slug: homepage
    // scan cards and /catalogue/ cards first (real titles), then sitemap-only
    // slugs (derived titles) appended in sitemap order.
    const [home, catalogue, sitemap] = await Promise.all([
      requestHTML(BASE_URL).catch(() => ""),
      requestHTML(`${BASE_URL}/catalogue/`).catch(() => ""),
      requestURL(`${BASE_URL}/sitemap.xml`, DEFAULT_HEADERS, "html").catch(() => ""),
    ]);
    if (!home && !catalogue && !sitemap) throw new Error("Anime Sama catalogue is unavailable.");
    const seen = new Set();
    const items = [...parseCatalogueCards(home)];
    for (const item of items) seen.add(item.id);
    for (const item of parseCatalogRoots(catalogue, seen)) items.push(item);
    for (const slug of parseSitemapSlugs(sitemap)) {
      if (seen.has(slug)) continue;
      const rawTitle = titleWords(slug);
      if (!rawTitle || hasUnsafeMarker(rawTitle)) continue;
      seen.add(slug);
      const page = scanPageURL(slug);
      const image = posterURL(slug);
      items.push({
        id: slug, href: page, url: page, title: rawTitle,
        image, cover: image, author: "", authors: [],
        genres: [], status: "", language: "fr",
      });
    }
    catalogueCache.data = items;
    return items;
  }

  async function feedPage(feed, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!Object.prototype.hasOwnProperty.call(FEEDS, feed)) {
      throw new Error("Anime Sama discovery feed is unknown.");
    }
    if (requestedPage !== 1) return { items: [], hasMore: false };
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
      const catalogue = await safeFeed("scans", 1);
      return { sections: [{ id: "scans", title: FEEDS.scans, items: catalogue.items }] };
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
    // The site search is a client-side input with no observed endpoint:
    // filter the scan cards with an accent-insensitive match.
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

  function metaContent(html, property) {
    const match = String(html || "").match(
      new RegExp(`<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']+)["']`, "i"),
    ) || String(html || "").match(
      new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:${property}["']`, "i"),
    );
    return match ? decodeEntities(match[1]).trim() : "";
  }

  async function extractDetails(id) {
    const slug = normalizeSlug(id);
    if (detailsCache.has(slug)) return detailsCache.get(slug);
    const pageURL = scanPageURL(slug);
    let html;
    try {
      html = await requestHTML(pageURL);
    } catch (error) {
      // Catalogue works without a scan version surface here as a clear
      // exclusion instead of a generic fetch error.
      if (/HTTP 404/i.test(error instanceof Error ? error.message : String(error))) {
        throw new Error(`Anime Sama "${slug}" has no scan version.`);
      }
      throw error;
    }
    const titleMatch = html.match(/<h3[^>]*id=["']titreOeuvre["'][^>]*>([\s\S]*?)<\/h3>/i);
    const rawTitle = cleanText(titleMatch ? titleMatch[1] : "");
    if (!rawTitle) throw new Error("Anime Sama title is empty after cleaning.");
    if (hasUnsafeMarker(rawTitle)) throw new Error("Anime Sama title failed the safety filter.");
    const coverMatch = html.match(/<img[^>]*id=["']imgOeuvre["'][^>]*src=["']([^"']+)["']/i);
    let image = coverMatch ? absoluteURL(decodeEntities(coverMatch[1]).trim(), pageURL) : "";
    if (!image) image = absoluteURL(metaContent(html, "image"), pageURL);
    const statusMatch = html.match(/<h2[^>]*id=["']avOeuvre["'][^>]*>([\s\S]*?)<\/h2>/i);
    const rawStatus = cleanText(statusMatch ? statusMatch[1] : "");
    const status = STATUS_MAP[rawStatus.toLowerCase()] || rawStatus;
    const href = absoluteURL(pageURL);
    const details = {
      id: slug, href, url: href, title: rawTitle, description: "",
      image, cover: image, author: "", authors: [],
      genres: [], status, language: "fr",
    };
    detailsCache.set(slug, details);
    return details;
  }

  async function loadChapterMap(slug) {
    if (chaptersCache.has(slug)) return chaptersCache.get(slug);
    const details = await extractDetails(slug);
    const pageURL = scanPageURL(slug);
    const { map, provenTitle } = await requestChapterMap(details.title, pageURL);
    const numbers = chapterNumbers(map);
    if (!numbers.length) throw new Error("Anime Sama returned no chapter list.");
    const entry = { map, numbers, title: details.title, provenTitle };
    chaptersCache.set(slug, entry);
    return entry;
  }

  async function extractChapters(id) {
    const slug = normalizeSlug(id);
    const { numbers } = await loadChapterMap(slug);
    return numbers.map((number) => {
      const href = chapterID(slug, number);
      return { id: href, href, url: href, number, title: `Chapitre ${number}`, language: "fr" };
    });
  }

  async function extractImages(chapterIDValue) {
    const ref = normalizeChapterReference(chapterIDValue);
    const { map, provenTitle } = await loadChapterMap(ref.slug);
    const pageCount = Number(map[String(ref.number)]);
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 500) {
      throw new Error("Anime Sama chapter has no page data.");
    }
    // Image bodies are never fetched here: the app downloads them with the
    // series page as Referer (hotlink protection respected).
    const pageURL = scanPageURL(ref.slug);
    const output = [];
    for (let index = 1; index <= pageCount; index += 1) {
      output.push({
        url: `${BASE_URL}/s2/scans/${encodeURIComponent(provenTitle)}/${ref.number}/${index}.jpg`,
        headers: { Referer: pageURL },
      });
    }
    return output;
  }

  const handlers = {
    searchResults, extractDetails, extractChapters, extractImages,
    discoveryHome, discoveryFeed,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
