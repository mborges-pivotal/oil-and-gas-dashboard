/**
 * RSS feed service.
 *
 * Primary: rss2json.com (free tier, 10 req/hr without key, cleaner response)
 * Fallback: allorigins.win raw proxy + DOMParser
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
    const res = await fetch(url, { cache: 'no-store' });
    // rss2json returns a non-2xx status for its own errors (invalid feed,
    // upstream fetch failure, etc.), not a 200 with status:"error" — so the
    // fallback below must cover both cases, not just a parsed error body.
    if (!res.ok) throw new Error(`rss2json HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'ok') throw new Error(json.message || 'rss2json returned an error');
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
  } catch {
    // Fallback to allorigins on any rss2json failure
    return fetchViaAllorigins(feedUrl, sourceName);
  }
}

async function fetchViaAllorigins(feedUrl, sourceName) {
  const url = `${ALLORIGINS}${encodeURIComponent(feedUrl)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`allorigins HTTP ${res.status}`);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const items = Array.from(doc.getElementsByTagName('item'));
  return items.slice(0, 20).map(item => {
    const get = tag => item.getElementsByTagName(tag)[0]?.textContent ?? '';
    const getAttr = (tag, attr) => item.getElementsByTagName(tag)[0]?.getAttribute(attr) ?? '';
    const pubDate = get('pubDate');
    const description = get('description');
    return {
      title: get('title'),
      link: get('link') || get('guid'),
      pubDate: pubDate ? new Date(pubDate).toISOString() : '',
      description: stripHtml(description).slice(0, 200),
      image: getAttr('enclosure', 'url')
        || getAttr('media:content', 'url')
        || getAttr('media:thumbnail', 'url')
        || extractImageFromHtml(description)
        || null,
      source: sourceName,
    };
  });
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
