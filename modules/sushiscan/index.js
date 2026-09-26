"use strict";

// Sushi Scan (https://sushiscan.net) — French scan catalogue and online
// reader (manga / manhwa / manhua). Catalogue entries live at
// "/catalogue/{slug}/" (cover, fiche table, genres, synopsis, complete
// chapter list); chapters live at "/{slug}-chapitre-{N}/" (or
// "-volume-{N}/") with their page images embedded as JSON
// (ts_reader.run payload, "Server 1" sources on c.sushiscan.net).
(() => {
  const BASE_URL = "https://sushiscan.net";
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_DESCRIPTION_CHARS = 1500;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only. "Erotique"/"Erotisme" are
  // deliberately absent: on this source they are mainstream taxonomy tags
  // applied to ordinary romance/drama series, so blocking them would gut the
  // catalogue. The module stays rated "suggestive".
  const UNSAFE_MARKERS = [
    "r 18",
    "x rated",
    "nsfw",
    "hentai",
    "porn",
    "pornographique",
    "smut",
    "explicit",
    "sexuel",
    "sexuelle",
    "sexual",
    "lemon",
    "lime",
  ];
  const STATUS_RULES = [
    ["en cours", "Ongoing"],
    ["termin", "Completed"],
    ["en pause", "On hold"],
    ["abandonn", "Dropped"],
  ];
  // Discovery feeds observed in the site navigation. Unknown feed names fall
  // back to the latest-releases feed instead of an empty Browse screen.
  const FEEDS = {
    latest: { title: "Dernières sorties", path: "/" },
    catalogue: { title: "Catalogue", path: "/catalogue/" },
    updates: { title: "Mis à jour", path: "/catalogue/?order=update" },
  };
  const DEFAULT_FEED = "latest";
  // Catalogue slugs that are never series (genres are feeds, not items).
  const NON_SERIES_PREFIXES = ["genres/"];

  function permanent(message) {
    const error = new Error(message);
    error.sushiscanPermanent = true;
    return error;
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else resolve();
    });
  }

  const NAMED_ENTITIES = {
    amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " ",
    rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C",
    sbquo: "\u201A", bdquo: "\u201E", hellip: "\u2026", mdash: "\u2014",
    ndash: "\u2013", middot: "\u00B7", bull: "\u2022", laquo: "\u00AB",
    raquo: "\u00BB", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
    euro: "\u20AC", eacute: "\u00E9", egrave: "\u00E8", ecirc: "\u00EA",
    agrave: "\u00E0", acirc: "\u00E2", ccedil: "\u00E7", icirc: "\u00EE",
    ocirc: "\u00F4", ucirc: "\u00FB", Eacute: "\u00C9",
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
      .replace(/<br\s*\/?\s*>/gi, "\n")
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
    // Smallest observed allowlist: catalogue, series and chapter pages live
    // on the apex host while covers and page images are served from the
    // numbered image hosts observed in reader payloads (c, c1, ...).
    const host = String(hostname || "").toLowerCase();
    return host === "sushiscan.net" || host.endsWith(".sushiscan.net");
  }

  function absoluteURL(value, base, stripSearch = false) {
    if (typeof value !== "string") return "";
    const input = decodeEntities(value).trim();
    if (!input || input.startsWith("#")) return "";
    try {
      const url = new URL(input, base || BASE_URL);
      if (url.protocol !== "https:" || !allowedHost(url.hostname)) return "";
      url.hash = "";
      // Covers carry a cache-busting "?ver=" query: callers that need a
      // stable file identity strip it, page URLs keep their query string.
      if (stripSearch) url.search = "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  // RFC 6761 reserves ".invalid": such a name can never resolve, so an app
  // executor reporting it is saying "no destination was reached" rather than
  // reporting a redirect to a live unapproved host.
  function isReservedPlaceholderURL(value) {
    try {
      const url = new URL(String(value));
      return url.hostname === "invalid" || url.hostname.endsWith(".invalid");
    } catch (_) {
      return false;
    }
  }

  function isChallengePage(body) {
    return /(?:cf-chl-|cf-turnstile|challenge-platform|just a moment|attention required|access denied|verify you are human|checking your browser|enable javascript and cookies)/i
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

  async function requestHTML(url) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Sushi Scan requires the fetchv2 bridge.");
    const requestURL = absoluteURL(url);
    if (!requestURL) throw permanent("Sushi Scan request URL is not public or host-confined.");
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) await sleep(600);
      try {
        const response = await globalThis.fetchv2(
          requestURL,
          { ...DEFAULT_HEADERS },
          "GET",
          null,
          { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass: "html" },
        );
        if (!response) throw permanent("Sushi Scan returned no response.");
        if (response.bodyDropped) throw permanent("Sushi Scan response exceeded the module limit.");
        const status = Number(response.status) || 0;
        const finalURL = typeof response.finalUrl === "string" ? response.finalUrl : "";
        if (finalURL && !isReservedPlaceholderURL(finalURL) && !absoluteURL(finalURL)) {
          throw permanent("Sushi Scan redirected to a non-public or unapproved host.");
        }
        if (status && (status < 200 || status >= 300)) {
          const message = `Sushi Scan request failed with HTTP ${status}.`;
          if (RETRYABLE_STATUS.has(status)) {
            lastError = new Error(message);
            continue;
          }
          throw permanent(message);
        }
        const headerType = response.headers && (response.headers["content-type"] || response.headers["Content-Type"]);
        const contentType = String(response.contentType || headerType || "").toLowerCase();
        if (contentType && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
          throw permanent("Sushi Scan returned a non-HTML response.");
        }
        const body = await responseBody(response);
        if (!body) throw permanent("Sushi Scan returned an empty response.");
        if (isChallengePage(body)) throw permanent("Sushi Scan returned a browser challenge.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.sushiscanPermanent) throw lastError;
        if (attempt >= 2) throw lastError;
      }
    }
    throw lastError || new Error("Sushi Scan request failed.");
  }

  function metaContent(html, attribute, name) {
    const tag = String(html || "").match(
      new RegExp(`<meta[^>]*${attribute}=["']${name}["'][^>]*>`, "i"),
    );
    if (!tag) return "";
    const content = tag[0].match(/content=(["'])((?:[^"'\\]|\\.)*)\1/i);
    return content ? decodeEntities(content[2]) : "";
  }

  const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/;

  // Catalogue entries live at "/catalogue/{slug}/".
  function parseSeriesRef(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "sushiscan.net") return null;
    const match = url.pathname.match(/^\/catalogue\/([^/]+)\/?$/);
    if (!match) return null;
    const slug = match[1];
    if (!SLUG_PATTERN.test(slug)) return null;
    const lowered = slug.toLowerCase();
    if (NON_SERIES_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
    return { id: slug, href: `${BASE_URL}/catalogue/${slug}/` };
  }

  function humanizeSlug(slug) {
    return String(slug || "")
      .replace(/[_~.]+/g, " ")
      .replace(/-+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  }

  function coverFromVicinity(imageTag, pageURL) {
    if (!imageTag) return "";
    // Covers are often lazy-loaded: data-original / data-lazy-src / data-src
    // carry the real file while src holds a placeholder (or nothing), and
    // srcset lists candidates. The first usable source-hosted file wins;
    // placeholders never count as covers.
    const attributes = [];
    for (const name of ["data-original", "data-lazy-src", "data-src"]) {
      const found = imageTag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, "i"));
      if (found) attributes.push(found[2]);
    }
    const srcset = imageTag.match(/\ssrcset=(["'])(.*?)\1/i);
    if (srcset) {
      for (const candidate of srcset[2].split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) attributes.push(url);
      }
    }
    const dataSrcset = imageTag.match(/\sdata-srcset=(["'])(.*?)\1/i);
    if (dataSrcset) {
      for (const candidate of dataSrcset[2].split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) attributes.push(url);
      }
    }
    const source = imageTag.match(/\ssrc=(["'])(.*?)\1/i);
    if (source) attributes.push(source[2]);
    for (const candidate of attributes) {
      // Inline base64 placeholders ("data:image/...") are never covers.
      if (/^\s*data:/i.test(candidate)) continue;
      const absolute = absoluteURL(candidate, pageURL, true);
      if (!absolute) continue;
      if (/\/lazy_[^/]*$/i.test(absolute)) continue;
      if (!/\/(wp-content|uploads|media|cover|img)\//i.test(absolute)) continue;
      return absolute;
    }
    return "";
  }

  function cleanSeriesTitle(value) {
    // Listing anchors carry site labels around the real series name
    // ("Manga One Piece Chapitre 1180"). The leading category prefix and a
    // trailing chapter reference are stripped; a trailing "Volume N" is kept
    // because it can genuinely belong to the series title.
    let title = cleanText(value);
    title = title.replace(/^(?:manga|manhwa|manhua|novel|webtoon|bd|comics?|artbook|fanbook)\s*[:\-–—]?\s+/i, "").trim();
    title = title.replace(/\s+(?:chapitre|ch\.?)\s*\d+(?:[.,]\d+)?\s*$/i, "").trim();
    return title;
  }

  const CATEGORY_WORD = /^(?:manga|manhwa|manhua|novel|webtoon|bd|comics?|artbook|fanbook)$/i;

  function withoutBadges(inner) {
    // Type badges ("Manga", "Manhwa"...) must never become the item title.
    return String(inner || "")
      .replace(/<span\b[^>]*class="[^"]*(?:typename|type|mtype)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, " ");
  }

  function ttText(inner) {
    const tt = String(inner || "").match(/<div\b[^>]*class="[^"]*\btt\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    return tt ? cleanText(tt[1]) : "";
  }

  function tagAttribute(tag, name) {
    const found = String(tag || "").match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, "i"));
    return found ? decodeEntities(found[2]).trim() : "";
  }

  function resolveTitle(entry, slug) {
    // Explicit title sources first (anchor title attribute, .tt block, image
    // alt text), raw anchor text last. A bare category word is never a
    // title: the chain falls through to the humanized slug instead.
    const candidates = [
      entry.titleAttr,
      ttText(entry.inner),
      cleanSeriesTitle(withoutBadges(entry.inner)),
      entry.imgAlt,
    ];
    for (const candidate of candidates) {
      const title = cleanSeriesTitle(candidate);
      if (title && !CATEGORY_WORD.test(title) && !hasUnsafeMarker(title)) return title;
    }
    const fallback = humanizeSlug(slug);
    return fallback && !CATEGORY_WORD.test(fallback) ? fallback : "";
  }

  function safeItem(entry) {
    if (!entry || typeof entry !== "object") return null;
    try {
      const ref = parseSeriesRef(absoluteURL(entry.href) || "");
      if (!ref) return null;
      const title = resolveTitle(entry, ref.id);
      if (!title || hasUnsafeMarker(title)) return null;
      const image = entry.image || "";
      if (image && hasUnsafeMarker(image)) return null;
      // "poster" duplicates the cover under the other name reader apps and
      // library screens look up. Every URL here is absolute HTTPS.
      return {
        id: ref.id,
        href: ref.href,
        url: ref.href,
        title,
        image,
        cover: image,
        coverUrl: image,
        poster: image,
        language: "fr",
      };
    } catch (_) {
      return null;
    }
  }

  function parseSeriesAnchors(html, pageURL) {
    // Container-independent: series anchors carry class="series" and point
    // at "/catalogue/{slug}/". The cover is the image inside the anchor, or
    // the closest image right before it (latest-releases rows render the
    // cover first, then the links).
    const items = [];
    const seen = new Set();
    const text = String(html || "");
    const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const href = absoluteURL(match[1], pageURL);
      if (!href || !parseSeriesRef(href)) continue;
      const openTag = (match[0].match(/^<a\b[^>]*>/i) || [])[0] || "";
      const innerImage = (match[2].match(/<img\b[^>]*>/i) || [])[0] || "";
      let imageTag = innerImage;
      let image = coverFromVicinity(imageTag, pageURL);
      if (!image) {
        const behind = text.slice(Math.max(0, match.index - 1200), match.index);
        const tags = [...behind.matchAll(/<img\b[^>]*>/gi)];
        for (let index = tags.length - 1; index >= 0 && !image; index -= 1) {
          const gap = behind.slice((tags[index].index || 0) + tags[index][0].length);
          if (/\/catalogue\/[^/"]+\/?["']/i.test(gap)) continue;
          imageTag = tags[index][0];
          image = coverFromVicinity(imageTag, pageURL);
        }
      }
      const item = safeItem({
        inner: match[2],
        titleAttr: tagAttribute(openTag, "title"),
        imgAlt: tagAttribute(imageTag, "alt") || tagAttribute(imageTag, "title"),
        href,
        image,
      });
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  function hasNextPageLink(html) {
    const text = String(html || "");
    if (/<link[^>]+rel=(["'])next\1/i.test(text)) return true;
    if (/<a\b[^>]*class="[^"]*page-numbers next[^"]*"[^>]*href=/i.test(text)) return true;
    if (/<a\b[^>]*rel=(["'])next\1[^>]*href=/i.test(text)) return true;
    if (/>Suivant</i.test(text)) return true;
    return false;
  }

  function searchURL(query, page) {
    // Standard WordPress search, declared by the site's own SearchAction.
    const encoded = `?s=${encodeURIComponent(query)}`;
    if (page <= 1) return `${BASE_URL}/${encoded}`;
    return `${BASE_URL}/page/${page}/${encoded}`;
  }

  function feedURL(feed, page) {
    const base = `${BASE_URL}${feed.path}`;
    if (page <= 1) return base;
    if (feed.path === "/") return `${BASE_URL}/page/${page}/`;
    if (feed.path.includes("?")) return `${base}&paged=${page}`;
    return `${base}page/${page}/`;
  }

  function resolveFeed(feedID) {
    const key = String(feedID || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FEEDS, key)) return FEEDS[key];
    if (key === "all" || key === "home" || key === "updates-latest") return FEEDS[DEFAULT_FEED];
    return FEEDS[DEFAULT_FEED];
  }

  async function safeFeed(feed, page) {
    try {
      const requestedPage = Math.max(1, Number(page) || 1);
      const pageURL = feedURL(feed, requestedPage);
      const html = await requestHTML(pageURL);
      const items = parseSeriesAnchors(html, pageURL);
      // Browsing degrades to an empty list instead of crashing the source
      // screen: a malformed listing page never takes the reader nowhere.
      if (items.length === 0) return { items: [], hasMore: false };
      return { items, hasMore: hasNextPageLink(html) };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function discoveryHome() {
    try {
      const pageURL = feedURL(FEEDS[DEFAULT_FEED], 1);
      const html = await requestHTML(pageURL);
      const items = parseSeriesAnchors(html, pageURL);
      if (items.length === 0) return { sections: [] };
      return { sections: [{ id: "latest", title: FEEDS.latest.title, items }] };
    } catch (_) {
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedID, page = 1) {
    return safeFeed(resolveFeed(feedID), page);
  }

  async function searchResults(query, page = 1) {
    const text = (typeof query === "object" && query !== null ? String(query.text || "") : String(query || "")).trim();
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!text || hasUnsafeMarker(text)) return { items: [], hasMore: false };
    try {
      const pageURL = searchURL(text, requestedPage);
      const html = await requestHTML(pageURL);
      const items = parseSeriesAnchors(html, pageURL);
      return { items, hasMore: items.length > 0 && hasNextPageLink(html) };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  function pageTitle(html) {
    const text = String(html || "");
    const heading = text.match(/<h1\b[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    if (heading) {
      const title = cleanText(heading[1]);
      if (title) return title;
    }
    const title = cleanText((text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
    return title.replace(/\s*[-|｜]\s*Sushiscan.*$/i, "").trim();
  }

  function coverImage(html, pageURL) {
    const text = String(html || "");
    const fromMeta = absoluteURL(metaContent(text, "property", "og:image"), pageURL);
    if (fromMeta) return fromMeta;
    const featured = text.match(/<img[^>]*class="[^"]*wp-post-image[^"]*"[^>]*>/i)
      || text.match(/<img[^>]*\/wp-content\/uploads\/[^>]*>/i);
    if (!featured) return "";
    return coverFromVicinity(featured[0], pageURL);
  }

  function infoTable(html) {
    // The fiche table renders parallel label/value rows; values are matched
    // to labels by position.
    const table = (String(html || "").match(/<table\b[^>]*class="[^"]*infotable[^"]*"[^>]*>([\s\S]*?)<\/table>/i) || [])[1] || "";
    const rows = [];
    const pattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = pattern.exec(table)) !== null) {
      const cells = [];
      const cellPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
      let cell;
      while ((cell = cellPattern.exec(row[1])) !== null) cells.push(cell[1]);
      if (cells.length >= 2) rows.push(cells);
    }
    const map = new Map();
    for (const [label, value] of rows) {
      const key = fold(label);
      if (key && !map.has(key)) map.set(key, value);
    }
    return map;
  }

  function infoValue(rows, ...names) {
    for (const name of names) {
      const folded = fold(name);
      for (const [key, value] of rows) {
        if (key === folded) return value;
      }
    }
    return "";
  }

  function linkLabels(html) {
    const output = [];
    const pattern = /<a\b[^>]*>([^<>]+)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const label = cleanText(match[1]);
      if (label && label.length <= 40) output.push(label);
    }
    return [...new Set(output)];
  }

  function parseStatus(value) {
    const normalized = fold(value);
    for (const [marker, status] of STATUS_RULES) {
      if (normalized.includes(marker)) return status;
    }
    return "";
  }

  function pageDescription(html) {
    const block = (String(html || "").match(/<div\b[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
    const paragraphs = [];
    const pattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = pattern.exec(block)) !== null) {
      const text = cleanText(match[1]);
      if (text.replace(/\s/g, "").length >= 24) paragraphs.push(text);
    }
    let joined = paragraphs.join("\n\n").trim();
    if (!joined) joined = cleanText(metaContent(html, "property", "og:description"));
    if (joined.length > MAX_DESCRIPTION_CHARS) joined = `${joined.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`;
    return joined;
  }

  const detailsCache = new Map();
  const chaptersCache = new Map();

  async function extractDetails(id) {
    const ref = seriesRefFromID(id);
    const cacheKey = ref.id.toLowerCase();
    if (detailsCache.has(cacheKey)) return detailsCache.get(cacheKey);
    const html = await requestHTML(ref.href);
    const title = pageTitle(html);
    if (!title) throw new Error("Sushi Scan title is empty after cleaning.");
    if (hasUnsafeMarker(title)) throw new Error("Sushi Scan title failed the safety filter.");
    const rows = infoTable(html);
    const authors = linkLabels(infoValue(rows, "auteur", "auteurs", "artiste"));
    const author = authors.join(", ");
    const genreBlock = (String(html || "").match(/<div\b[^>]*class="[^"]*seriestugenre[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
    const genres = linkLabels(genreBlock);
    if ([title, ...genres].some(hasUnsafeMarker)) {
      throw new Error("Sushi Scan details failed the safety filter.");
    }
    const image = coverImage(html, ref.href);
    const details = {
      id: ref.id,
      href: ref.href,
      url: ref.href,
      title,
      description: pageDescription(html),
      image,
      cover: image,
      coverUrl: image,
      poster: image,
      author,
      authors,
      genres,
      status: parseStatus(cleanText(infoValue(rows, "statut", "status"))),
      language: "fr",
    };
    detailsCache.set(cacheKey, details);
    return details;
  }

  function seriesRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Sushi Scan identifier is invalid.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const ref = parseSeriesRef(raw);
      if (!ref) throw new Error("Sushi Scan identifier host or URL is not allowed.");
      return ref;
    }
    if (raw.includes("//")) throw new Error("Sushi Scan identifier host or URL is not allowed.");
    const shaped = raw.startsWith("/") ? `${BASE_URL}${raw}` : `${BASE_URL}/catalogue/${raw}/`;
    const ref = parseSeriesRef(shaped);
    if (!ref) throw new Error("Sushi Scan identifier is not a series path.");
    return ref;
  }

  function chapterNumber(title) {
    const match = String(title || "").match(/(?:chapitre|ch\.?|volume|vol\.?)\s*(\d+(?:[.,]\d+)?)/i);
    if (!match) return null;
    const value = Number(match[1].replace(",", "."));
    return Number.isFinite(value) ? value : null;
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseChapterEntries(html, pageURL, seriesSlug) {
    // Container-independent: chapter anchors are collected wherever they
    // render (#chapterlist, .eplister, .clstyle rows, collapsible volumes).
    // Ownership is enforced on the URL stem. Catalogue slugs sometimes carry
    // a numeric disambiguation prefix ("1-blue-lock") that chapter URLs drop
    // ("blue-lock-chapitre-345"), and a catalogue slug can even mismatch its
    // chapter stem outright ("pluuto" vs "pluto-vol-8"). Both shapes own
    // chapters. When nothing matches the catalogue slug, the page's dominant
    // chapter family is adopted only if unambiguous (3+ links, or a stem
    // textually overlapping the slug); related-series sidebars stay out.
    // Early chapters ship as compiled volumes under "-vol-" URLs, which are
    // equally owned and readable.
    const text = String(html || "");
    const bases = [...new Set([seriesSlug, seriesSlug.replace(/^\d+-/, "")])].map(escapeRegExp);
    const owned = new RegExp(`^/(${bases.join("|")})-(chapitre|volume|vol)-\\d+(?:-\\d+)?/?$`, "i");
    const shaped = /^\/([^/]+)-(chapitre|volume|vol)-\d+(?:-\d+)?\/?$/i;
    const slugFolded = fold(seriesSlug);
    const candidates = [];
    const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const href = absoluteURL(match[1], pageURL, true);
      if (!href) continue;
      let pathname = "";
      try {
        pathname = new URL(href).pathname;
      } catch (_) {
        continue;
      }
      const shape = pathname.match(shaped);
      if (!shape) continue;
      const numbered = (match[2].match(/<span\b[^>]*class="[^"]*chapternum[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
      const behind = text.slice(Math.max(0, match.index - 600), match.index);
      const dataNum = (behind.match(/<li\b[^>]*data-num="([^"]+)"[^>]*>(?!.*<li\b[^>]*data-num=)/is) || [])[1];
      const title = cleanText(numbered || dataNum || match[2]);
      if (!title || hasUnsafeMarker(title)) continue;
      candidates.push({ href, title, stem: shape[1].toLowerCase(), direct: owned.test(pathname) });
    }
    const direct = candidates.filter((entry) => entry.direct);
    let kept = direct;
    if (direct.length === 0) {
      const groups = new Map();
      for (const entry of candidates) {
        if (!groups.has(entry.stem)) groups.set(entry.stem, []);
        groups.get(entry.stem).push(entry);
      }
      let adopted = [];
      for (const [stem, entries] of groups) {
        const overlaps = slugFolded.includes(fold(stem)) || fold(stem).includes(slugFolded);
        if (entries.length >= 3 || (overlaps && entries.length >= 1)) {
          if (entries.length > adopted.length) adopted = entries;
        }
      }
      kept = adopted;
    }
    // Deduplicate by URL, preserving document order.
    const seen = new Set();
    const entries = [];
    for (const { href, title } of kept) {
      if (seen.has(href)) continue;
      seen.add(href);
      entries.push({ href, title });
    }
    return entries;
  }

  function chapterID(href) {
    return new URL(href).pathname.split("/").filter(Boolean).pop();
  }

  async function extractChapters(id) {
    const ref = seriesRefFromID(id);
    const cacheKey = ref.id.toLowerCase();
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    const html = await requestHTML(ref.href);
    // The series page carries its complete chapter list: every kept row is
    // returned oldest-first, never capped to a UI-sized window. The series
    // cover rides along on each chapter — flat fields plus a nested manga
    // object — so "Continue Reading" and library screens can always display
    // it whatever property name they read.
    const cover = coverImage(html, ref.href);
    const seriesTitle = pageTitle(html) || humanizeSlug(ref.id);
    const manga = { id: ref.id, href: ref.href, url: ref.href, title: seriesTitle, cover };
    const collected = parseChapterEntries(html, ref.href, ref.id).map((entry) => ({
      id: chapterID(entry.href),
      href: entry.href,
      url: entry.href,
      title: entry.title,
      number: chapterNumber(entry.title),
      image: cover,
      cover,
      coverUrl: cover,
      poster: cover,
      manga,
    }));
    collected.sort((a, b) => {
      if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
      return 0;
    });
    chaptersCache.set(cacheKey, collected);
    return collected;
  }

  function chapterRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Sushi Scan chapter identifier is invalid.");
    let href = "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      href = absoluteURL(raw);
    } else if (!raw.includes("//")) {
      const shaped = raw.startsWith("/") ? raw : `/${raw}`;
      href = absoluteURL(shaped.endsWith("/") ? shaped : `${shaped}/`);
    }
    if (!href) throw new Error("Sushi Scan chapter identifier host or URL is not allowed.");
    let pathname = "";
    try {
      pathname = new URL(href).pathname;
    } catch (_) {
      throw new Error("Sushi Scan chapter identifier is invalid.");
    }
    if (!/^\/[^/]+-(chapitre|volume|vol)-\d+(?:-\d+)?\/?$/i.test(pathname)) {
      throw new Error("Sushi Scan identifier is not a chapter path.");
    }
    return href;
  }

  function balancedJSON(text, start) {
    // Extracts the {...} payload starting at start, respecting strings and
    // escapes. Returns null on malformed input instead of guessing.
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

  function readerSources(html) {
    const text = String(html || "");
    const marker = text.indexOf("ts_reader.run(");
    if (marker < 0) return null;
    const open = text.indexOf("{", marker);
    if (open < 0) return null;
    const payload = balancedJSON(text, open);
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch (_) {
      return null;
    }
  }

  async function extractImages(id) {
    const pageURL = chapterRefFromID(id);
    const html = await requestHTML(pageURL);
    const data = readerSources(html);
    const sources = data && Array.isArray(data.sources) ? data.sources : [];
    const withImages = sources.filter((source) => source && Array.isArray(source.images) && source.images.length > 0);
    // Prefer the reader's default source, but never an empty one: fall back
    // to the first source that actually carries images.
    const wanted = withImages.find((source) => source.source === data.defaultSource) || withImages[0];
    const candidates = wanted ? wanted.images : [];
    // Only source-hosted page images are returned, in payload order. Foreign
    // hosts and non-image targets are dropped; an empty payload fails
    // instead of inventing pages.
    const seen = new Set();
    const images = [];
    for (const candidate of candidates) {
      const absolute = absoluteURL(String(candidate || ""), pageURL);
      if (!absolute || seen.has(absolute)) continue;
      let pathname = "";
      try {
        pathname = new URL(absolute).pathname;
      } catch (_) {
        continue;
      }
      if (!/\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(pathname)) continue;
      seen.add(absolute);
      images.push({ url: absolute, headers: { Referer: pageURL } });
    }
    if (images.length === 0) throw new Error("Sushi Scan returned no page images.");
    return images;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
