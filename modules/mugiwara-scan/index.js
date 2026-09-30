"use strict";

// Mugiwara No Scans (https://www.mugiwara-no-streaming.com) — French scan
// reader module. The site also streams anime video; video sections (episode
// pages, embeds, planning) are out of scope for this pageImages-type module,
// which covers the scans catalogue only. Observed data flow (fetchv2 only,
// no browser state):
// - catalogue: GET /sitemap.xml lists every /catalogue/<slug> title URL
//   (deeper episode/scan URLs are filtered out). Slugs are clean romanized
//   titles, so catalogue items carry a readable derived title and resolve
//   their exact title/cover lazily when details are opened.
// - search: accent-insensitive client-side filter over the sitemap slugs
//   (the site's own search box is a client component with no observed
//   endpoint; /api/catalogue-filters answers HTTP 500 without a browser
//   session, so it is not used).
// - details: GET /catalogue/<slug> (server-rendered: og:title, og:image,
//   og:description plus a flight-data anime object with slug, title,
//   synopsis, aliases, category/themes genres, the explicit adult flag and
//   options.SCANS_OPTIONS.IMAGE_URL). Titles flagged adult, or without scan
//   availability, are excluded with a clear message.
// - chapters: GET /api/taille-proxy?slug=<IMAGE_URL> answers the COMPLETE
//   chapter map {"<number>":<pages>,...} in one response (no pagination).
// - images: https://scans.mugiwara-no-streaming.com/<IMAGE_URL>/<chap>/<page>.jpg
//   (verified live: HTTP 200 image/jpeg), Referer set to the scans page.
(() => {
  const BASE_URL = "https://www.mugiwara-no-streaming.com";
  const SCANS_HOST = "scans.mugiwara-no-streaming.com";
  const STATIC_HOST = "static.mugiwara-no-streaming.com";
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_DESCRIPTION_CHARS = 1500;
  const PAGE_SIZE = 20;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  const JSON_HEADERS = {
    Accept: "application/json,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only. Mainstream labels ("Mature",
  // "Harem", "Ecchi", ...) never block a title on their own. Server-flagged
  // adult titles are rejected at details time; the module stays "suggestive".
  const UNSAFE_MARKERS = [
    "r 18",
    "x rated",
    "nsfw",
    "hentai",
    "porn",
    "pornographique",
    "smut",
    "explicit",
    "erotica",
    "erotique",
    "erotisme",
    "sexuel",
    "sexuelle",
    "sexual",
  ];
  const FEEDS = {
    catalogue: { id: "catalogue", title: "Catalogue" },
  };
  const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function permanent(message) {
    const error = new Error(message);
    error.mugiwaraPermanent = true;
    return error;
  }

  const NAMED_ENTITIES = {
    amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " ",
    rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
    hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
    eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â",
    ccedil: "ç", icirc: "î", ocirc: "ô", ucirc: "û", Eacute: "É",
  };

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name] || NAMED_ENTITIES[name.toLowerCase()] || match);
  }

  function cleanText(value) {
    if (typeof value !== "string") return "";
    return decodeEntities(value
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " "))
      .replace(/<[^>]+>/g, " ")
      .replace(/[\u00A0\s]+/g, " ")
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
    // Smallest observed allowlist: pages and the chapter API on www,
    // covers on static, page images on scans.
    const host = String(hostname || "").toLowerCase();
    return host === "www.mugiwara-no-streaming.com"
      || host === SCANS_HOST
      || host === STATIC_HOST;
  }

  function absoluteURL(value, base) {
    if (typeof value !== "string") return "";
    const input = decodeEntities(value).trim();
    if (!input || input.startsWith("#")) return "";
    try {
      const url = new URL(input, base || BASE_URL);
      if (url.protocol !== "https:" || !allowedHost(url.hostname)) return "";
      url.hash = "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function isReservedPlaceholderURL(value) {
    try {
      const url = new URL(String(value));
      return url.hostname === "invalid" || url.hostname.endsWith(".invalid");
    } catch (_) {
      return false;
    }
  }

  function isChallengePage(body) {
    return /(?:cf-chl-|cf-turnstile|challenge-platform|just a moment|attention required|access denied|verify you are human|checking your browser)/i
      .test(String(body || "").slice(0, 65536));
  }

  async function responseBody(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string") return body;
    }
    return typeof response.body === "string" ? response.body : "";
  }

  // NOTE: one fetchv2 call per URL, no retry fan-out: a failing chapter page
  // must surface as-is instead of multiplying requests.
  async function requestURL(url, headers, responseClass) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Mugiwara No Scans requires the fetchv2 bridge.");
    const requestURLValue = absoluteURL(url);
    if (!requestURLValue) throw permanent("Mugiwara No Scans request URL is not public or host-confined.");
    const response = await globalThis.fetchv2(
      requestURLValue,
      { ...headers },
      "GET",
      null,
      { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass },
    );
    if (!response) throw permanent("Mugiwara No Scans returned no response.");
    if (response.bodyDropped) throw permanent("Mugiwara No Scans response exceeded the module limit.");
    const status = Number(response.status) || 0;
    const finalURL = typeof response.finalUrl === "string" && response.finalUrl
      ? response.finalUrl
      : (typeof response.url === "string" ? response.url : "");
    if (finalURL && !isReservedPlaceholderURL(finalURL) && !absoluteURL(finalURL)) {
      throw permanent("Mugiwara No Scans redirected to a non-public or unapproved host.");
    }
    if (status && (status < 200 || status >= 300)) {
      throw permanent(`Mugiwara No Scans request failed with HTTP ${status}.`);
    }
    const body = await responseBody(response);
    if (!body) throw permanent("Mugiwara No Scans returned an empty response.");
    if (typeof body === "string" && isChallengePage(body)) {
      throw permanent("Mugiwara No Scans returned a browser challenge.");
    }
    return body;
  }

  async function requestJSON(url) {
    const body = await requestURL(url, JSON_HEADERS, "json");
    if (body && typeof body === "object") return body;
    try {
      return JSON.parse(String(body));
    } catch (_) {
      throw permanent("Mugiwara No Scans returned a malformed JSON response.");
    }
  }

  async function requestText(url, responseClass) {
    const body = await requestURL(url, DEFAULT_HEADERS, responseClass);
    if (typeof body !== "string" || !body) throw permanent("Mugiwara No Scans returned a malformed page.");
    return body;
  }

  function titleURL(slug) {
    return `${BASE_URL}/catalogue/${slug}`;
  }

  function scansURL(slug) {
    return `${titleURL(slug)}/scans/original`;
  }

  function chapterID(slug, number) {
    return `${scansURL(slug)}#chapitre-${number}`;
  }

  function humanizeSlug(slug) {
    return String(slug || "")
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  function parseTitleRef(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return null;
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) return null;
    if (url.hostname.toLowerCase() !== "www.mugiwara-no-streaming.com") return null;
    const match = url.pathname.match(/^\/catalogue\/([^/]+)\/?$/);
    if (!match) return null;
    const slug = match[1].toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return null;
    return { slug, href: titleURL(slug) };
  }

  function titleRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw permanent("Mugiwara No Scans identifier is invalid.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const ref = parseTitleRef(raw);
      if (!ref) throw permanent("Mugiwara No Scans identifier host or URL is not allowed.");
      return ref;
    }
    if (raw.includes("//")) throw permanent("Mugiwara No Scans identifier host or URL is not allowed.");
    const shaped = raw.startsWith("/") ? `${BASE_URL}${raw}` : `${BASE_URL}/catalogue/${raw.toLowerCase()}`;
    const ref = parseTitleRef(shaped);
    if (!ref) throw permanent("Mugiwara No Scans identifier is not a catalogue path.");
    return ref;
  }

  function safeCatalogueItem(slug) {
    if (!slug || !SLUG_PATTERN.test(String(slug).toLowerCase())) return null;
    const cleanSlug = String(slug).toLowerCase();
    const title = humanizeSlug(cleanSlug);
    if (!title || hasUnsafeMarker(title)) return null;
    // Sitemap entries carry no exact title/cover: the readable slug words
    // stand in until details resolve the exact display title and cover.
    const href = titleURL(cleanSlug);
    return {
      id: href,
      href,
      url: href,
      title,
      image: "",
      cover: "",
      coverUrl: "",
      poster: "",
      posterImage: "",
      language: "fr",
    };
  }

  function parseSitemapSlugs(xml) {
    // Catalogue titles only (/catalogue/<slug>): episode and scan subpages
    // are reader state, not catalogue items.
    const slugs = [];
    const seen = new Set();
    const pattern = /<loc>\s*https:\/\/www\.mugiwara-no-streaming\.com\/catalogue\/([a-z0-9\-]+)\s*<\/loc>/gi;
    let match;
    while ((match = pattern.exec(String(xml || ""))) !== null) {
      const slug = match[1].toLowerCase();
      if (!SLUG_PATTERN.test(slug) || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
    return slugs;
  }

  const sitemapCache = { slugs: null };

  async function loadCatalogueSlugs() {
    if (sitemapCache.slugs) return sitemapCache.slugs;
    const xml = await requestText(`${BASE_URL}/sitemap.xml`, "html");
    const slugs = parseSitemapSlugs(xml);
    if (slugs.length === 0) throw permanent("Mugiwara No Scans catalogue is empty.");
    sitemapCache.slugs = slugs;
    return slugs;
  }

  async function safeCatalogue() {
    try {
      return await loadCatalogueSlugs();
    } catch (_) {
      return [];
    }
  }

  function paginateSlugs(slugs, page) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const start = (requestedPage - 1) * PAGE_SIZE;
    const items = [];
    for (const slug of slugs.slice(start, start + PAGE_SIZE)) {
      const item = safeCatalogueItem(slug);
      if (item) items.push(item);
    }
    return { items, hasMore: start + PAGE_SIZE < slugs.length };
  }

  function resolveFeed(feedID) {
    const key = String(feedID || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FEEDS, key)) return FEEDS[key];
    if (key === "all" || key === "home" || key === "latest" || key === "popular") return FEEDS.catalogue;
    return FEEDS.catalogue;
  }

  async function discoveryHome() {
    const slugs = await safeCatalogue();
    if (slugs.length === 0) return { sections: [] };
    const first = paginateSlugs(slugs, 1);
    return { sections: [{ id: "catalogue", title: FEEDS.catalogue.title, items: first.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    resolveFeed(feedID);
    const slugs = await safeCatalogue();
    if (slugs.length === 0) return { items: [], hasMore: false };
    return paginateSlugs(slugs, page);
  }

  async function searchResults(query, page = 1) {
    const text = (typeof query === "object" && query !== null ? String(query.text || "") : String(query || "")).trim();
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!text) return { items: [], hasMore: false };
    const folded = fold(text);
    if (!folded || hasUnsafeMarker(text)) return { items: [], hasMore: false };
    try {
      const slugs = await loadCatalogueSlugs();
      const words = folded.split(" ").filter(Boolean);
      const matched = [];
      for (const slug of slugs) {
        const title = humanizeSlug(slug);
        const haystack = `${fold(title)} ${fold(slug)}`;
        if (!words.every((word) => haystack.includes(word))) continue;
        const item = safeCatalogueItem(slug);
        if (item) matched.push(item);
      }
      const start = (requestedPage - 1) * PAGE_SIZE;
      const items = matched.slice(start, start + PAGE_SIZE);
      return { items, hasMore: start + PAGE_SIZE < matched.length };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  function metaContent(html, attribute, name) {
    const tag = String(html || "").match(
      new RegExp(`<meta[^>]*${attribute}=["']${name}["'][^>]*>`, "i"),
    );
    if (!tag) return "";
    const content = tag[0].match(/content=(["'])((?:[^"'\\]|\\.)*)\1/i);
    return content ? decodeEntities(content[2]) : "";
  }

  function flightText(html) {
    // Flight payloads escape quotes as \" inside the HTML text: normalize
    // those so key matching stays readable. Remaining backslash escapes are
    // still honored by the escape-aware value patterns below.
    return String(html || "").replace(/\\"/g, '"');
  }

  function flightString(html, key) {
    // Flight payload: "key":"value" with possible \\ escapes inside.
    const pattern = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`);
    const match = flightText(html).match(pattern);
    if (!match) return "";
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch (_) {
      return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }

  function flightStringArray(html, key) {
    const pattern = new RegExp(`"${key}":\\[([^\\]]*)\\]`);
    const match = flightText(html).match(pattern);
    if (!match) return [];
    const output = [];
    const itemPattern = /"((?:[^"\\]|\\.)*)"/g;
    let item;
    while ((item = itemPattern.exec(match[1])) !== null) {
      try {
        const value = JSON.parse(`"${item[1]}"`);
        if (value && !output.includes(value)) output.push(value);
      } catch (_) {
        // Skip malformed entries instead of guessing.
      }
    }
    return output;
  }

  function flightFlag(html, key) {
    return new RegExp(`"${key}":true`).test(flightText(html));
  }

  function parseTitle(html) {
    const ogTitle = cleanText(metaContent(html, "property", "og:title"));
    if (ogTitle) return ogTitle;
    const text = String(html || "");
    const heading = text.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (heading) {
      const title = cleanText(heading[1]);
      if (title) return title;
    }
    return cleanText((text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "")
      .replace(/\s*[–—\-|｜]\s*Mugiwara-no Streaming.*$/i, "").trim();
  }

  // Cover candidates from one <img> tag, best source first: data-src >
  // data-lazy-src > data-cfsrc > srcset (first URL) > src. Placeholders
  // (data:, base64, svg, gifs, lazy stubs) never count as covers, and only
  // source-hosted files are returned. No CSS dimensions are forced: the raw
  // file URL passes through untouched so the app never crops or stretches.
  function pickImageURL(imageTag, pageURL) {
    if (!imageTag) return "";
    const candidates = [];
    for (const name of ["data-src", "data-lazy-src", "data-cfsrc"]) {
      const found = String(imageTag).match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, "i"));
      if (found) candidates.push(found[2]);
    }
    const srcset = String(imageTag).match(/\ssrcset=(["'])(.*?)\1/i);
    if (srcset) {
      const first = srcset[2].split(",")[0].trim().split(/\s+/)[0];
      if (first) candidates.push(first);
    }
    const src = String(imageTag).match(/\ssrc=(["'])(.*?)\1/i);
    if (src) candidates.push(src[2]);
    for (const candidate of candidates) {
      if (!candidate || /^\s*data:/i.test(candidate)) continue;
      if (/base64|placeholder|\.gif(\?|#|$)/i.test(candidate)) continue;
      if (/\.svg(\?|#|$)/i.test(candidate) && !/\/covers\/|\/Animes\//i.test(candidate)) continue;
      const absolute = absoluteURL(candidate, pageURL);
      if (absolute) return absolute;
    }
    return "";
  }

  function parseCover(html, pageURL) {
    const fromMeta = absoluteURL(metaContent(html, "property", "og:image"), pageURL);
    if (fromMeta) return fromMeta;
    const text = String(html || "");
    const images = [...text.matchAll(/<img\b[^>]*>/gi)];
    for (const imageTag of images) {
      const candidate = pickImageURL(imageTag[0], pageURL);
      if (candidate) return candidate;
    }
    return "";
  }

  function parseDescription(html) {
    const flight = cleanText(flightString(html, "synopsis"));
    if (flight.replace(/\s/g, "").length >= 24) {
      return flight.length > MAX_DESCRIPTION_CHARS
        ? `${flight.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`
        : flight;
    }
    const fallback = cleanText(metaContent(html, "property", "og:description"));
    if (fallback.length > MAX_DESCRIPTION_CHARS) return `${fallback.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`;
    return fallback;
  }

  const seriesCache = new Map();

  async function loadSeries(ref) {
    const cacheKey = ref.slug;
    if (seriesCache.has(cacheKey)) return seriesCache.get(cacheKey);
    const html = await requestText(ref.href, "html");
    const title = parseTitle(html);
    if (!title) throw permanent("Mugiwara No Scans title is empty after cleaning.");
    if (hasUnsafeMarker(title)) throw permanent("Mugiwara No Scans title failed the safety filter.");
    // The server flags explicit works itself: never list or open them.
    if (flightFlag(html, "adult")) throw permanent("Mugiwara No Scans flags this title as adult-only.");
    const imageURL = flightString(html, "IMAGE_URL");
    const disponibles = flightStringArray(html, "disponibles").map((value) => value.toLowerCase());
    const hasScans = disponibles.includes("scans") || disponibles.includes("scan");
    if (!imageURL || !hasScans) {
      throw permanent(`Mugiwara No Scans "${title}" has no scan version.`);
    }
    const entry = { html, title, imageURL };
    seriesCache.set(cacheKey, entry);
    return entry;
  }

  async function extractDetails(id) {
    const ref = titleRefFromID(id);
    const { html, title } = await loadSeries(ref);
    const categories = flightStringArray(html, "category");
    const themes = flightStringArray(html, "themes");
    // NOTE: the "type" field is deliberately excluded: flight payloads reuse
    // it for font preloads ("font/woff2"), which is not a genre.
    const genres = [];
    for (const name of [...categories, ...themes]) {
      const label = cleanText(name);
      if (label && label.length <= 40 && !genres.includes(label)) genres.push(label);
    }
    if ([title, ...genres].some(hasUnsafeMarker)) {
      throw permanent("Mugiwara No Scans details failed the safety filter.");
    }
    const image = parseCover(html, ref.href);
    return {
      id: ref.href,
      href: ref.href,
      url: ref.href,
      title,
      description: parseDescription(html),
      image,
      cover: image,
      coverUrl: image,
      poster: image,
      posterImage: image,
      author: "",
      authors: [],
      genres,
      status: "",
      language: "fr",
    };
  }

  function tailleURL(imageURL) {
    return `${BASE_URL}/api/taille-proxy?slug=${encodeURIComponent(imageURL)}`;
  }

  function chapterNumberValue(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= 100000 ? number : null;
  }

  const chaptersCache = new Map();

  async function extractChapters(id) {
    const ref = titleRefFromID(id);
    const cacheKey = ref.slug;
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    const { html, title, imageURL } = await loadSeries(ref);
    const cover = parseCover(html, ref.href);
    // The taille-proxy answers the complete {chapter: pages} map at once.
    const payload = await requestJSON(tailleURL(imageURL));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw permanent("Mugiwara No Scans returned no chapter list.");
    }
    const numbers = Object.keys(payload)
      .map((key) => chapterNumberValue(key))
      .filter((number) => number !== null)
      .sort((a, b) => a - b);
    if (numbers.length === 0) throw permanent("Mugiwara No Scans returned no chapter list.");
    const manga = { id: ref.href, href: ref.href, url: ref.href, title, cover };
    const seen = new Set();
    const chapters = [];
    for (const number of numbers) {
      const href = chapterID(ref.slug, number);
      if (seen.has(href)) continue;
      seen.add(href);
      chapters.push({
        id: href,
        href,
        url: href,
        title: `Chapitre ${number}`,
        number,
        image: cover,
        cover,
        coverUrl: cover,
        poster: cover,
        posterImage: cover,
        manga,
        language: "fr",
      });
    }
    chaptersCache.set(cacheKey, chapters);
    return chapters;
  }

  function chapterRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw permanent("Mugiwara No Scans chapter identifier is invalid.");
    const hashIndex = raw.indexOf("#chapitre-");
    if (hashIndex < 0) throw permanent("Mugiwara No Scans identifier is not a chapter URL.");
    const page = raw.slice(0, hashIndex);
    const number = Number(raw.slice(hashIndex + "#chapitre-".length));
    if (!Number.isInteger(number) || number < 1 || number > 100000) {
      throw permanent("Mugiwara No Scans chapter number is invalid.");
    }
    let ref;
    if (/^[a-z][a-z0-9+.-]*:/i.test(page)) {
      try {
        const url = new URL(page);
        if (url.protocol !== "https:" || !allowedHost(url.hostname)) {
          throw permanent("Mugiwara No Scans chapter identifier host or URL is not allowed.");
        }
        const match = url.pathname.match(/^\/catalogue\/([a-z0-9\-]+)\/scans\/[^/]+\/?$/i);
        if (!match || !SLUG_PATTERN.test(match[1].toLowerCase())) {
          throw permanent("Mugiwara No Scans identifier is not a chapter path.");
        }
        ref = { slug: match[1].toLowerCase() };
      } catch (error) {
        if (error && error.mugiwaraPermanent) throw error;
        throw permanent("Mugiwara No Scans chapter identifier is invalid.");
      }
    } else {
      if (page.includes("//")) throw permanent("Mugiwara No Scans chapter identifier host or URL is not allowed.");
      const shaped = page.startsWith("/") ? page : `/${page}`;
      const match = shaped.match(/^\/catalogue\/([a-z0-9\-]+)\/scans\/[^/]+\/?$/i);
      if (!match || !SLUG_PATTERN.test(match[1].toLowerCase())) {
        throw permanent("Mugiwara No Scans identifier is not a chapter path.");
      }
      ref = { slug: match[1].toLowerCase() };
    }
    return { slug: ref.slug, number, href: chapterID(ref.slug, number) };
  }

  async function extractImages(id) {
    const ref = chapterRefFromID(id);
    // The reader needs the scans IMAGE_URL token plus the page count from
    // the taille map; the title page is shared through the series cache.
    const seriesRef = { slug: ref.slug, href: titleURL(ref.slug) };
    const { imageURL } = await loadSeries(seriesRef);
    const payload = await requestJSON(tailleURL(imageURL));
    const pageCount = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Number(payload[String(ref.number)])
      : NaN;
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 500) {
      throw permanent("Mugiwara No Scans chapter has no page data.");
    }
    // IMAGE_URL tokens may contain spaces ("Blue Lock Spin-off Nagi"):
    // encode the segment so chapter and image URLs stay valid.
    const referer = scansURL(ref.slug);
    const token = encodeURIComponent(imageURL);
    const output = [];
    for (let page = 1; page <= pageCount; page += 1) {
      output.push({
        url: `https://${SCANS_HOST}/${token}/${ref.number}/${page}.jpg`,
        headers: { Referer: referer },
      });
    }
    return output;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
