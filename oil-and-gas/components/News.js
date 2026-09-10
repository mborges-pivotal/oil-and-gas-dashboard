const { ref, computed, onMounted } = Vue;
import { fetchFeed, mergeFeeds, clearFeedCache } from '../services/rss.js';
import { formatDate } from '../utils/formatters.js';

const STAGGER_MS = 600; // delay between feed requests to respect rate limits

// Freshness filter options: label + max article age in ms ('all' has no cap)
const FRESHNESS_OPTIONS = [
  { value: 'all', label: 'Any time' },
  { value: '24h', label: 'Last 24 hours', maxAgeMs: 24 * 60 * 60 * 1000 },
  { value: '3d',  label: 'Last 3 days',   maxAgeMs: 3 * 24 * 60 * 60 * 1000 },
  { value: '7d',  label: 'Last 7 days',   maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days',  maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
];

export default {
  name: 'News',
  props: ['config'],
  setup(props) {
    const articles = ref([]);
    const loading = ref(true);
    const feedErrors = ref({});   // feedName → error message
    const lastUpdated = ref(null);

    const feeds = computed(() => (props.config.news?.feeds ?? []).filter(f => f.enabled !== false));
    const proxy = computed(() => props.config.news?.rssProxy ?? 'rss2json');

    // ── Filters ──────────────────────────────────────────────────────────────
    const searchQuery = ref('');
    const sourceFilter = ref('all');
    const freshnessFilter = ref('all');
    const freshnessOptions = FRESHNESS_OPTIONS;

    // Sources present in the currently loaded articles, not just configured
    // feeds — so the dropdown never lists a source with nothing to show.
    const sourceOptions = computed(() => {
      const seen = new Set(articles.value.map(a => a.source));
      return [...seen].sort();
    });

    const filteredArticles = computed(() => {
      const q = searchQuery.value.trim().toLowerCase();
      const freshness = FRESHNESS_OPTIONS.find(o => o.value === freshnessFilter.value);
      const now = Date.now();

      return articles.value.filter(article => {
        if (sourceFilter.value !== 'all' && article.source !== sourceFilter.value) return false;

        if (freshness?.maxAgeMs) {
          if (!article.pubDate) return false; // unknown age — exclude under an active freshness filter
          if (now - new Date(article.pubDate).getTime() > freshness.maxAgeMs) return false;
        }

        if (q) {
          const haystack = `${article.title} ${article.description}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }

        return true;
      });
    });

    const filtersActive = computed(() =>
      searchQuery.value.trim() !== '' || sourceFilter.value !== 'all' || freshnessFilter.value !== 'all'
    );

    function clearFilters() {
      searchQuery.value = '';
      sourceFilter.value = 'all';
      freshnessFilter.value = 'all';
    }

    async function fetchAll(force = false) {
      if (force) clearFeedCache();
      loading.value = articles.value.length === 0;
      feedErrors.value = {};
      const results = [];

      for (let i = 0; i < feeds.value.length; i++) {
        const feed = feeds.value[i];
        // Stagger to avoid hammering the proxy
        if (i > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
        try {
          const items = await fetchFeed(feed.url, feed.name, proxy.value);
          results.push(items);
        } catch (e) {
          feedErrors.value[feed.name] = e.message;
          results.push([]);
        }
      }

      articles.value = mergeFeeds(results);
      loading.value = false;
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    onMounted(() => fetchAll());

    function refresh() { fetchAll(true); }

    function relativeTime(isoStr) {
      if (!isoStr) return '';
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      return `${days}d ago`;
    }

    // Some feed-provided image URLs 404 or block hotlinking — hide the
    // broken image instead of showing the browser's broken-image icon.
    function onImageError(e) {
      e.target.closest('a').style.display = 'none';
    }

    return {
      articles, loading, feedErrors, lastUpdated, feeds, refresh, relativeTime, formatDate, onImageError,
      searchQuery, sourceFilter, freshnessFilter, freshnessOptions, sourceOptions,
      filteredArticles, filtersActive, clearFilters,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Oil & Gas News</div>
        <div class="flex gap-8" style="align-items:center">
          <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }} (30-min cache)</div>
          <button @click="refresh" :disabled="loading">↻ Refresh</button>
        </div>
      </div>

      <!-- Feed errors -->
      <div v-if="Object.keys(feedErrors).length" class="notice warn mb-16">
        Some feeds failed to load:
        <span v-for="(err, name) in feedErrors" :key="name" style="display:block;font-size:12px;margin-top:2px">
          <strong>{{ name }}</strong>:
          <span v-if="err.includes('blocked by source')">
            Feed host is blocking proxy access (403) — pause this feed in ⚙ Settings or replace it with a different URL.
          </span>
          <span v-else>{{ err }}</span>
        </span>
      </div>

      <!-- Empty state -->
      <div class="notice" v-if="feeds.length === 0">
        No RSS feeds configured. Add feeds in the ⚙ Settings tab.
      </div>

      <!-- Filters -->
      <div class="news-filters mb-16" v-if="feeds.length > 0">
        <input
          v-model="searchQuery"
          type="search"
          placeholder="Search title & description…"
          class="news-search"
        />
        <select v-model="sourceFilter">
          <option value="all">All sources</option>
          <option v-for="s in sourceOptions" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="freshnessFilter">
          <option v-for="opt in freshnessOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <button v-if="filtersActive" @click="clearFilters">Clear filters</button>
      </div>

      <!-- Loading -->
      <template v-if="loading">
        <div class="news-grid">
          <div class="news-card" v-for="i in 6" :key="i">
            <div class="skeleton news-card-image"></div>
            <div class="news-card-body">
              <div class="skeleton" style="width:40%;height:12px;margin-bottom:8px"></div>
              <div class="skeleton" style="width:90%;height:14px;margin-bottom:4px"></div>
              <div class="skeleton" style="width:70%;height:14px;margin-bottom:8px"></div>
              <div class="skeleton" style="width:100%;height:12px"></div>
            </div>
          </div>
        </div>
      </template>

      <!-- Article grid -->
      <div class="news-grid" v-else-if="filteredArticles.length">
        <div class="news-card" v-for="(article, i) in filteredArticles" :key="article.link || i">
          <a v-if="article.image" :href="article.link" target="_blank" rel="noopener">
            <img class="news-card-image" :src="article.image" alt="" loading="lazy" @error="onImageError" />
          </a>
          <div class="news-card-body">
            <div class="news-meta">
              <span class="source-badge">{{ article.source }}</span>
              <span class="news-date">{{ relativeTime(article.pubDate) }}</span>
            </div>
            <div class="news-title">
              <a :href="article.link" target="_blank" rel="noopener">{{ article.title }}</a>
            </div>
            <div class="news-snippet" v-if="article.description">{{ article.description }}</div>
          </div>
        </div>
      </div>

      <div class="notice text-sm" v-else-if="!loading && articles.length && filtersActive">
        No articles match your filters. <button @click="clearFilters">Clear filters</button>
      </div>

      <div class="notice text-sm" v-else-if="!loading && !articles.length">
        No articles loaded. Check your feed URLs in ⚙ Settings or try refreshing.
      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="articles.length">
        Showing {{ filteredArticles.length }} of {{ articles.length }} articles · fetched via
        {{ proxy === 'rss2json' ? 'rss2json.com' : 'allorigins.win' }} proxy.
        Cached for 30 minutes. Manage feeds in ⚙ Settings.
      </div>
    </div>
  `,
};
