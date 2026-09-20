"use strict";

// NovelNeko (https://novelneko.fr) — French fan-translation reader module.
//
// Scope: the Web-Novels catalogue only. Catalogue entries live in the static
// JSON index /webnovels/webnovel.json, each novel page
// (/webnovels/<slug>/) carries its metadata plus a chapter count
// ("const maxChapitres = N"), chapters are served as plain-text files
// (/webnovels/<slug>/chapters/chapitre_NNN.txt) rendered by lecture.html.
// Light-Novels are PDF-only downloads and Mangas are image galleries, so
// neither fits a text-type module and both are intentionally out of scope.
(() => {
  const BASE_URL = "https://novelneko.fr";
  const CATALOG_URL = `${BASE_URL}/webnovels/webnovel.json`;
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_TEXT_BYTES = 1024 * 1024;
  const MIN_TEXT_CHARS = 100;
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
  const TEXT_HEADERS = {
    Accept: "text/plain,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only (same doctrine as the NovelFrance
  // and NovelDeLAube modules): broad maturity/romance-subgenre tags are not
  // blocked, the module stays rated "suggestive", never "safe".
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
  const FEEDS = { webnovels: "Web-Novels" };

  function resolveFeed(feedID) {
    // The web-novel catalogue is the default feed: whatever feed name a
    // client asks for, it receives the novel list instead of an empty
    // screen. Feed names are routing hints, and a wrong hint must never
    // cost the user their library.
    const feed = String(feedID || "").trim().toLowerCase();
    if (feed === "web-novels" || feed === "web novels" || feed === "catalogue" || feed === "all") return "webnovels";
    if (Object.prototype.hasOwnProperty.call(FEEDS, feed)) return feed;
    return "webnovels";
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

  function novelPageURL(value) {
    const slug = normalizeNovelSlug(value);
    return `${BASE_URL}/webnovels/${slug}/`;
  }

  function normalizeNovelSlug(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("NovelNeko identifier is invalid.");
    const input = value.trim();
    if (SLUG_PATTERN.test(input)) return input;
    let url;
    try {
      url = new URL(input, BASE_URL);
    } catch (_) {
      throw new Error("NovelNeko identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.hash) {
      throw new Error("NovelNeko identifier host or URL is not allowed.");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    // Novel pages live at /webnovels/<slug>/ ; chapter URLs carry the slug
    // one level up from lecture.html.
    if (segments.length === 0) throw new Error("NovelNeko identifier is not a novel URL.");
    const file = segments[segments.length - 1];
    if (/^lecture\.html$/i.test(file)) {
      if (segments.length < 2 || segments[segments.length - 2].toLowerCase() !== "webnovels") {
        throw new Error("NovelNeko identifier is not a novel URL.");
      }
      // /webnovels/<slug>/lecture.html -> slug is two levels up.
      if (segments.length < 3 || !SLUG_PATTERN.test(segments[segments.length - 2])) {
        throw new Error("NovelNeko identifier is not a novel URL.");
      }
      return segments[segments.length - 2];
    }
    if (segments[0].toLowerCase() !== "webnovels" || segments.length < 2) {
      throw new Error("NovelNeko identifier is not a novel URL.");
    }
    if (!SLUG_PATTERN.test(segments[1])) throw new Error("NovelNeko identifier is invalid.");
    return segments[1];
  }

  function chapterFileName(number) {
    return `chapitre_${String(number).padStart(3, "0")}.txt`;
  }

  function chapterURL(slug, number) {
    return `${BASE_URL}/webnovels/${slug}/lecture.html?chapitre=${number}`;
  }

  function chapterTextURL(slug, number) {
    return `${BASE_URL}/webnovels/${slug}/chapters/${chapterFileName(number)}`;
  }

  function normalizeChapterReference(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("NovelNeko chapter identifier is invalid.");
    let url;
    try {
      url = new URL(value.trim(), BASE_URL);
    } catch (_) {
      throw new Error("NovelNeko chapter identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.hash) {
      throw new Error("NovelNeko chapter host or URL is not allowed.");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 3
      || segments[0].toLowerCase() !== "webnovels"
      || !SLUG_PATTERN.test(segments[1])
      || !/^lecture\.html$/i.test(segments[2])) {
      throw new Error("NovelNeko identifier is not a chapter URL.");
    }
    const number = Number(url.searchParams.get("chapitre"));
    if (!Number.isInteger(number) || number < 1 || number > 100000) {
      throw new Error("NovelNeko chapter number is invalid.");
    }
    const slug = segments[1];
    return { slug, number, href: chapterURL(slug, number) };
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
    if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelNeko requires the fetchv2 bridge.");
    const requestURLValue = absoluteURL(url);
    if (!requestURLValue) throw new Error("NovelNeko request URL is not public or host-confined.");
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
        if (!response || response.bodyDropped) throw new Error("NovelNeko response exceeded the module limit.");
        const finalURL = response.finalUrl || response.url;
        if (finalURL && !absoluteURL(finalURL)) {
          throw new Error("NovelNeko redirected to a non-public or unapproved host.");
        }
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`NovelNeko request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        const body = await responseBody(response);
        if (!body) throw new Error("NovelNeko returned an empty response.");
        if (isChallengePage(body)) throw new Error("NovelNeko returned a browser challenge.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|exceeded the module limit/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("NovelNeko request failed.");
  }

  async function requestHTML(url) {
    const body = await requestURL(url, DEFAULT_HEADERS, "html");
    if (typeof body !== "string" || !body) throw new Error("NovelNeko returned a malformed page.");
    return body;
  }

  async function requestCatalogueJSON() {
    const body = await requestURL(CATALOG_URL, JSON_HEADERS, "json");
    if (typeof body === "object" && body !== null) return body;
    if (typeof body !== "string" || !body) throw new Error("NovelNeko returned a malformed catalogue.");
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error("NovelNeko returned malformed JSON.");
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
    let slug = "";
    try {
      const href = absoluteURL(rawLink, `${BASE_URL}/webnovels/`);
      if (!href) return null;
      slug = normalizeNovelSlug(href);
    } catch (_) {
      return null;
    }
    const href = `${BASE_URL}/webnovels/${slug}/`;
    const image = absoluteURL(String(entry.image || "").trim(), `${BASE_URL}/webnovels/`) || "";
    return {
      id: slug,
      href,
      url: href,
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
    if (!Array.isArray(parsed)) throw new Error("NovelNeko catalogue is malformed.");
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
      throw new Error("NovelNeko discovery feed is unknown.");
    }
    // The catalogue lives in a single JSON index; only page 1 carries items.
    if (requestedPage !== 1) return { items: [], hasMore: false };
    // Browsing must never crash the source screen: any fetch or parse
    // failure degrades to an empty list. Challenge, login and malformed
    // content on detail/chapter paths still fail closed elsewhere.
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
      const catalogue = await safeFeed("webnovels", 1);
      return {
        sections: [
          { id: "webnovels", title: FEEDS.webnovels, items: catalogue.items },
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

  function sideInfo(html, label) {
    // Side panel rows render as "<div><strong>Label :</strong> value</div>".
    const pattern = new RegExp(
      `<div>\\s*<strong>\\s*${label}\\s*:?\\s*<\\/strong>\\s*([^<]*)<\\/div>`,
      "i",
    );
    const match = String(html || "").match(pattern);
    return match ? cleanText(match[1]) : "";
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

  function parseChapterCount(html) {
    // Primary: the reader script embeds the exact chapter count...
    const embedded = String(html || "").match(/const\s+maxChapitres\s*=\s*(\d+)\s*;/i);
    if (embedded) {
      const count = Number(embedded[1]);
      if (Number.isInteger(count) && count >= 1 && count <= 100000) return count;
    }
    // Fallback 1: the "285 chapitres" badge next to the title...
    const badge = String(html || "").match(/<div class="chapter-count">\s*(\d+)\s+chapitres?\s*<\/div>/i);
    if (badge) {
      const count = Number(badge[1]);
      if (Number.isInteger(count) && count >= 1 && count <= 100000) return count;
    }
    // Fallback 2: the "Dernier chapitre" button (?chapitre=N).
    const last = String(html || "").match(/lecture\.html\?chapitre=(\d+)/gi);
    if (last && last.length > 0) {
      let best = 0;
      for (const link of last) {
        const count = Number(link.match(/(\d+)$/)[1]);
        if (Number.isInteger(count) && count > best && count <= 100000) best = count;
      }
      if (best >= 1) return best;
    }
    return 0;
  }

  async function extractDetails(id) {
    const slug = normalizeNovelSlug(id);
    const cacheKey = slug.toLowerCase();
    if (detailsCache.has(cacheKey)) return detailsCache.get(cacheKey);
    const pageURL = novelPageURL(id);
    const html = await requestHTML(pageURL);
    const rawTitle = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
    if (!rawTitle) throw new Error("NovelNeko title is empty after cleaning.");
    const genres = parseGenres(html);
    if ([rawTitle, ...genres].some(hasUnsafeMarker)) {
      throw new Error("NovelNeko title failed the safety filter.");
    }
    const rawStatus = sideInfo(html, "Statut");
    const status = STATUS_MAP[rawStatus.toLowerCase()] || rawStatus;
    const author = sideInfo(html, "Auteur");
    const translator = sideInfo(html, "Traducteur");
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

  async function extractChapters(id) {
    const slug = normalizeNovelSlug(id);
    const cacheKey = slug.toLowerCase();
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    await extractDetails(id);
    const html = await requestHTML(novelPageURL(id));
    const count = parseChapterCount(html);
    if (!count) throw new Error("NovelNeko returned no chapter list.");
    // Chapters are numbered 1..N and rendered oldest-first in reading
    // order; the detail page lists them newest-first for display only.
    const output = [];
    for (let number = 1; number <= count; number += 1) {
      const href = chapterURL(slug, number);
      output.push({
        id: href,
        href,
        url: href,
        number,
        title: `Chapitre ${number}`,
        language: "fr",
      });
    }
    chaptersCache.set(cacheKey, output);
    return output;
  }

  async function extractText(reference) {
    const ref = normalizeChapterReference(reference);
    await extractDetails(ref.slug);
    const raw = await requestURL(chapterTextURL(ref.slug, ref.number), TEXT_HEADERS, "html");
    if (typeof raw !== "string" || !raw) throw new Error("NovelNeko chapter text is unavailable.");
    const body = raw;
    if (/<\s*html[\s>]/i.test(body.slice(0, 4096))) {
      throw new Error("NovelNeko chapter text is unavailable.");
    }
    const content = String(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!content || content.length < MIN_TEXT_CHARS) {
      throw new Error("NovelNeko chapter text is unavailable.");
    }
    if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) {
      throw new Error("NovelNeko chapter text exceeds the app size limit.");
    }
    return content;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractText, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
