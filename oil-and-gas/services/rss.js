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
 * Each item: { title, link, pubDate: ISO string, description, source }
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
  const url = `${RSS2JSON}?rss_url=${encodeURIComponent(feedUrl)}&count=20`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`rss2json HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'ok') {
    // Fallback to allorigins on rss2json error
    return fetchViaAllorigins(feedUrl, sourceName);
  }
  return (json.items ?? []).map(item => ({
    title: item.title ?? '',
    link: item.link ?? '',
    pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : '',
    description: stripHtml(item.description ?? '').slice(0, 200),
    source: sourceName,
  }));
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
    const pubDate = get('pubDate');
    return {
      title: get('title'),
      link: get('link') || get('guid'),
      pubDate: pubDate ? new Date(pubDate).toISOString() : '',
      description: stripHtml(get('description')).slice(0, 200),
      source: sourceName,
    };
  });
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
