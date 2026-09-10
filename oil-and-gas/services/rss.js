/**
 * RSS feed service.
 *
 * Primary:  rss2json.com (free tier, 10 req/hr without key, cleaner JSON response)
 * Fallback: allorigins.win raw proxy + browser-native DOMParser
 *
 * The DOMParser path handles both RSS 2.0 and Atom 1.0 feeds and correctly
 * resolves namespaced attributes (media:content, media:thumbnail, dc:date)
 * via getElementsByTagNameNS — something a simple getElementsByTagName('media:x')
 * call silently misses in all browsers.
 *
 * Rate limit note:
 *   rss2json free tier = 10 requests/hour per IP.
 *   With 4+ feeds, stagger requests and cache results in memory for 30 minutes.
 */

const RSS2JSON = 'https://api.rss2json.com/v1/api.json';
const ALLORIGINS = 'https://api.allorigins.win/raw?url=';

// In-memory cache: feedUrl → { timestamp: ms, items: [] }
const feedCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const FETCH_TIMEOUT_MS = 10_000; // abort proxy requests after 10 s

/** fetch() wrapper that aborts after FETCH_TIMEOUT_MS */
function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Thrown when the upstream feed host itself blocks the request (4xx).
 * Signals that retrying via a different proxy won't help.
 */
class FeedBlockedError extends Error {
  constructor(status) {
    super(`Feed blocked by source (HTTP ${status}) — the feed host is rejecting proxy requests`);
    this.name = 'FeedBlockedError';
  }
}

/**
 * Fetch a single RSS feed and return a normalized array of article objects.
 * Each item: { title, link, pubDate: ISO string, description, image, source }
 * `image` is a URL string, or null when the feed doesn't provide one — most
 * feeds (OilPrice.com, Rigzone, EIA) don't include article images at all.
 *
 * @param {string} feedUrl    RSS feed URL
 * @param {string} sourceName Human-readable source label
 * @param {string} proxy      'rss2json' | 'allorigins'
 */
export async function fetchFeed(feedUrl, sourceName, proxy = 'rss2json') {
  const cacheKey = feedUrl;
  const cached = feedCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.items;
  }

  let items = [];
  if (proxy === 'rss2json') {
    items = await fetchViaRss2Json(feedUrl, sourceName);
  } else {
    items = await fetchViaAllorigins(feedUrl, sourceName);
  }

  feedCache.set(cacheKey, { timestamp: Date.now(), items });
  return items;
}

async function fetchViaRss2Json(feedUrl, sourceName) {
  // No `count` param: rss2json's free tier now rejects it outright (422,
  // "you need a valid api key"). The default (~10 items) is fine here.
  const url = `${RSS2JSON}?rss_url=${encodeURIComponent(feedUrl)}`;
  try {
    const res = await fetchWithTimeout(url, { cache: 'no-store' });
    // rss2json returns a non-2xx status for its own errors (invalid feed,
    // upstream fetch failure, etc.), not a 200 with status:"error" — so the
    // fallback below must cover both cases, not just a parsed error body.
    if (!res.ok) throw new Error(`rss2json HTTP ${res.status}`);
    const json = await res.json();
    // rss2json reports upstream 403/blocked as status:"error" with a message
    // containing the status code — detect and surface as FeedBlockedError so
    // the allorigins fallback is skipped (it will also fail).
    if (json.status !== 'ok') {
      if (/40[13]|block|forbid|denied/i.test(json.message ?? '')) {
        throw new FeedBlockedError(json.message);
      }
      throw new Error(json.message || 'rss2json returned an error');
    }
    return (json.items ?? []).map(item => ({
      title: item.title ?? '',
      link: item.link ?? '',
      pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : '',
      description: stripHtml(item.description ?? '').slice(0, 200),
      image: (item.thumbnail && item.thumbnail.trim())
        || (item.enclosure?.type?.startsWith('image') ? item.enclosure.link : null)
        || extractImageFromHtml(item.content || item.description)
        || null,
      source: sourceName,
    }));
  } catch (err) {
    // Don't fall back if the feed host itself is blocking — allorigins will
    // fail too, just more slowly.
    if (err instanceof FeedBlockedError) throw err;
    // Fallback to allorigins on any other rss2json failure
    return fetchViaAllorigins(feedUrl, sourceName);
  }
}

// Well-known XML namespace URIs used in RSS/Atom feeds
const NS = {
  media:   'http://search.yahoo.com/mrss/',
  dc:      'http://purl.org/dc/elements/1.1/',
  content: 'http://purl.org/rss/1.0/modules/content/',
  atom:    'http://www.w3.org/2005/Atom',
};

async function fetchViaAllorigins(feedUrl, sourceName) {
  const url = `${ALLORIGINS}${encodeURIComponent(feedUrl)}`;
  const res = await fetchWithTimeout(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) throw new FeedBlockedError(res.status);
    throw new Error(`allorigins HTTP ${res.status}`);
  }
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  // Detect parse error (browser returns a <parsererror> document)
  if (doc.querySelector('parsererror')) {
    throw new Error('Feed XML could not be parsed');
  }

  // Support both RSS 2.0 (<item>) and Atom 1.0 (<entry>)
  const isAtom = !!doc.querySelector('feed');
  const nodes = Array.from(isAtom
    ? doc.getElementsByTagNameNS(NS.atom, 'entry') || doc.getElementsByTagName('entry')
    : doc.getElementsByTagName('item')
  );

  return nodes.slice(0, 20).map(node => parseXmlItem(node, isAtom, sourceName));
}

/**
 * Normalise a single RSS <item> or Atom <entry> DOM node into our article shape.
 */
function parseXmlItem(node, isAtom, sourceName) {
  // ── helpers ────────────────────────────────────────────────────────────────
  const text   = tag       => node.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
  const textNS = (ns, tag) => node.getElementsByTagNameNS(ns, tag)[0]?.textContent?.trim() ?? '';
  const attrNS = (ns, tag, a) => node.getElementsByTagNameNS(ns, tag)[0]?.getAttribute(a) ?? '';
  const attr   = (tag, a)  => node.getElementsByTagName(tag)[0]?.getAttribute(a) ?? '';

  // ── link ───────────────────────────────────────────────────────────────────
  // RSS:  <link>url</link>  or  <guid isPermaLink="true">
  // Atom: <link rel="alternate" href="url"/>  or first <link href="..."/>
  let link = '';
  if (isAtom) {
    const links = Array.from(node.getElementsByTagName('link'));
    const alt   = links.find(l => l.getAttribute('rel') === 'alternate' || !l.getAttribute('rel'));
    link = alt?.getAttribute('href') ?? alt?.textContent?.trim() ?? '';
  } else {
    link = text('link') || text('guid');
  }

  // ── date ───────────────────────────────────────────────────────────────────
  // RSS:  <pubDate>  or  <dc:date>
  // Atom: <updated>  or  <published>
  const rawDate = isAtom
    ? (text('updated') || text('published'))
    : (text('pubDate') || textNS(NS.dc, 'date'));
  const pubDate = rawDate ? new Date(rawDate).toISOString() : '';

  // ── description ────────────────────────────────────────────────────────────
  // RSS:  <description>  or  <content:encoded>
  // Atom: <summary>  or  <content>
  const rawDesc = isAtom
    ? (text('summary') || text('content'))
    : (text('description') || textNS(NS.content, 'encoded'));
  const description = stripHtml(rawDesc).slice(0, 200);

  // ── image ──────────────────────────────────────────────────────────────────
  // Preference: media:content url → media:thumbnail url → enclosure url → <img> in body
  const image =
       attrNS(NS.media, 'content',   'url')
    || attrNS(NS.media, 'thumbnail', 'url')
    || attr('enclosure', 'url')
    || extractImageFromHtml(rawDesc)
    || null;

  return {
    title: text('title'),
    link,
    pubDate,
    description,
    image,
    source: sourceName,
  };
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractImageFromHtml(html) {
  if (!html) return null;
  const match = html.match(/<img[^>]+src=["']([^"'>]+)["']/i);
  return match ? match[1] : null;
}

/**
 * Merge multiple feed result arrays, dedupe by link, sort newest first.
 */
export function mergeFeeds(feedResults) {
  const seen = new Set();
  const all = [];
  for (const items of feedResults) {
    for (const item of items) {
      if (item.link && !seen.has(item.link)) {
        seen.add(item.link);
        all.push(item);
      }
    }
  }
  return all.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });
}

/**
 * Invalidate cache for all feeds (used on manual refresh).
 */
export function clearFeedCache() {
  feedCache.clear();
}
