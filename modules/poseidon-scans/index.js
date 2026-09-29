"use strict";

// Poseidon Scans (https://poseidon-scans.net) — French scan catalogue and
// reader (manga / manhwa / manhua / webtoon in VF). The site is a Next.js App
// Router application exposing public JSON APIs alongside server-rendered
// HTML pages. Observed data flow (no browser state required, fetchv2 only):
// - discovery "latest": GET /api/manga/lastchapters ->
//   {success:true,data:[{id,title,slug,coverImage,chapters:[...]}]}.
// - discovery "popular": homepage "/" section "Populaire ..." ->
//   <a href="/serie/<slug>"> cards with /api/covers/ images and <h3> titles.
// - search: GET /api/search?q=<query>&page=<n> ->
//   {mangas:[{id,title,slug,coverImage,_count:{chapters}}],total,pages}.
//   (The site's own SearchAction declares /series?search=...; the JSON API
//   answers the same catalogue and is used here.)
// - details: GET /serie/<slug> (HTML: <h1> title, og:image cover, Statut /
//   Auteur / Type info rows, /series?tags= genre links, Synopsis paragraph,
//   plus a ComicSeries JSON-LD block used as fallback).
// - chapters: GET /api/manga/<slug>/1 ->
//   {success:true,data:{chapterList:[{id,number,title}],mangaData:{...}}}
//   carries the COMPLETE chapter list in one response (no pagination).
//   Premium-gated chapters are excluded: they are marked either by a
//   "Gratuit le <date>" badge on the /serie/<slug> chapter cards or by
//   isPremium flags in the /api/manga/lastchapters window. A gated chapter
//   page serves zero page images to anonymous readers, so listing it would
//   only produce a dead entry.
// - images: GET /serie/<slug>/chapter/<n> (HTML) embeds page images as
//   <img src="/api/chapters/<slug>/<chapterId>/<imageId>"> in reading order.
//   They are returned through the site's own bounded image route
//   /_next/image?url=<original>&w=1200&q=75 (same host, no extra allowlist).
(() => {
  const BASE_URL = "https://poseidon-scans.net";
  const HOST = "poseidon-scans.net";
  const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  const IMAGE_WIDTH = "1200";
  const IMAGE_QUALITY = "75";
  const MAX_DESCRIPTION_CHARS = 1500;
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
  // Explicit sexual-content markers only. Mainstream genre labels ("Mature",
  // "Harem", "Ecchi", ...) never block a title on their own. The module
  // stays rated "suggestive".
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
  const STATUS_RULES = [
    ["en cours", "Ongoing"],
    ["termin", "Completed"],
    ["complete", "Completed"],
    ["en pause", "Hiatus"],
    ["hiatus", "Hiatus"],
    ["abandonn", "Cancelled"],
    ["annul", "Cancelled"],
  ];
  // Discovery feeds. Unknown feed names fall back to the latest feed instead
  // of an empty Browse screen.
  const FEEDS = {
    popular: { id: "popular", title: "Populaire" },
    latest: { id: "latest", title: "Dernières sorties" },
  };
  const DEFAULT_FEED = "latest";
  const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function permanent(message) {
    const error = new Error(message);
    error.poseidonPermanent = true;
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
    // Smallest observed allowlist: pages, JSON APIs, covers, chapter images
    // and the bounded /_next/image route all live on the apex host.
    return String(hostname || "").toLowerCase() === HOST;
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

  function isLoginWall(body) {
    const head = String(body || "").slice(0, 65536);
    return /connectez-vous pour (commenter|lire)|vous devez (vous connecter|être connecté)/i.test(head)
      && !/<h1\b/i.test(head);
  }

  async function responseBody(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string") return body;
    }
    return typeof response.body === "string" ? response.body : "";
  }

  // NOTE: every handler performs exactly one fetchv2 call per URL (no retry
  // fan-out): a chapter timeout must surface as-is instead of multiplying
  // failing requests.
  async function requestURL(url, headers, responseClass) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Poseidon Scans requires the fetchv2 bridge.");
    const requestURLValue = absoluteURL(url);
    if (!requestURLValue) throw permanent("Poseidon Scans request URL is not public or host-confined.");
    const response = await globalThis.fetchv2(
      requestURLValue,
      { ...headers },
      "GET",
      null,
      { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass },
    );
    if (!response) throw permanent("Poseidon Scans returned no response.");
    if (response.bodyDropped) throw permanent("Poseidon Scans response exceeded the module limit.");
    const status = Number(response.status) || 0;
    const finalURL = typeof response.finalUrl === "string" && response.finalUrl
      ? response.finalUrl
      : (typeof response.url === "string" ? response.url : "");
    if (finalURL && !isReservedPlaceholderURL(finalURL) && !absoluteURL(finalURL)) {
      throw permanent("Poseidon Scans redirected to a non-public or unapproved host.");
    }
    if (status && (status < 200 || status >= 300)) {
      throw permanent(`Poseidon Scans request failed with HTTP ${status}.`);
    }
    const body = await responseBody(response);
    if (!body) throw permanent("Poseidon Scans returned an empty response.");
    if (typeof body === "string" && isChallengePage(body)) {
      throw permanent("Poseidon Scans returned a browser challenge.");
    }
    return body;
  }

  async function requestJSON(url) {
    const body = await requestURL(url, JSON_HEADERS, "json");
    if (body && typeof body === "object") return body;
    try {
      return JSON.parse(String(body));
    } catch (_) {
      throw permanent("Poseidon Scans returned a malformed JSON response.");
    }
  }

  async function requestHTML(url) {
    const body = await requestURL(url, DEFAULT_HEADERS, "html");
    if (typeof body !== "string" || !body) throw permanent("Poseidon Scans returned a malformed page.");
    return body;
  }

  function seriesURL(slug) {
    return `${BASE_URL}/serie/${slug}`;
  }

  function coverURL(slug, coverImage) {
    // API payloads carry storage paths ("storage/covers/<slug>.webp") that
    // map 1:1 onto the public cover route (/api/covers/<slug>.webp).
    const stored = String(coverImage || "").trim();
    if (stored) {
      const normalized = stored.replace(/\\/g, "/").replace(/^\.\//, "");
      if (/^storage\//i.test(normalized)) {
        const mapped = `${BASE_URL}/api/${normalized.slice("storage/".length)}`;
        if (absoluteURL(mapped)) return absoluteURL(mapped);
      }
      const direct = absoluteURL(normalized, BASE_URL);
      if (direct) return direct;
    }
    return `${BASE_URL}/api/covers/${slug}.webp`;
  }

  function humanizeSlug(slug) {
    return String(slug || "")
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  function parseSeriesRef(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return null;
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) return null;
    const match = url.pathname.match(/^\/serie\/([^/]+)\/?$/);
    if (!match) return null;
    const slug = match[1].toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return null;
    return { slug, href: seriesURL(slug) };
  }

  function seriesRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw permanent("Poseidon Scans identifier is invalid.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const ref = parseSeriesRef(raw);
      if (!ref) throw permanent("Poseidon Scans identifier host or URL is not allowed.");
      return ref;
    }
    if (raw.includes("//")) throw permanent("Poseidon Scans identifier host or URL is not allowed.");
    const shaped = raw.startsWith("/") ? `${BASE_URL}${raw}` : `${BASE_URL}/serie/${raw.toLowerCase()}`;
    const ref = parseSeriesRef(shaped);
    if (!ref) throw permanent("Poseidon Scans identifier is not a series path.");
    return ref;
  }

  function safeItem(slug, title, coverImage) {
    if (!slug || !SLUG_PATTERN.test(String(slug).toLowerCase())) return null;
    const cleanSlug = String(slug).toLowerCase();
    const cleanTitle = cleanText(title) || humanizeSlug(cleanSlug);
    if (!cleanTitle || hasUnsafeMarker(cleanTitle)) return null;
    const href = seriesURL(cleanSlug);
    const image = coverURL(cleanSlug, coverImage);
    return {
      id: href,
      href,
      url: href,
      title: cleanTitle,
      image,
      cover: image,
      coverUrl: image,
      poster: image,
      posterImage: image,
      language: "fr",
    };
  }

  function lastChaptersURL() {
    return `${BASE_URL}/api/manga/lastchapters`;
  }

  function searchURL(query, page) {
    const params = new URLSearchParams({ q: query });
    if (page > 1) params.set("page", String(page));
    return `${BASE_URL}/api/search?${params.toString()}`;
  }

  function chaptersURL(slug) {
    // Chapter 1 always exists for a listed series; its payload carries the
    // complete chapterList plus the mangaData identity block.
    return `${BASE_URL}/api/manga/${slug}/1`;
  }

  function chapterPageURL(slug, number) {
    return `${seriesURL(slug)}/chapter/${number}`;
  }

  function parseLastChapters(payload) {
    if (!payload || typeof payload !== "object") return [];
    // Live shape: {success:true,data:[{slug,title,coverImage,...}]}. The
    // search endpoint answers the same catalogue under {mangas:[...]} and is
    // accepted here so discovery degrades gracefully.
    const data = Array.isArray(payload.data)
      ? payload.data
      : (Array.isArray(payload.mangas) ? payload.mangas : []);
    const items = [];
    const seen = new Set();
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const item = safeItem(entry.slug, entry.title, entry.coverImage);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  // Premium chapter numbers for one series, read from the lastchapters
  // window ({success,data:[{slug,chapters:[{number,isPremium}]}]}). Any
  // unexpected shape degrades to "no flags" instead of failing chapters.
  function premiumFromLastChapters(payload, slug) {
    const flagged = new Set();
    try {
      const data = payload && typeof payload === "object" && Array.isArray(payload.data) ? payload.data : [];
      for (const entry of data) {
        if (!entry || typeof entry !== "object") continue;
        if (String(entry.slug || "").toLowerCase() !== slug) continue;
        for (const chapter of Array.isArray(entry.chapters) ? entry.chapters : []) {
          if (chapter && typeof chapter === "object" && chapter.isPremium === true) {
            const number = Number(chapter.number);
            if (Number.isFinite(number)) flagged.add(number);
          }
        }
      }
    } catch (_) {
      // Best-effort source: ignore malformed payloads.
    }
    return flagged;
  }

  // Premium chapter numbers read from the series HTML: gated cards carry a
  // "Gratuit le <date>" badge. The badge always renders after its card's
  // /chapter/<N> link, so the nearest preceding chapter link owns it.
  function premiumFromSeriesHTML(html) {
    const flagged = new Set();
    const text = String(html || "");
    const marker = /gratuit\s+le/gi;
    let match;
    while ((match = marker.exec(text)) !== null) {
      const behind = text.slice(Math.max(0, match.index - 4000), match.index);
      const links = [...behind.matchAll(/\/chapter\/(\d+)/gi)];
      if (links.length > 0) {
        const number = Number(links[links.length - 1][1]);
        if (Number.isFinite(number)) flagged.add(number);
      }
      if (flagged.size > 5000) break;
    }
    return flagged;
  }

  function sectionSlice(html, headingPattern) {
    const text = String(html || "");
    const heading = text.match(headingPattern);
    if (!heading || heading.index == null) return "";
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const next = rest.search(/<h[12]\b/i);
    return next < 0 ? rest : rest.slice(0, next);
  }

  function parseHomeSection(html, headingPattern) {
    // Popular cards: <a href="/serie/<slug>"><img src="...covers..."><h3>Title</h3>
    const slice = sectionSlice(html, headingPattern);
    if (!slice) return [];
    const items = [];
    const seen = new Set();
    const pattern = /<a\b[^>]*href="(\/serie\/[a-z0-9\-]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(slice)) !== null) {
      const ref = parseSeriesRef(absoluteURL(match[1], BASE_URL));
      if (!ref || seen.has(ref.slug)) continue;
      const imageTag = (match[2].match(/<img\b[^>]*>/i) || [])[0] || "";
      const src = imageTag.match(/\ssrc=(["'])(.*?)\1/i);
      const titleTag = match[2].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
      const item = safeItem(ref.slug, titleTag ? titleTag[1] : "", src ? src[2] : "");
      if (!item) continue;
      seen.add(ref.slug);
      items.push(item);
    }
    return items;
  }

  function resolveFeed(feedID) {
    const key = String(feedID || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FEEDS, key)) return FEEDS[key];
    return FEEDS[DEFAULT_FEED];
  }

  const lastChaptersCache = { data: null };
  const detailsCache = new Map();
  const chaptersCache = new Map();

  async function loadLastChapters() {
    if (lastChaptersCache.data) return lastChaptersCache.data;
    const payload = await requestJSON(lastChaptersURL());
    lastChaptersCache.data = payload;
    return payload;
  }

  async function safeLatest() {
    try {
      return parseLastChapters(await loadLastChapters());
    } catch (_) {
      return [];
    }
  }

  async function safePopular() {
    try {
      return parseHomeSection(await requestHTML(BASE_URL), /populaire/i);
    } catch (_) {
      return [];
    }
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([safePopular(), safeLatest()]);
    const sections = [];
    if (popular.length > 0) sections.push({ id: "popular", title: FEEDS.popular.title, items: popular });
    if (latest.length > 0) sections.push({ id: "latest", title: FEEDS.latest.title, items: latest });
    return { sections };
  }

  async function discoveryFeed(feedID, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const feed = resolveFeed(feedID);
    try {
      if (feed.id === "popular") {
        if (requestedPage !== 1) return { items: [], hasMore: false };
        return { items: await safePopular(), hasMore: false };
      }
      if (requestedPage !== 1) return { items: [], hasMore: false };
      return { items: await safeLatest(), hasMore: false };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function searchResults(query, page = 1) {
    const text = (typeof query === "object" && query !== null ? String(query.text || "") : String(query || "")).trim();
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!text || hasUnsafeMarker(text)) return { items: [], hasMore: false };
    try {
      const payload = await requestJSON(searchURL(text, requestedPage));
      const mangas = payload && typeof payload === "object" && Array.isArray(payload.mangas) ? payload.mangas : [];
      const items = [];
      const seen = new Set();
      for (const entry of mangas) {
        if (!entry || typeof entry !== "object") continue;
        const item = safeItem(entry.slug, entry.title, entry.coverImage);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
      const totalPages = Number(payload && typeof payload === "object" ? payload.pages : NaN);
      const hasMore = items.length > 0 && Number.isFinite(totalPages) && requestedPage < totalPages;
      return { items, hasMore: Boolean(hasMore) };
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

  function balancedJSON(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  function comicSeriesLD(html) {
    // The ComicSeries JSON-LD block carries author/artist/genre/description
    // fallbacks when the info rows change shape.
    const text = String(html || "");
    const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1].trim();
      if (!/ComicSeries/.test(raw)) continue;
      try {
        const parsed = JSON.parse(raw);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const graph = parsed && typeof parsed === "object" && Array.isArray(parsed["@graph"])
          ? parsed["@graph"]
          : candidates;
        for (const node of graph) {
          if (node && typeof node === "object" && String(node["@type"] || "").toLowerCase().includes("comicseries")) {
            return node;
          }
        }
      } catch (_) {
        const open = raw.indexOf("{");
        if (open >= 0) {
          const balanced = balancedJSON(raw, open);
          if (balanced) {
            try {
              const parsed = JSON.parse(balanced);
              if (parsed && typeof parsed === "object") return parsed;
            } catch (_) {
              // Fall through to row parsing.
            }
          }
        }
      }
    }
    return null;
  }

  function infoRow(html, label) {
    // Info rows render as label/value spans: "Statut ... en cours".
    const pattern = new RegExp(
      `${label}<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`,
      "i",
    );
    const match = String(html || "").match(pattern);
    return match ? cleanText(match[1]) : "";
  }

  function ldNames(value) {
    const output = [];
    const list = Array.isArray(value) ? value : [value];
    for (const entry of list) {
      const name = entry && typeof entry === "object" ? cleanText(entry.name) : cleanText(entry);
      if (name && !output.includes(name)) output.push(name);
    }
    return output;
  }

  function parseStatus(value) {
    const normalized = fold(value);
    for (const [marker, status] of STATUS_RULES) {
      if (normalized.includes(marker)) return status;
    }
    return "Unknown";
  }

  function parseGenres(html) {
    const genres = [];
    const pattern = /<a\b[^>]*href="\/series\?tags=([^"']+)"[^>]*>([^<>]+)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const label = cleanText(match[2]);
      if (label && label.length <= 40 && !genres.includes(label)) genres.push(label);
    }
    return genres;
  }

  function parseDescription(html) {
    const text = String(html || "");
    const synopsis = text.match(/synopsis[\s\S]{0,400}?<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (synopsis) {
      const cleaned = cleanText(synopsis[1]).replace(/\s*Lire plus\s*$/i, "").trim();
      if (cleaned.replace(/\s/g, "").length >= 24) {
        return cleaned.length > MAX_DESCRIPTION_CHARS
          ? `${cleaned.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`
          : cleaned;
      }
    }
    const fallback = cleanText(metaContent(text, "property", "og:description"));
    if (fallback.length > MAX_DESCRIPTION_CHARS) return `${fallback.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`;
    return fallback;
  }

  function parseTitle(html) {
    const text = String(html || "");
    const heading = text.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (heading) {
      const title = cleanText(heading[1]);
      if (title) return title;
    }
    const ogTitle = cleanText(metaContent(text, "property", "og:title"));
    if (ogTitle) return ogTitle.replace(/\s*[–—\-|｜]\s*Poseidon Scans.*$/i, "").trim();
    return cleanText((text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "")
      .replace(/\s*[–—\-|｜]\s*Poseidon Scans.*$/i, "").trim();
  }

  function parseCover(html, pageURL, slug) {
    const text = String(html || "");
    const fromMeta = absoluteURL(metaContent(text, "property", "og:image"), pageURL);
    if (fromMeta) return fromMeta;
    const covers = [...text.matchAll(/<img\b[^>]*src=(["'])(.*?)\1[^>]*>/gi)];
    for (const cover of covers) {
      const candidate = absoluteURL(cover[2], pageURL);
      if (candidate && /\/api\/covers\//i.test(candidate)) return candidate;
    }
    return coverURL(slug, "");
  }

  async function loadSeriesHTML(ref) {
    const cacheKey = ref.slug;
    if (detailsCache.has(cacheKey)) return detailsCache.get(cacheKey);
    const html = await requestHTML(ref.href);
    if (isLoginWall(html)) throw permanent("Poseidon Scans series page requires login.");
    detailsCache.set(cacheKey, html);
    return html;
  }

  async function extractDetails(id) {
    const ref = seriesRefFromID(id);
    const html = await loadSeriesHTML(ref);
    const title = parseTitle(html);
    if (!title) throw permanent("Poseidon Scans title is empty after cleaning.");
    if (hasUnsafeMarker(title)) throw permanent("Poseidon Scans title failed the safety filter.");
    const ld = comicSeriesLD(html);
    const rowAuthor = infoRow(html, "Auteur") || infoRow(html, "Artiste");
    const authors = ldNames(ld && [ld.author, ld.artist]);
    if (rowAuthor && !authors.includes(rowAuthor)) authors.unshift(rowAuthor);
    const author = authors.join(", ");
    const genres = parseGenres(html);
    if (!genres.length && ld) {
      for (const name of ldNames(ld.genre)) {
        if (!genres.includes(name)) genres.push(name);
      }
    }
    if ([title, author, ...genres].some(hasUnsafeMarker)) {
      throw permanent("Poseidon Scans details failed the safety filter.");
    }
    const image = parseCover(html, ref.href, ref.slug);
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
      author,
      authors,
      genres,
      status: parseStatus(infoRow(html, "Statut")),
      language: "fr",
    };
  }

  function chapterNumberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 && number <= 100000 ? number : null;
  }

  async function extractChapters(id) {
    const ref = seriesRefFromID(id);
    const cacheKey = ref.slug;
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    // The chapter-1 payload carries the complete chapterList plus mangaData.
    const payload = await requestJSON(chaptersURL(ref.slug));
    const data = payload && typeof payload === "object" ? payload.data : null;
    const list = data && typeof data === "object" && Array.isArray(data.chapterList) ? data.chapterList : [];
    if (list.length === 0) throw permanent("Poseidon Scans returned no chapter list.");
    const mangaData = data && typeof data === "object" && data.mangaData && typeof data.mangaData === "object"
      ? data.mangaData
      : {};
    const seriesTitle = cleanText(mangaData.title) || humanizeSlug(ref.slug);
    const cover = coverURL(ref.slug, mangaData.coverImage);
    // Premium-gated chapters serve no page images anonymously and are
    // excluded: flags come from the series HTML badges plus the recent
    // lastchapters window (best effort, never fatal).
    const premium = new Set();
    try {
      const html = await loadSeriesHTML(ref);
      for (const number of premiumFromSeriesHTML(html)) premium.add(number);
    } catch (_) {
      // The chapter list stays usable without badge flags.
    }
    try {
      const window = await loadLastChapters();
      for (const number of premiumFromLastChapters(window, ref.slug)) premium.add(number);
    } catch (_) {
      // Best-effort source: ignore failures.
    }
    const manga = { id: ref.href, href: ref.href, url: ref.href, title: seriesTitle, cover };
    const seen = new Set();
    const chapters = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const number = chapterNumberValue(entry.number);
      if (number === null || premium.has(number)) continue;
      const href = chapterPageURL(ref.slug, number);
      if (seen.has(href)) continue;
      seen.add(href);
      const suffix = cleanText(entry.title);
      chapters.push({
        id: href,
        href,
        url: href,
        title: suffix && suffix.toLowerCase() !== `chapitre ${number}`.toLowerCase() && suffix.toLowerCase() !== `chapter ${number}`.toLowerCase()
          ? `Chapitre ${number} - ${suffix}`
          : `Chapitre ${number}`,
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
    if (chapters.length === 0) throw permanent("Poseidon Scans returned no readable chapters.");
    // Newest-first: the reader opens the latest free chapter by default.
    chapters.sort((a, b) => b.number - a.number);
    chaptersCache.set(cacheKey, chapters);
    return chapters;
  }

  function chapterRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw permanent("Poseidon Scans chapter identifier is invalid.");
    let href = "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      href = absoluteURL(raw);
    } else if (!raw.includes("//")) {
      const shaped = raw.startsWith("/") ? raw : `/${raw}`;
      href = absoluteURL(shaped.endsWith("/") ? shaped : `${shaped}/`);
    }
    if (!href) throw permanent("Poseidon Scans chapter identifier host or URL is not allowed.");
    let pathname = "";
    try {
      pathname = new URL(href).pathname;
    } catch (_) {
      throw permanent("Poseidon Scans chapter identifier is invalid.");
    }
    const match = pathname.match(/^\/serie\/([a-z0-9\-]+)\/chapter\/(\d+)\/?$/i);
    if (!match || !SLUG_PATTERN.test(match[1].toLowerCase())) {
      throw permanent("Poseidon Scans identifier is not a chapter path.");
    }
    const slug = match[1].toLowerCase();
    const number = Number(match[2]);
    if (!Number.isFinite(number) || number < 1 || number > 100000) {
      throw permanent("Poseidon Scans chapter number is invalid.");
    }
    return { slug, number, href: chapterPageURL(slug, number) };
  }

  function pageImageURL(original, pageURL) {
    const absolute = absoluteURL(original, pageURL);
    if (!absolute) return "";
    let pathname = "";
    try {
      pathname = new URL(absolute).pathname;
    } catch (_) {
      return "";
    }
    // Only source-hosted chapter payloads are returned, in document order.
    if (!/^\/api\/chapters\//i.test(pathname)) return "";
    return `${BASE_URL}/_next/image?url=${encodeURIComponent(absolute)}&w=${IMAGE_WIDTH}&q=${IMAGE_QUALITY}`;
  }

  async function extractImages(id) {
    const ref = chapterRefFromID(id);
    const html = await requestHTML(ref.href);
    const seen = new Set();
    const images = [];
    const pattern = /<img\b[^>]*>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const tag = match[0];
      const sources = [];
      const src = tag.match(/\ssrc=(["'])(.*?)\1/i);
      if (src) sources.push(src[2]);
      const srcset = tag.match(/\ssrcset=(["'])(.*?)\1/i);
      if (srcset) {
        for (const candidate of srcset[2].split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) sources.push(url);
        }
      }
      for (const source of sources) {
        if (/^\s*data:/i.test(source)) continue;
        const proxied = pageImageURL(source, ref.href);
        if (!proxied || seen.has(proxied)) continue;
        seen.add(proxied);
        images.push({ url: proxied, headers: { Referer: ref.href } });
      }
    }
    // A gated (premium) chapter page renders no page images for anonymous
    // readers: fail with a clear message instead of inventing pages.
    if (images.length === 0) throw permanent("Poseidon Scans returned no page images (premium-gated chapters require an account).");
    return images;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
