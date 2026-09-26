"use strict";

// JGarden (https://j-garden.fr) — French fan-translation team (manga / light
// novels, active since 2008). WordPress + Elementor catalogue: the listing
// pages (/jg-manga/, /jg-ln/, ...) expose series banners, /actualites/ exposes
// release posts, and the WordPress search (/?s=...) mixes both. Series pages
// describe each project (author, genres, volume count) and list compiled
// "Volume N" entries with the team's own download buttons.
//
// Download buttons point at third-party ad-gated shorteners (observed:
// clictune.com / dlink5.com answer "Please wait 10 seconds before viewing the
// link"). Those gates are never bypassed here, so extractResources only
// returns direct, ungated HTTPS .epub/.pdf files served on the observed
// source host. When a series offers gated links only, resources is honestly
// empty instead of a broken download.
(() => {
  const BASE_URL = "https://j-garden.fr";
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_DESCRIPTION_CHARS = 1500;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only (same doctrine as the sibling
  // fan-translation modules): mainstream maturity/romance sub-genre labels
  // never block a title on their own, so the module stays rated "suggestive".
  // Bare age-rating tokens such as "18" are deliberately absent: volume titles
  // contain chapter ranges and must never be filtered.
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
    ["pause", "On hold"],
    ["abandonn", "Dropped"],
  ];
  // Catalogue feeds observed in the site navigation. Unknown feed names fall
  // back to the ongoing manga catalogue instead of an empty Browse screen.
  const FEEDS = {
    manga: { title: "JG Manga", path: "/jg-manga/" },
    completed: { title: "Séries terminées", path: "/series-en-terminees/" },
    paused: { title: "Séries en pause", path: "/series-en-pause/" },
    dropped: { title: "Séries abandonnées", path: "/series-abandonnees/" },
    ln: { title: "JG LN", path: "/jg-ln/" },
    webnovel: { title: "JG Web Novel", path: "/jg-web-novel/" },
    autres: { title: "Autres LNs", path: "/jg-autres-lns/" },
    news: { title: "Actualités", path: "/actualites/" },
  };
  const DEFAULT_FEED = "manga";
  // Listing pages, static pages and endpoints: never catalogue items, never
  // series identities.
  const NON_SERIES_PATHS = new Set([
    "", "jg-manga", "jg-ln", "jg-web-novel", "jg-autres-lns", "actualites",
    "series-en-terminees", "series-en-pause", "series-en-abandonnees",
    "a-propos", "recrutement", "faq-jgarden",
  ]);
  const DESCRIPTOR_LABEL = new RegExp(
    "^(?:\\u{1F464}|\\u{1F4D6}|\\u{1F3AD}|\\u{1F9E0}|\\u{1F4FA}"
    + "|auteur|artiste|genres?|th\\u00E8mes?|themes?"
    + "|nombre de|traducteur|adaptation|lire en ligne|cliquez sur la couverture"
    + "|copyright)",
    "iu",
  );

  function permanent(message) {
    const error = new Error(message);
    error.jgardenPermanent = true;
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
    // Smallest observed allowlist: every catalogue, search, series and
    // (ungated) download URL seen on this source stays on the apex host.
    // Ad-gated shorteners are deliberately excluded: their timer pages are
    // never fetched nor returned as downloads.
    return String(hostname || "").toLowerCase() === "j-garden.fr";
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

  function normalizeSeriesID(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("JGarden identifier is invalid.");
    let pathname = raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      let url;
      try {
        url = new URL(raw);
      } catch (_) {
        throw new Error("JGarden identifier is invalid.");
      }
      if (url.protocol !== "https:" || !allowedHost(url.hostname)) {
        throw new Error("JGarden identifier host or URL is not allowed.");
      }
      pathname = url.pathname;
    } else if (raw.includes("//") || raw.includes("?") || raw.includes("#")) {
      throw new Error("JGarden identifier host or URL is not allowed.");
    }
    const segments = pathname.split("/").filter(Boolean);
    // Series and release posts live at single-segment site paths
    // ("/the-isekai-doctor/"). Listing, feed and endpoint paths are rejected.
    if (segments.length !== 1) throw new Error("JGarden identifier is not a series path.");
    const slug = segments[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,120}$/.test(slug)) {
      throw new Error("JGarden identifier is invalid.");
    }
    if (/^wp-/i.test(slug) || /^(feed|comments|page)$/i.test(slug)) {
      throw new Error("JGarden identifier points at a non-public endpoint.");
    }
    if (NON_SERIES_PATHS.has(slug.toLowerCase())) {
      throw new Error("JGarden identifier is a listing page, not a series.");
    }
    return slug;
  }

  function itemURL(id) {
    return `${BASE_URL}/${normalizeSeriesID(id)}/`;
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
    if (typeof globalThis.fetchv2 !== "function") throw new Error("JGarden requires the fetchv2 bridge.");
    const requestURL = absoluteURL(url);
    if (!requestURL) throw permanent("JGarden request URL is not public or host-confined.");
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
        if (!response) throw permanent("JGarden returned no response.");
        if (response.bodyDropped) throw permanent("JGarden response exceeded the module limit.");
        const status = Number(response.status) || 0;
        const finalURL = typeof response.finalUrl === "string" ? response.finalUrl : "";
        if (finalURL && !isReservedPlaceholderURL(finalURL) && !absoluteURL(finalURL)) {
          throw permanent("JGarden redirected to a non-public or unapproved host.");
        }
        if (status && (status < 200 || status >= 300)) {
          const message = `JGarden request failed with HTTP ${status}.`;
          if (RETRYABLE_STATUS.has(status)) {
            lastError = new Error(message);
            continue;
          }
          throw permanent(message);
        }
        const headerType = response.headers && (response.headers["content-type"] || response.headers["Content-Type"]);
        const contentType = String(response.contentType || headerType || "").toLowerCase();
        if (contentType && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
          throw permanent("JGarden returned a non-HTML response.");
        }
        const body = await responseBody(response);
        if (!body) throw permanent("JGarden returned an empty response.");
        if (isChallengePage(body)) throw permanent("JGarden returned a browser challenge.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.jgardenPermanent) throw lastError;
        if (attempt >= 2) throw lastError;
      }
    }
    throw lastError || new Error("JGarden request failed.");
  }

  function metaContent(html, attribute, name) {
    const tag = String(html || "").match(
      new RegExp(`<meta[^>]*${attribute}=["']${name}["'][^>]*>`, "i"),
    );
    if (!tag) return "";
    const content = tag[0].match(/content=(["'])((?:[^"'\\]|\\.)*)\1/i);
    return content ? decodeEntities(content[2]) : "";
  }

  function contentRegion(html) {
    const text = String(html || "");
    const opener = /<div[^>]*data-elementor-type="wp-(?:post|page)"/i.exec(text);
    let start = opener ? opener.index : -1;
    if (start < 0) {
      const headerEnd = text.indexOf("</header>");
      start = headerEnd >= 0 ? headerEnd + 9 : 0;
    }
    let end = text.indexOf("<footer", start);
    if (end < 0) {
      const mainEnd = text.indexOf("</main>", start);
      end = mainEnd >= 0 ? mainEnd : text.length;
    }
    if (end <= start) end = text.length;
    return text.slice(start, end);
  }

  function regionParagraphs(region) {
    const output = [];
    const pattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = pattern.exec(String(region || ""))) !== null) {
      const text = cleanText(match[1]);
      if (text) output.push(text);
    }
    return output;
  }

  function humanizeSlug(slug) {
    return String(slug || "")
      .replace(/[_~.]+/g, " ")
      .replace(/-+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  }

  function slugOf(href) {
    try {
      const url = new URL(href);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) return "";
      return segments[0];
    } catch (_) {
      return "";
    }
  }

  function safeItem(entry) {
    if (!entry || typeof entry !== "object") return null;
    try {
      const href = absoluteURL(entry.href);
      if (!href) return null;
      const slug = slugOf(href);
      if (!slug) return null;
      const id = normalizeSeriesID(href);
      let title = cleanText(entry.title);
      if (!title) title = humanizeSlug(slug);
      if (!title || hasUnsafeMarker(title)) return null;
      const image = absoluteURL(entry.image) || "";
      if (image && !/\/(wp-content|wp-includes)\//i.test(image)) return null;
      return {
        id,
        href,
        url: href,
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

  function parseBannerItems(html, pageURL) {
    // Elementor catalogue pages render series banners as
    // <a href="/series-slug/"><img ...></a> image widgets. Banner images
    // carry no usable alt text live, so the slug doubles as title source.
    const items = [];
    const seen = new Set();
    const region = contentRegion(html);
    const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>\s*<img\b([^>]*)>/gi;
    let match;
    while ((match = pattern.exec(region)) !== null) {
      const href = absoluteURL(match[1], pageURL);
      if (!href) continue;
      const imageTag = match[0].match(/<img\b[^>]*>/i)[0];
      const alt = (imageTag.match(/\salt=(["'])(.*?)\1/i) || [])[2] || "";
      const source = imageTag.match(/\ssrc=(["'])(.*?)\1/i);
      const item = safeItem({ title: alt, href, image: source ? source[2] : "" });
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  function parsePostCards(html, pageURL) {
    // Elementor release grids render <article class="elementor-post ...">
    // with an h3.elementor-post__title link and a thumbnail.
    const items = [];
    const seen = new Set();
    const blocks = String(html || "").split("<article");
    for (let index = 1; index < blocks.length; index += 1) {
      const block = blocks[index];
      const link = block.match(/<h[1-4][^>]*class="[^"]*elementor-post__title[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const href = absoluteURL(link[1], pageURL);
      if (!href) continue;
      const imageTag = block.match(/<img\b[^>]*>/i);
      let image = "";
      if (imageTag) {
        const source = imageTag[0].match(/\ssrc=(["'])(.*?)\1/i);
        if (source) image = source[2];
      }
      const item = safeItem({ title: link[2], href, image });
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  function parseSearchArticles(html, pageURL) {
    // WordPress search archives render <article class="post"> with an
    // h2.entry-title link and a cover image.
    const items = [];
    const seen = new Set();
    const blocks = String(html || "").split("<article");
    for (let index = 1; index < blocks.length; index += 1) {
      const block = blocks[index];
      const link = block.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const href = absoluteURL(link[1], pageURL);
      if (!href) continue;
      const imageTag = block.match(/<img\b[^>]*>/i);
      let image = "";
      if (imageTag) {
        const source = imageTag[0].match(/\ssrc=(["'])(.*?)\1/i);
        if (source) image = source[2];
      }
      const item = safeItem({ title: link[2], href, image });
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  function mergeItems(lists) {
    const seen = new Set();
    const items = [];
    for (const list of lists) {
      for (const item of list) {
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items;
  }

  function hasNextPageLink(html) {
    const text = String(html || "");
    if (/<link[^>]+rel=(["'])next\1/i.test(text)) return true;
    if (/<div class="nav-next">\s*<a\b/i.test(text)) return true;
    if (/<a\b[^>]*class="[^"]*page-numbers next[^"]*"[^>]*href=/i.test(text)) return true;
    return false;
  }

  function searchURL(query, page) {
    const encoded = encodeURIComponent(query);
    if (page <= 1) return `${BASE_URL}/?s=${encoded}`;
    return `${BASE_URL}/page/${page}/?s=${encoded}`;
  }

  function feedURL(feed, page) {
    const base = `${BASE_URL}${feed.path}`;
    if (page <= 1) return base;
    return `${base}page/${page}/`;
  }

  function resolveFeed(feedID) {
    const key = String(feedID || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FEEDS, key)) return FEEDS[key];
    if (key === "latest" || key === "all" || key === "home" || key === "catalogue") return FEEDS[DEFAULT_FEED];
    return FEEDS[DEFAULT_FEED];
  }

  async function safeFeed(feed, page) {
    try {
      const requestedPage = Math.max(1, Number(page) || 1);
      const pageURL = feedURL(feed, requestedPage);
      const html = await requestHTML(pageURL);
      const items = mergeItems([parseBannerItems(html, pageURL), parsePostCards(html, pageURL)]);
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
      const pageURL = `${BASE_URL}/`;
      const html = await requestHTML(pageURL);
      const items = mergeItems([parseBannerItems(html, pageURL), parsePostCards(html, pageURL)]);
      if (items.length === 0) return { sections: [] };
      return { sections: [{ id: "catalogue", title: "Catalogue", items }] };
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
      const items = mergeItems([parseSearchArticles(html, pageURL), parsePostCards(html, pageURL)]);
      return { items, hasMore: items.length > 0 && hasNextPageLink(html) };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  function pageTitle(html) {
    const text = String(html || "");
    const candidates = [
      text.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i),
      text.match(/<h1[^>]*class="[^"]*elementor-heading-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i),
      text.match(/<title>([\s\S]*?)<\/title>/i),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const title = cleanText(candidate[1])
        .replace(/\s*[|\u2013\u2014-]+\s*JGarden.*$/i, "")
        .trim();
      if (title) return title;
    }
    return "";
  }

  function coverImage(html, pageURL) {
    const text = String(html || "");
    const fromMeta = absoluteURL(metaContent(text, "property", "og:image"), pageURL)
      || absoluteURL(metaContent(text, "name", "twitter:image"), pageURL);
    if (fromMeta) return fromMeta;
    const region = contentRegion(text);
    const featured = region.match(/<img[^>]*class="[^"]*wp-post-image[^"]*"[^>]*>/i)
      || region.match(/<img[^>]*\/wp-content\/uploads\/[^>]*>/i);
    if (!featured) return "";
    const source = featured[0].match(/\ssrc=(["'])(.*?)\1/i);
    return source ? absoluteURL(source[2], pageURL) : "";
  }

  function labelledValue(html, labelPattern) {
    // Series pages render one labelled line per paragraph ("Auteur : ...",
    // "Genres : ..."), the label optionally prefixed by an emoji. Matching
    // runs on the cleaned paragraph text, never on raw markup.
    const pattern = new RegExp(`${labelPattern}\\s*:\\s*([\\s\\S]+)$`, "iu");
    for (const paragraph of regionParagraphs(contentRegion(html))) {
      const match = paragraph.match(pattern);
      if (!match) continue;
      const value = match[1].replace(/^[^\p{L}\p{N}]+/u, "").trim();
      if (value) return value;
    }
    return "";
  }

  function splitTags(value) {
    return [...new Set(
      String(value || "")
        .split(/\s*(?:\u2013|\u2014|,|\/|;|\s-\s)\s*/)
        .map((tag) => cleanText(tag))
        .filter(Boolean),
    )];
  }

  function parseStatus(html) {
    const value = labelledValue(html, "Nombre de\\s+volumes?");
    if (!value) return "";
    const normalized = fold(value);
    for (const [marker, status] of STATUS_RULES) {
      if (normalized.includes(marker)) return status;
    }
    return "";
  }

  function pageDescription(html) {
    const paragraphs = regionParagraphs(contentRegion(html))
      .filter((text) => !DESCRIPTOR_LABEL.test(text))
      .filter((text) => !/^(?:lire la suite|charger plus|lire en ligne)/i.test(text))
      .filter((text) => text.replace(/\s/g, "").length >= 24);
    let joined = paragraphs.join("\n\n").trim();
    if (!joined) {
      joined = cleanText(metaContent(html, "name", "description"))
        || cleanText(metaContent(html, "property", "og:description"));
    }
    if (joined.length > MAX_DESCRIPTION_CHARS) joined = `${joined.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`;
    return joined;
  }

  const detailsCache = new Map();
  const chaptersCache = new Map();

  async function extractDetails(id) {
    const slug = normalizeSeriesID(id);
    const cacheKey = slug.toLowerCase();
    if (detailsCache.has(cacheKey)) return detailsCache.get(cacheKey);
    const pageURL = itemURL(slug);
    const html = await requestHTML(pageURL);
    const title = pageTitle(html);
    if (!title) throw new Error("JGarden title is empty after cleaning.");
    if (hasUnsafeMarker(title)) throw new Error("JGarden title failed the safety filter.");
    const author = labelledValue(html, "Auteur");
    const genres = [...new Set([
      ...splitTags(labelledValue(html, "Genr(?:e|es)")),
      ...splitTags(labelledValue(html, "Th(?:e|\u00E8)mes?")),
    ])];
    if (genres.some((genre) => hasUnsafeMarker(genre))) {
      throw new Error("JGarden details failed the safety filter.");
    }
    const image = coverImage(html, pageURL);
    const details = {
      id: slug,
      href: pageURL,
      url: pageURL,
      title,
      description: pageDescription(html),
      image,
      cover: image,
      coverUrl: image,
      author,
      authors: author ? [author] : [],
      genres,
      status: parseStatus(html),
      language: "fr",
    };
    detailsCache.set(cacheKey, details);
    return details;
  }

  function parseVolumes(html, pageURL) {
    // Compiled volumes render as a cover link followed by a "Volume N"
    // (sometimes "Tome N") label. Volumes without a download button yet keep
    // a bare label. Every entry is kept: the volume list is the complete
    // reading order, never a UI-sized window.
    const region = contentRegion(html);
    const found = new Map();
    const absorb = (number, href) => {
      if (!Number.isInteger(number) || number < 0 || number > 100000) return;
      const existing = found.get(number);
      if (!existing) {
        found.set(number, { number, href: href || "" });
      } else if (!existing.href && href) {
        found.set(number, { number, href });
      }
    };
    const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let anchor;
    while ((anchor = anchorPattern.exec(region)) !== null) {
      const href = absoluteURL(anchor[1], pageURL);
      const inner = cleanText(anchor[2]);
      let label = (inner.match(/(?:volume|tome)\s*(\d{1,5})/i) || [])[1];
      if (!label) {
        const ahead = cleanText(region.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + 400));
        label = (ahead.match(/^(?:volume|tome)\s*(\d{1,5})/i) || [])[1];
      }
      if (label !== undefined && label !== null && label !== "") absorb(Number(label), href);
    }
    const barePattern = /(?:volume|tome)\s*(\d{1,5})/gi;
    let bare;
    while ((bare = barePattern.exec(regionParagraphs(region).join("\n"))) !== null) {
      absorb(Number(bare[1]), "");
    }
    return [...found.values()].sort((a, b) => a.number - b.number);
  }

  async function extractChapters(id) {
    const slug = normalizeSeriesID(id);
    const cacheKey = slug.toLowerCase();
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    const pageURL = itemURL(slug);
    const html = await requestHTML(pageURL);
    // Release posts carry no volume list: they expose no chapters instead of
    // inventing any.
    const chapters = parseVolumes(html, pageURL).map((volume) => ({
      id: `${slug}#volume-${volume.number}`,
      href: pageURL,
      url: pageURL,
      title: `Volume ${volume.number}`,
      number: volume.number,
    }));
    chaptersCache.set(cacheKey, chapters);
    return chapters;
  }

  async function extractResources(id) {
    const slug = normalizeSeriesID(id);
    const pageURL = itemURL(slug);
    const details = await extractDetails(id);
    const html = await requestHTML(pageURL);
    // Only direct, ungated EPUB/PDF files on the source host are returned.
    // Third-party ad-gated shorteners (timer pages) are excluded: their gates
    // must not be bypassed and their pages are not downloads.
    const resources = [];
    const seen = new Set();
    for (const volume of parseVolumes(html, pageURL)) {
      if (!volume.href || seen.has(volume.href)) continue;
      let pathname = "";
      try {
        pathname = new URL(volume.href).pathname;
      } catch (_) {
        continue;
      }
      const extension = (pathname.match(/\.([A-Za-z0-9]+)$/) || [])[1] || "";
      const format = extension.toLowerCase();
      if (format !== "pdf" && format !== "epub") continue;
      seen.add(volume.href);
      resources.push({
        format,
        url: volume.href,
        fileName: `${details.title} - Volume ${volume.number}.${format}`,
        headers: { Referer: pageURL },
      });
    }
    return resources;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractResources, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
