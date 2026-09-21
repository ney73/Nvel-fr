"use strict";

// Sushi Scan (https://sushiscan.net) — French manga scan reader module.
//
// CURRENT STATUS: PARTIAL. Live access is blocked by a Cloudflare browser
// challenge ("Just a moment...", HTTP 403 on every endpoint, observed
// 2026-09-21). This module therefore implements the full contract shape with
// strict fail-closed behavior: browse/search degrade to empty lists, and
// details/chapters/images reject challenge, login, error, empty and
// malformed responses. NO listing, series, chapter or image selectors are
// included because no readable page structure has been observed — adding
// them without observation would be fabrication. When readable HTML is
// observed, selectors can be added behind a minor version bump.
(() => {
  const BASE_URL = "https://sushiscan.net";
  const SEARCH_URL = `${BASE_URL}/search`;
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  const FEEDS = { browse: "Catalogue" };

  function resolveFeed(feedID) {
    // Feed names are routing hints: an unknown name resolves to the catalogue
    // feed instead of an empty screen.
    const feed = String(feedID || "").trim().toLowerCase();
    if (feed === "catalogue" || feed === "all" || feed === "latest" || feed === "popular") return "browse";
    if (Object.prototype.hasOwnProperty.call(FEEDS, feed)) return feed;
    return "browse";
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else resolve();
    });
  }

  function allowedHost(hostname) {
    // Only the observed site host. Image CDNs stay rejected until observed.
    return String(hostname || "").toLowerCase() === "sushiscan.net";
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

  function normalizeSeriesURL(value) {
    // Series and chapter identities are source-owned HTTPS URLs. Bare slugs
    // are rejected: the site's URL scheme has not been observed, so the
    // module never guesses paths.
    if (typeof value !== "string" || !value.trim()) throw new Error("Sushi Scan identifier is invalid.");
    let url;
    try {
      url = new URL(value.trim(), BASE_URL);
    } catch (_) {
      throw new Error("Sushi Scan identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.hash) {
      throw new Error("Sushi Scan identifier host or URL is not allowed.");
    }
    if (url.pathname === "/" || !url.pathname || url.pathname === "/search") {
      throw new Error("Sushi Scan identifier is not a series URL.");
    }
    url.hash = "";
    return url.toString();
  }

  function isChallengePage(body) {
    // "Just a moment..." is the observed Cloudflare challenge title.
    return /(?:cf-chl-|cf-turnstile|challenge-platform|just a moment|access denied|verify you are human)/i
      .test(String(body || "").slice(0, 65536));
  }

  function isLoginPage(body) {
    return /(?:log\s*in|se\s*connecter|mot\s*de\s*passe|sign\s*in)[\s\S]{0,200}(?:password|connexion|login)/i
      .test(String(body || "").slice(0, 65536));
  }

  async function responseBody(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string" && body) return body;
    }
    if (typeof response.body === "string") return response.body;
    return "";
  }

  async function requestHTML(url) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Sushi Scan requires the fetchv2 bridge.");
    const requestURLValue = absoluteURL(url);
    if (!requestURLValue) throw new Error("Sushi Scan request URL is not public or host-confined.");
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURLValue,
          { ...DEFAULT_HEADERS },
          "GET",
          null,
          { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass: "html" },
        );
        const status = Number(response && response.status);
        if (!response || response.bodyDropped) throw new Error("Sushi Scan response exceeded the module limit.");
        const finalURL = response.finalUrl || response.url;
        if (finalURL && !absoluteURL(finalURL)) {
          throw new Error("Sushi Scan redirected to a non-public or unapproved host.");
        }
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`Sushi Scan request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        const body = await responseBody(response);
        if (!body) throw new Error("Sushi Scan returned an empty response.");
        if (isChallengePage(body)) throw new Error("Sushi Scan returned a browser challenge.");
        if (isLoginPage(body)) throw new Error("Sushi Scan requires login.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|requires login|exceeded the module limit|not public/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("Sushi Scan request failed.");
  }

  async function safeFeed(feed, page) {
    try {
      return await feedPage(feed, page);
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function feedPage(feed, page = 1) {
    // Page numbers are coerced, never rejected: some clients paginate from
    // zero and a crash here would take down the whole Discover screen.
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!Object.prototype.hasOwnProperty.call(FEEDS, feed)) {
      throw new Error("Sushi Scan discovery feed is unknown.");
    }
    if (requestedPage !== 1) return { items: [], hasMore: false };
    // No catalogue selectors observed (challenge only): degrade to empty.
    try {
      await requestHTML(BASE_URL);
      return { items: [], hasMore: false };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function discoveryHome() {
    try {
      const catalogue = await safeFeed("browse", 1);
      return {
        sections: [
          { id: "browse", title: FEEDS.browse, items: catalogue.items },
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
    // No search-result selectors observed (challenge only): degrade to empty.
    try {
      await requestHTML(`${SEARCH_URL}?q=${encodeURIComponent(text.trim())}`);
      return { items: [], hasMore: false };
    } catch (_) {
      return { items: [], hasMore: false };
    }
  }

  async function extractDetails(id) {
    const pageURL = normalizeSeriesURL(id);
    const html = await requestHTML(pageURL);
    // No series-page selectors observed: any readable page without a known
    // structure is rejected instead of guessed.
    void html;
    throw new Error("Sushi Scan series structure is not supported yet.");
  }

  async function extractChapters(id) {
    const pageURL = normalizeSeriesURL(id);
    const html = await requestHTML(pageURL);
    void html;
    throw new Error("Sushi Scan chapter list is not supported yet.");
  }

  async function extractImages(chapterID) {
    const pageURL = normalizeSeriesURL(chapterID);
    const html = await requestHTML(pageURL);
    void html;
    throw new Error("Sushi Scan page images are not supported yet.");
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
    discoveryHome,
    discoveryFeed,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
