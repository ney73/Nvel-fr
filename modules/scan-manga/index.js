"use strict";

// Scan-Manga (https://www.scan-manga.com) — French scantrad catalogue and
// online reader (manga / webtoon / novel). Series pages ("/{id}/{Slug}.html")
// are server-rendered with full metadata and complete chapter lists; the
// chapter reader itself ("/lecture-en-ligne/...") renders its page images
// through the site's own scripts, so extractImages runs inside the
// app-owned WebKit bridge (pagev2, declared as interactivePage) instead of
// re-implementing downloaded code.
(() => {
  const BASE_URL = "https://www.scan-manga.com";
  const STATIC_URL = "https://static.scan-manga.com";
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_DESCRIPTION_CHARS = 1500;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only (same doctrine as the sibling
  // modules): mainstream maturity/romance sub-genre labels never block a
  // title on their own, so the module stays rated "suggestive".
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
  const STATUS_RULES = [
    ["en cours", "Ongoing"],
    ["termin", "Completed"],
    ["en pause", "On hold"],
    ["abandonn", "Dropped"],
  ];
  // Discovery feeds observed in the site navigation. Unknown feed names fall
  // back to the latest-releases feed instead of an empty Browse screen.
  const FEEDS = {
    latest: { title: "Dernières sorties", path: "/?home" },
    top: { title: "Top", path: "/TOP-Manga-Webtoon-47.html" },
    shonen: { title: "Top Shonen", path: "/TOP-Shonen-56.html" },
    seinen: { title: "Top Seinen", path: "/TOP-Seinen-13.html" },
    yuri: { title: "Top Yuri", path: "/TOP-Yuri-34.html" },
    shojo: { title: "Top Shojo", path: "/TOP-Shojo-39.html" },
    josei: { title: "Top Josei", path: "/TOP-Josei-28.html" },
    yaoi: { title: "Top Yaoi", path: "/TOP-Yaoi-107.html" },
    isekai: { title: "Top Isekai", path: "/TOP-Isekai-58.html" },
    adulte: { title: "Top Adulte", path: "/TOP-Adulte-54.html" },
    shojoai: { title: "Top Shojo-Ai", path: "/TOP-Shojo-Ai-3.html" },
    oneshot: { title: "Top One Shot", path: "/TOP-One-Shot-3.html" },
    ecchi: { title: "Top Ecchi", path: "/TOP-Ecchi-11.html" },
    shonenai: { title: "Top Shonen-Ai", path: "/TOP-Shonen-Ai-8.html" },
  };
  const DEFAULT_FEED = "latest";
  // Site slugs that are never series: static pages, teams, authors, feeds.
  const NON_SERIES_SLUGS = new Set([
    "favoris", "mes-favoris", "teams", "a-propos", "nous", "partenariat",
    "recherche", "error", "contact",
  ]);

  function permanent(message) {
    const error = new Error(message);
    error.scanmangaPermanent = true;
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
    // Smallest observed allowlist: catalogue, series and reader pages live on
    // the www host while covers and page images are served from the static
    // host. External reader mirrors (webtoons.com, manga-nova.com, ...) are
    // deliberately excluded: they are not source-owned content.
    const host = String(hostname || "").toLowerCase();
    return host === "www.scan-manga.com" || host === "static.scan-manga.com";
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
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Scan-Manga requires the fetchv2 bridge.");
    const requestURL = absoluteURL(url);
    if (!requestURL) throw permanent("Scan-Manga request URL is not public or host-confined.");
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
        if (!response) throw permanent("Scan-Manga returned no response.");
        if (response.bodyDropped) throw permanent("Scan-Manga response exceeded the module limit.");
        const status = Number(response.status) || 0;
        const finalURL = typeof response.finalUrl === "string" ? response.finalUrl : "";
        if (finalURL && !isReservedPlaceholderURL(finalURL) && !absoluteURL(finalURL)) {
          throw permanent("Scan-Manga redirected to a non-public or unapproved host.");
        }
        if (status && (status < 200 || status >= 300)) {
          const message = `Scan-Manga request failed with HTTP ${status}.`;
          if (RETRYABLE_STATUS.has(status)) {
            lastError = new Error(message);
            continue;
          }
          throw permanent(message);
        }
        const headerType = response.headers && (response.headers["content-type"] || response.headers["Content-Type"]);
        const contentType = String(response.contentType || headerType || "").toLowerCase();
        if (contentType && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
          throw permanent("Scan-Manga returned a non-HTML response.");
        }
        const body = await responseBody(response);
        if (!body) throw permanent("Scan-Manga returned an empty response.");
        if (isChallengePage(body)) throw permanent("Scan-Manga returned a browser challenge.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.scanmangaPermanent) throw lastError;
        if (attempt >= 2) throw lastError;
      }
    }
    throw lastError || new Error("Scan-Manga request failed.");
  }

  function metaContent(html, attribute, name) {
    const tag = String(html || "").match(
      new RegExp(`<meta[^>]*${attribute}=["']${name}["'][^>]*>`, "i"),
    );
    if (!tag) return "";
    const content = tag[0].match(/content=(["'])((?:[^"'\\]|\\.)*)\1/i);
    return content ? decodeEntities(content[2]) : "";
  }

  // Series pages live at "/{numericId}[-{extra}]/{Slug}.html"
  // (e.g. "/17107/Digimon-Cross-Wars.html"). Anything else is not a series.
  function parseSeriesRef(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "www.scan-manga.com") return null;
    const match = url.pathname.match(/^\/(\d+(?:-\d+)?)\/([^/]+)\.html\/?$/);
    if (!match) return null;
    const slug = match[2];
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/.test(slug)) return null;
    if (NON_SERIES_SLUGS.has(slug.toLowerCase())) return null;
    if (/^(auteur|team|publications)-/i.test(slug)) return null;
    return { id: `${match[1]}/${slug}`, href: `${BASE_URL}/${match[1]}/${slug}.html` };
  }

  function humanizeSlug(slug) {
    return String(slug || "")
      .replace(/[_~.]+/g, " ")
      .replace(/-+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  }

  function coverFromTag(imageTag, pageURL) {
    if (!imageTag) return "";
    // Covers are lazy-loaded: data-original carries the real file while src
    // holds a placeholder. Prefer the real file, never the placeholder.
    const original = imageTag.match(/\sdata-original=(["'])(.*?)\1/i);
    const source = imageTag.match(/\ssrc=(["'])(.*?)\1/i);
    for (const candidate of [original && original[2], source && source[2]]) {
      if (!candidate) continue;
      const absolute = absoluteURL(candidate, pageURL);
      if (!absolute) continue;
      if (/\/lazy_[^/]*$/i.test(absolute)) continue;
      if (!/\/(img|images|uploads|media|cover)\//i.test(absolute)) continue;
      return absolute;
    }
    return "";
  }

  function safeItem(entry) {
    if (!entry || typeof entry !== "object") return null;
    try {
      const ref = parseSeriesRef(absoluteURL(entry.href) || "");
      if (!ref) return null;
      let title = cleanText(entry.title);
      if (!title) title = humanizeSlug(ref.id.split("/")[1]);
      if (!title || hasUnsafeMarker(title)) return null;
      const image = entry.image || "";
      if (image && hasUnsafeMarker(image)) return null;
      return {
        id: ref.id,
        href: ref.href,
        url: ref.href,
        title,
        image,
        cover: image,
        coverUrl: image,
        language: "fr",
      };
    } catch (_) {
      return null;
    }
  }

  function nearbyImage(html, anchorStart, anchorEnd, pageURL) {
    const text = String(html || "");
    // Covers render just before their series anchor (or inside it). The
    // backward window never crosses another series link, so a previous
    // entry's cover can never leak into the next item.
    const behind = text.slice(Math.max(0, anchorStart - 1200), anchorStart);
    const behindImages = [...behind.matchAll(/<img\b[^>]*>/gi)];
    for (let index = behindImages.length - 1; index >= 0; index -= 1) {
      const tag = behindImages[index][0];
      const gap = text.slice(anchorStart - behind.length + (behindImages[index].index || 0) + tag.length, anchorStart);
      if (/\/\d+(?:-\d+)?\/[^/"]+\.html/i.test(gap)) continue;
      const image = coverFromTag(tag, pageURL);
      if (image) return image;
    }
    const ahead = text.slice(anchorEnd, anchorEnd + 400);
    const nextImage = (ahead.match(/<img\b[^>]*>/i) || [])[0] || "";
    const gap = ahead.slice(0, ahead.indexOf(nextImage));
    if (nextImage && !/\/\d+(?:-\d+)?\/[^/"]+\.html/i.test(gap)) {
      return coverFromTag(nextImage, pageURL);
    }
    return "";
  }

  function parseSeriesAnchors(html, pageURL) {
    // Container-independent: every anchor pointing at a series page is a
    // catalogue entry, whatever list or grid wraps it. The nearest cover
    // image (inside the anchor or just before it) becomes the cover.
    const items = [];
    const seen = new Set();
    const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const href = absoluteURL(match[1], pageURL);
      if (!href || !parseSeriesRef(href)) continue;
      const innerImage = (match[2].match(/<img\b[^>]*>/i) || [])[0] || "";
      const image = coverFromTag(innerImage, pageURL)
        || nearbyImage(html, match.index, match.index + match[0].length, pageURL);
      const item = safeItem({ title: match[2], href, image });
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
    return false;
  }

  function searchURL(query) {
    // Official OpenSearch template declared by the site itself.
    return `${BASE_URL}/scanlation/liste_series.html?q=${encodeURIComponent(query)}`;
  }

  function feedURL(feed) {
    return `${BASE_URL}${feed.path}`;
  }

  function resolveFeed(feedID) {
    const key = String(feedID || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FEEDS, key)) return FEEDS[key];
    if (key === "all" || key === "home" || key === "catalogue" || key === "latest-releases") return FEEDS[DEFAULT_FEED];
    return FEEDS[DEFAULT_FEED];
  }

  async function safeFeed(feed) {
    try {
      const pageURL = feedURL(feed);
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
      const pageURL = feedURL(FEEDS[DEFAULT_FEED]);
      const html = await requestHTML(pageURL);
      const items = parseSeriesAnchors(html, pageURL);
      if (items.length === 0) return { sections: [] };
      return { sections: [{ id: "latest", title: FEEDS.latest.title, items }] };
    } catch (_) {
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedID, page = 1) {
    void page;
    return safeFeed(resolveFeed(feedID));
  }

  async function searchResults(query, page = 1) {
    const text = (typeof query === "object" && query !== null ? String(query.text || "") : String(query || "")).trim();
    const requestedPage = Math.max(1, Number(page) || 1);
    // The site exposes no static search payload (its search box is
    // script-driven): only the first page carries server results, and an
    // empty render degrades to an empty list instead of invented matches.
    if (!text || requestedPage !== 1 || hasUnsafeMarker(text)) return { items: [], hasMore: false };
    try {
      const pageURL = searchURL(text);
      const html = await requestHTML(pageURL);
      return { items: parseSeriesAnchors(html, pageURL), hasMore: false };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  function ficheRows(html) {
    // The "fiche technique" renders parallel title/value lists; values are
    // matched to titles by position.
    const titlesBlock = (String(html || "").match(/<div class="contenu_titres_fiche_technique">([\s\S]*?)<\/div>/i) || [])[1] || "";
    const valuesBlock = (String(html || "").match(/<div class="contenu_texte_fiche_technique">([\s\S]*?)<\/div>/i) || [])[1] || "";
    const cells = (block) => {
      const output = [];
      const pattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let match;
      while ((match = pattern.exec(block)) !== null) output.push(match[1]);
      return output;
    };
    const titles = cells(titlesBlock).map((cell) => fold(cell));
    const values = cells(valuesBlock);
    const map = new Map();
    for (let index = 0; index < titles.length; index += 1) {
      if (!map.has(titles[index])) map.set(titles[index], values[index] || "");
    }
    return map;
  }

  function rowHTML(rows, ...names) {
    for (const name of names) {
      const folded = fold(name);
      for (const [key, value] of rows) {
        if (key === folded || key.startsWith(`${folded} `)) return value;
      }
    }
    return "";
  }

  function ficheAuthors(html) {
    const output = [];
    const pattern = /<a\b[^>]*>([^<>]+)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const author = cleanText(match[1]);
      if (author) output.push(author);
    }
    return [...new Set(output)];
  }

  function splitGenres(html) {
    // Genre cells mix genre links with their descriptions: only link labels
    // are kept, never description sentences.
    const output = [];
    const pattern = /<a\b[^>]*>([^<>]+)<\/a>/gi;
    let match;
    while ((match = pattern.exec(String(html || ""))) !== null) {
      const genre = cleanText(match[1]);
      if (genre && genre.length <= 40) output.push(genre);
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

  function pageTitle(html) {
    const match = String(html || "").match(/<title>([\s\S]*?)<\/title>/i);
    const title = cleanText(match ? match[1] : "").replace(/\s*[|｜]\s*Scan-Manga.*$/i, "").trim();
    return title;
  }

  function coverImage(html, pageURL) {
    const text = String(html || "");
    const block = text.match(/<div class="image_manga"[^>]*>([\s\S]*?)<\/div>/i);
    const tag = block ? block[1].match(/<img\b[^>]*>/i) : null;
    const fromBlock = tag ? coverFromTag(tag[0], pageURL) : "";
    if (fromBlock) return fromBlock;
    return absoluteURL(metaContent(text, "property", "og:image"), pageURL)
      || absoluteURL(metaContent(text, "name", "twitter:image"), pageURL);
  }

  function pageDescription(html) {
    const block = (String(html || "").match(/<div class="texte_synopsis_manga[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
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
    if (!title) throw new Error("Scan-Manga title is empty after cleaning.");
    if (hasUnsafeMarker(title)) throw new Error("Scan-Manga title failed the safety filter.");
    const rows = ficheRows(html);
    const authors = ficheAuthors(rowHTML(rows, "auteur/artiste", "auteur", "artiste"));
    const author = authors.join(", ");
    const genres = splitGenres(rowHTML(rows, "genres", "genre"));
    if (genres.some((genre) => hasUnsafeMarker(genre))) {
      throw new Error("Scan-Manga details failed the safety filter.");
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
      author,
      authors,
      genres,
      status: parseStatus(cleanText(rowHTML(rows, "statut", "status"))),
      language: "fr",
    };
    detailsCache.set(cacheKey, details);
    return details;
  }

  function rowHTML(rows, ...names) {
    for (const name of names) {
      const folded = fold(name);
      for (const [key, value] of rows) {
        if (key === folded || key.startsWith(`${folded} `)) return value;
      }
    }
    return "";
  }

  function seriesRefFromID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Scan-Manga identifier is invalid.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const ref = parseSeriesRef(raw);
      if (!ref) throw new Error("Scan-Manga identifier host or URL is not allowed.");
      return ref;
    }
    if (raw.includes("//")) throw new Error("Scan-Manga identifier host or URL is not allowed.");
    const shaped = raw.startsWith("/") ? `${BASE_URL}${raw}` : `${BASE_URL}/${raw}`;
    const ref = parseSeriesRef(shaped.endsWith(".html") ? shaped : `${shaped}.html`);
    if (!ref) {
      const direct = parseSeriesRef(shaped);
      if (!direct) throw new Error("Scan-Manga identifier is not a series path.");
      return direct;
    }
    return ref;
  }

  function chapterNumber(title) {
    const match = String(title || "").match(/chapitre\s*(\d+(?:[.,-]\d+)?)/i);
    if (!match) return null;
    const value = Number(match[1].replace(",", ".").replace(/-(\d+)$/, ".$1"));
    return Number.isFinite(value) ? value : null;
  }

  function parseChapterEntries(html, pageURL) {
    // Chapters render as li.chapitre rows: a named anchor plus a
    // "Lire en ligne" link. External reader mirrors are excluded: only
    // source-owned /lecture-en-ligne/ targets are kept.
    const entries = [];
    const seen = new Set();
    const pattern = /<li\b[^>]*class="[^"]*chapitre[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let row;
    while ((row = pattern.exec(String(html || ""))) !== null) {
      const body = row[1];
      const name = body.match(/<div\b[^>]*class="[^"]*chapitre_nom[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const scope = name ? name[1] : body;
      const link = scope.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const href = absoluteURL(link[1], pageURL);
      if (!href) continue;
      let pathname = "";
      try {
        pathname = new URL(href).pathname;
      } catch (_) {
        continue;
      }
      if (!/^\/lecture-en-ligne\/.+\.html$/.test(pathname)) continue;
      if (seen.has(href)) continue;
      const title = cleanText(link[2]);
      if (!title || hasUnsafeMarker(title)) continue;
      seen.add(href);
      entries.push({ href, title });
    }
    return entries;
  }

  function chapterID(href) {
    const url = new URL(href);
    return url.pathname.split("/").filter(Boolean).pop().replace(/\.html$/, "");
  }

  async function extractChapters(id) {
    const ref = seriesRefFromID(id);
    const cacheKey = ref.id.toLowerCase();
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    const html = await requestHTML(ref.href);
    // The series page carries its complete chapter list: every kept row is
    // returned oldest-first, never capped to a UI-sized window.
    const collected = parseChapterEntries(html, ref.href).map((entry) => ({
      id: chapterID(entry.href),
      href: entry.href,
      url: entry.href,
      title: entry.title,
      number: chapterNumber(entry.title),
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
    if (!raw) throw new Error("Scan-Manga chapter identifier is invalid.");
    let href = "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      href = absoluteURL(raw);
    } else if (!raw.includes("//")) {
      const shaped = raw.startsWith("/") ? raw : `/lecture-en-ligne/${raw}`;
      href = absoluteURL(shaped.endsWith(".html") ? shaped : `${shaped}.html`);
    }
    if (!href) throw new Error("Scan-Manga chapter identifier host or URL is not allowed.");
    let pathname = "";
    try {
      pathname = new URL(href).pathname;
    } catch (_) {
      throw new Error("Scan-Manga chapter identifier is invalid.");
    }
    if (!/^\/lecture-en-ligne\/.+\.html$/.test(pathname)) {
      throw new Error("Scan-Manga identifier is not a chapter path.");
    }
    // Reader URLs always carry a chapter marker (observed "-Chapitre-").
    if (!/chapitre/i.test(pathname)) {
      throw new Error("Scan-Manga identifier is not a chapter path.");
    }
    return href;
  }

  async function extractImages(id) {
    if (typeof globalThis.pagev2 !== "function") throw new Error("Scan-Manga requires the pagev2 bridge.");
    const pageURL = chapterRefFromID(id);
    const snapshot = await globalThis.pagev2({
      url: pageURL,
      headers: { ...DEFAULT_HEADERS },
      timeoutMilliseconds: 25000,
      settleMilliseconds: 2500,
      includeHTML: false,
      returnScript: "Array.from(document.querySelectorAll('#container img, .reader_view img')).map(function (image) { return image.currentSrc || image.src || ''; }).filter(Boolean).slice(0, 500)",
    });
    const raw = snapshot && snapshot.evaluatedData;
    const candidates = Array.isArray(raw) ? raw : [];
    // Only source-hosted page images are returned, in render order. Anything
    // else (empty snapshot, foreign hosts, challenges) fails instead of
    // inventing pages.
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
    if (images.length === 0) throw new Error("Scan-Manga returned no page images.");
    return images;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
