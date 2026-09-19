"use strict";

(() => {
  const BASE_URL = "https://noveldelaube.com";
  const CATALOGUE_PATH = "/notre_catalogue";
  const ORIGINALS_PATH = "/creations_originales";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_TEXT_BYTES = 1024 * 1024;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.~-]{0,120}$/;
  const CHAPTER_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.~%-]{0,160}$/;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  // Explicit sexual-content markers only (same doctrine as the NovelFrance
  // module): broad maturity/romance-subgenre tags are not blocked, the
  // module stays rated "suggestive", never "safe".
  const UNSAFE_MARKERS = [
    "18",
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
  const STATUS_MAP = { "terminé": "Completed", "en cours": "Ongoing", "en attente": "On hold" };
  const FEEDS = { catalogue: "Catalogue", originals: "Originals" };
  const FEED_PATHS = { catalogue: CATALOGUE_PATH, originals: ORIGINALS_PATH };
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
    const host = String(hostname || "").toLowerCase();
    return host === "noveldelaube.com" || host.endsWith(".noveldelaube.com");
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

  function novelURL(slug) {
    return `${BASE_URL}${CATALOGUE_PATH}/${slug}`;
  }

  function normalizeNovelSlug(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("NovelDeLAube identifier is invalid.");
    const input = value.trim();
    if (SLUG_PATTERN.test(input)) return input;
    let url;
    try {
      url = new URL(input, BASE_URL);
    } catch (_) {
      throw new Error("NovelDeLAube identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.hash) {
      throw new Error("NovelDeLAube identifier host or URL is not allowed.");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0 || !SLUG_PATTERN.test(segments[segments.length - 1])) {
      throw new Error("NovelDeLAube identifier is not a novel URL.");
    }
    return segments[segments.length - 1];
  }

  function novelPageURL(value) {
    const slug = normalizeNovelSlug(value);
    if (String(value).includes(ORIGINALS_PATH)) return `${BASE_URL}${ORIGINALS_PATH}/${slug}`;
    return novelURL(slug);
  }

  function normalizeChapterReference(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("NovelDeLAube chapter identifier is invalid.");
    let url;
    try {
      url = new URL(value.trim(), BASE_URL);
    } catch (_) {
      throw new Error("NovelDeLAube chapter identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.hash) {
      throw new Error("NovelDeLAube chapter host or URL is not allowed.");
    }
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch (_) {
        return segment;
      }
    });
    if (segments.length < 3 || segments[0] !== "notre_catalogue") {
      throw new Error("NovelDeLAube identifier is not a chapter URL.");
    }
    const novelSlug = segments[1];
    const chapterSlug = segments[segments.length - 1];
    if (!SLUG_PATTERN.test(novelSlug) || !CHAPTER_SLUG_PATTERN.test(chapterSlug)) {
      throw new Error("NovelDeLAube chapter identifier is invalid.");
    }
    return { novelSlug, chapterSlug, href: url.toString().split("#")[0] };
  }

  function isChallengePage(body) {
    return /(?:cf-chl-|cf-turnstile|challenge-platform|just a moment|access denied|verify you are human)/i
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
    if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelDeLAube requires the fetchv2 bridge.");
    const requestURL = absoluteURL(url);
    if (!requestURL) throw new Error("NovelDeLAube request URL is not public or host-confined.");
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURL,
          { ...DEFAULT_HEADERS },
          "GET",
          null,
          { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass: "html" },
        );
        const status = Number(response && response.status);
        if (!response || response.bodyDropped) throw new Error("NovelDeLAube response exceeded the module limit.");
        const finalURL = response.finalUrl || response.url;
        if (finalURL && !absoluteURL(finalURL)) {
          throw new Error("NovelDeLAube redirected to a non-public or unapproved host.");
        }
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`NovelDeLAube request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        const body = await responseBody(response);
        if (!body) throw new Error("NovelDeLAube returned an empty response.");
        if (isChallengePage(body)) throw new Error("NovelDeLAube returned a browser challenge.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|exceeded the module limit/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("NovelDeLAube request failed.");
  }

  function parseCatalogueList(html) {
    const items = [];
    const seen = new Set();
    const pattern = /\{"@type":"ListItem","position":\d+,"url":"((?:[^"\\]|\\.)*)","name":"((?:[^"\\]|\\.)*)"\}/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let rawURL = "";
      let rawName = "";
      try {
        rawURL = JSON.parse(`"${match[1]}"`);
        rawName = JSON.parse(`"${match[2]}"`);
      } catch (_) {
        continue;
      }
      const href = absoluteURL(rawURL);
      if (!href) continue;
      let slug = "";
      try {
        slug = normalizeNovelSlug(href);
      } catch (_) {
        continue;
      }
      const title = cleanText(rawName).replace(/^📕\s*/, "");
      if (!title || seen.has(slug)) continue;
      seen.add(slug);
      items.push({ slug, href, title });
    }
    return items;
  }

  function parseCards(html, pageURL) {
    // Catalogue cards observed live: <div class="card kado_project ...">
    // carrying the cover <img>, an <h3> title, labelled fields, and a
    // "voirplus-project" link. Cards are split on the container opener so
    // one malformed card can never poison its neighbours.
    const items = [];
    const seen = new Set();
    const segments = String(html || "").split('<div class="card kado_project');
    for (let index = 1; index < segments.length; index += 1) {
      const card = segments[index];
      const link = card.match(/<a[^>]*class="[^"]*voirplus-project[^"]*"[^>]*href="([^"]+)"[^>]*>/i)
        || card.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*voirplus-project[^"]*"[^>]*>/i);
      if (!link) continue;
      const href = absoluteURL(decodeEntities(link[1]).trim(), pageURL);
      if (!href) continue;
      let slug = "";
      try {
        slug = normalizeNovelSlug(href);
      } catch (_) {
        continue;
      }
      if (seen.has(slug)) continue;
      const title = cleanText((card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || "").replace(/^📕\s*/, "");
      if (!title) continue;
      const imageTag = card.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
      const image = imageTag ? absoluteURL(decodeEntities(imageTag[1]).trim(), pageURL) : "";
      const author = fieldValue(card, "Auteur") || fieldValue(card, "Artiste");
      const genreText = fieldValue(card, "Genre");
      const genres = genreText ? genreText.split(",").map((genre) => cleanText(genre)).filter(Boolean) : [];
      const rawStatus = fieldValue(card, "État du projet") || fieldValue(card, "Etat du projet");
      const entry = { slug, href, title, image, author, genres, status: rawStatus };
      const item = safeCatalogueItem(entry);
      if (!item) continue;
      seen.add(slug);
      items.push(item);
    }
    return items;
  }

  function safeCatalogueItem(entry) {
    if (!entry || typeof entry !== "object") return null;
    try {
      const title = cleanText(entry.title);
      if (!title) return null;
      const slug = normalizeNovelSlug(entry.slug);
      const href = absoluteURL(entry.href);
      if (!href) return null;
      // Explicit sexual markers are excluded everywhere, including title
      // and genre labels. Broad maturity/romance-subgenre tags (Ecchi,
      // Harem, Yuri, Mature, Romance, Fantasy, School Life) are mainstream
      // on this catalogue and never block a title on their own.
      const genres = Array.isArray(entry.genres)
        ? [...new Set(entry.genres.map((genre) => cleanText(genre)).filter(Boolean))]
        : [];
      if ([...genres, title].some(hasUnsafeMarker)) return null;
      const author = cleanText(entry.author);
      const rawStatus = cleanText(entry.status);
      const item = {
        id: slug,
        href,
        url: href,
        title,
        image: absoluteURL(entry.image) || "",
        author,
        authors: author ? [author] : [],
        genres,
        status: STATUS_MAP[rawStatus.toLowerCase()] || rawStatus,
        language: "fr",
      };
      return item;
    } catch (_) {
      return null;
    }
  }

  async function feedPage(feed, page = 1) {
    const requestedPage = Number(page);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
      throw new Error("NovelDeLAube discovery pagination page is invalid.");
    }
    if (!Object.prototype.hasOwnProperty.call(FEEDS, feed)) {
      throw new Error("NovelDeLAube discovery feed is unknown.");
    }
    // The catalogue lives on a single page; only page 1 carries items.
    if (requestedPage !== 1) return { items: [], hasMore: false };
    // Browsing must never crash the source screen: any fetch or parse
    // failure degrades to an empty list. Challenge, login and malformed
    // content on detail/chapter paths still fail closed elsewhere.
    try {
      const pageURL = `${BASE_URL}${FEED_PATHS[feed]}`;
      const html = await requestHTML(pageURL);
      const cards = parseCards(html, pageURL);
      if (cards.length > 0) return { items: cards, hasMore: false };
      const listed = parseCatalogueList(html)
        .map((listedEntry) => safeCatalogueItem({ ...listedEntry, image: "", genres: [] }))
        .filter(Boolean);
      return { items: listed, hasMore: false };
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
    const [catalogue, originals] = await Promise.all([safeFeed("catalogue", 1), safeFeed("originals", 1)]);
    return {
      sections: [
        { id: "catalogue", title: FEEDS.catalogue, items: catalogue.items },
        { id: "originals", title: FEEDS.originals, items: originals.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").trim().toLowerCase();
    return feedPage(feed, page);
  }

  async function searchResults(query, page = 1) {
    const text = String(query || "").trim();
    const requestedPage = Number(page);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
      throw new Error("NovelDeLAube search pagination page is invalid.");
    }
    if (!text || requestedPage !== 1) return { items: [], hasMore: false };
    // The site exposes no search endpoint: filter the full catalogue
    // client-side with an accent-insensitive substring match.
    const folded = fold(text);
    if (!folded) return { items: [], hasMore: false };
    const [catalogue, originals] = await Promise.all([safeFeed("catalogue", 1), safeFeed("originals", 1)]);
    const seen = new Set();
    const items = [];
    for (const item of [...catalogue.items, ...originals.items]) {
      if (seen.has(item.id) || !fold(item.title).includes(folded)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return { items, hasMore: false };
  }

  function fieldValue(html, label) {
    // Labels render as "Genre<!-- -->:" on novel pages and "Genre :" on
    // catalogue cards; both shapes are accepted.
    const pattern = new RegExp(
      `<div[^>]*>\\s*${label}\\s*(?:<!-- -->)?\\s*:</div>\\s*<div[^>]*>([\\s\\S]*?)</div>`,
      "i",
    );
    const match = String(html || "").match(pattern);
    return match ? cleanText(match[1]) : "";
  }

  function metaContent(html, attribute, name) {
    const tag = String(html || "").match(
      new RegExp(`<meta[^>]*${attribute}=["']${name}["'][^>]*>`, "i"),
    );
    if (!tag) return "";
    const content = tag[0].match(/content=(["'])((?:[^"'\\]|\\.)*)\1/i);
    return content ? decodeEntities(content[2]) : "";
  }

  function assertSafeGenres(genres, title) {
    if (!Array.isArray(genres) || genres.length === 0) {
      throw new Error("NovelDeLAube safety metadata is missing.");
    }
    const values = [...genres, title];
    if (values.some(hasUnsafeMarker)) throw new Error("NovelDeLAube title failed the safety filter.");
    return genres;
  }

  async function extractDetails(id) {
    const slug = normalizeNovelSlug(id);
    const cacheKey = slug.toLowerCase();
    if (detailsCache.has(cacheKey)) return detailsCache.get(cacheKey);
    const pageURL = novelPageURL(id);
    const html = await requestHTML(pageURL);
    const pageTitle = cleanText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "")
      .replace(/\s*[|-]\s*Novel de l'Aube.*$/i, "")
      .replace(/^📕\s*/, "");
    const title = pageTitle || cleanText(slug.replace(/_/g, " "));
    if (!title) throw new Error("NovelDeLAube title is empty after cleaning.");
    const author = fieldValue(html, "Auteur") || fieldValue(html, "Artiste");
    const genreText = fieldValue(html, "Genre");
    const genres = genreText ? genreText.split(",").map((genre) => cleanText(genre)).filter(Boolean) : [];
    assertSafeGenres(genres, title);
    const rawStatus = fieldValue(html, "État du projet") || fieldValue(html, "Etat du projet");
    const status = STATUS_MAP[rawStatus.toLowerCase()] || rawStatus;
    let description = "";
    const synopsis = html.match(/Synopsis<\/[^>]*>([\s\S]{0,4000}?)(?:<h[1-6][^>]*>|Présentation des personnages|Trailer)/i);
    if (synopsis) description = cleanText(synopsis[1]);
    if (!description) description = metaContent(html, "name", "description") || metaContent(html, "property", "og:description");
    let image = absoluteURL(metaContent(html, "property", "og:image"), pageURL);
    if (!image) {
      const projectImage = html.match(/<img[^>]*src="((?:\/images\/(?:projets|image_project)\/[^"]+)|https:\/\/[^"]+)"[^>]*>/i);
      if (projectImage) image = absoluteURL(decodeEntities(projectImage[1]), pageURL);
    }
    const href = absoluteURL(pageURL);
    const details = {
      id: slug,
      href,
      url: href,
      title,
      description,
      image,
      author,
      authors: author ? [author] : [],
      genres: [...new Set(genres)],
      status,
      language: "fr",
    };
    detailsCache.set(cacheKey, details);
    return details;
  }

  function parseTomeChapters(html, pageURL) {
    const segments = [];
    const heading = /Tome\s+(\d+)\s*-\s*([^<]{1,200})</gi;
    let match;
    let lastIndex = 0;
    let currentTome = null;
    const flush = (end) => {
      segments.push({ tome: currentTome, html: String(html).slice(lastIndex, end) });
    };
    while ((match = heading.exec(html)) !== null) {
      flush(match.index);
      currentTome = { number: Number(match[1]), title: cleanText(match[2]) };
      lastIndex = match.index + match[0].length;
    }
    flush(html.length);
    const chapters = [];
    for (const segment of segments) {
      const anchor = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let link;
      while ((link = anchor.exec(segment.html)) !== null) {
        const href = absoluteURL(decodeEntities(link[1]).trim(), pageURL);
        if (!href) continue;
        let ref = null;
        try {
          ref = normalizeChapterReference(href);
        } catch (_) {
          continue;
        }
        if (ref.chapterSlug.toLowerCase() === "illustrations") continue;
        const title = cleanText(link[2]);
        if (!title) continue;
        chapters.push({ ref, title, tome: segment.tome });
      }
    }
    return chapters;
  }

  async function extractChapters(id) {
    const slug = normalizeNovelSlug(id);
    const cacheKey = slug.toLowerCase();
    if (chaptersCache.has(cacheKey)) return chaptersCache.get(cacheKey);
    const pageURL = novelPageURL(id);
    await extractDetails(id);
    const html = await requestHTML(pageURL);
    const parsed = parseTomeChapters(html, pageURL);
    if (parsed.length === 0) throw new Error("NovelDeLAube returned no chapter list.");
    const seen = new Set();
    const output = [];
    let number = 0;
    for (const chapter of parsed) {
      if (seen.has(chapter.ref.href)) continue;
      seen.add(chapter.ref.href);
      number += 1;
      output.push({
        id: chapter.ref.href,
        href: chapter.ref.href,
        url: chapter.ref.href,
        number,
        title: chapter.tome && chapter.tome.title
          ? `Tome ${chapter.tome.number} - ${chapter.title}`
          : chapter.title,
        language: "fr",
      });
    }
    chaptersCache.set(cacheKey, output);
    return output;
  }

  function unescapeFlightPayload(payload) {
    try {
      return JSON.parse(`"${payload}"`);
    } catch (_) {
      return payload.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }

  function flightParagraphs(html) {
    let stream = "";
    for (const match of String(html || "").matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
      stream += `${unescapeFlightPayload(match[1])}\n`;
    }
    const found = [];
    const pattern = /\["\$","p",null,\{"children":("(?:[^"\\]|\\.)*"|\[(?:[^\[\]]|\[[^\[\]]*\])*\])\}/g;
    let match;
    while ((match = pattern.exec(stream)) !== null) {
      const raw = match[1];
      if (raw.startsWith('"')) {
        try {
          found.push({ index: match.index, text: JSON.parse(raw) });
        } catch (_) {
          continue;
        }
      } else {
        const parts = [];
        for (const text of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
          if (["$", "p", "br", "u", "i", "b", "em", "strong", "span"].includes(text[1])) continue;
          if (/^\$/.test(text[1])) continue;
          try {
            parts.push(JSON.parse(`"${text[1]}"`));
          } catch (_) {
            continue;
          }
        }
        const text = cleanText(parts.join(" "));
        if (text) found.push({ index: match.index, text });
      }
    }
    return found.map((entry) => ({ ...entry, text: cleanText(entry.text) })).filter((entry) => entry.text);
  }

  function longestRun(paragraphs, maxGap) {
    let best = [];
    let current = [];
    let lastIndex = -Infinity;
    for (const paragraph of paragraphs) {
      if (paragraph.index - lastIndex > maxGap) {
        if (current.length > best.length) best = current;
        current = [];
      }
      current.push(paragraph.text);
      lastIndex = paragraph.index;
    }
    if (current.length > best.length) best = current;
    return best;
  }

  async function extractText(reference) {
    const ref = normalizeChapterReference(reference);
    await extractDetails(ref.novelSlug);
    const html = await requestHTML(ref.href);
    if (!html.includes(ref.chapterSlug)) throw new Error("NovelDeLAube returned mismatched chapter content.");
    const paragraphs = longestRun(flightParagraphs(html), 2000);
    if (paragraphs.length < 3) throw new Error("NovelDeLAube chapter text is unavailable.");
    const boilerplate = /^(cette page n'existe pas\.?|copyright ©|aurora fantrad|tous droits réservés)/i;
    const content = paragraphs.filter((text) => !boilerplate.test(text)).join("\n\n").trim();
    if (!content) throw new Error("NovelDeLAube chapter text was empty.");
    if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) {
      throw new Error("NovelDeLAube chapter text exceeds the app size limit.");
    }
    return content;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractText, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
