const { ref, computed, onMounted } = Vue;
import { fetchFeed, mergeFeeds, clearFeedCache } from '../services/rss.js';
import { formatDate } from '../utils/formatters.js';

const STAGGER_MS = 600; // delay between feed requests to respect rate limits

export default {
  name: 'News',
  props: ['config'],
  setup(props) {
    const articles = ref([]);
    const loading = ref(true);
    const feedErrors = ref({});   // feedName → error message
    const lastUpdated = ref(null);

    const feeds = computed(() => props.config.news?.feeds ?? []);
    const proxy = computed(() => props.config.news?.rssProxy ?? 'rss2json');

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

    return { articles, loading, feedErrors, lastUpdated, feeds, refresh, relativeTime, formatDate };
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
          <strong>{{ name }}</strong>: {{ err }}
        </span>
      </div>

      <!-- Empty state -->
      <div class="notice" v-if="feeds.length === 0">
        No RSS feeds configured. Add feeds in the ⚙ Settings tab.
      </div>

      <!-- Loading -->
      <template v-if="loading">
        <div v-for="i in 6" :key="i" style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div class="skeleton" style="width:40%;height:12px;margin-bottom:6px"></div>
          <div class="skeleton" style="width:80%;height:14px;margin-bottom:4px"></div>
          <div class="skeleton" style="width:90%;height:12px"></div>
        </div>
      </template>

      <!-- Article list -->
      <div class="news-list" v-else-if="articles.length">
        <div class="news-item" v-for="(article, i) in articles" :key="article.link || i">
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

      <div class="notice text-sm" v-else-if="!loading && !articles.length">
        No articles loaded. Check your feed URLs in ⚙ Settings or try refreshing.
      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="articles.length">
        News fetched via {{ proxy === 'rss2json' ? 'rss2json.com' : 'allorigins.win' }} proxy.
        Cached for 30 minutes. Manage feeds in ⚙ Settings.
      </div>
    </div>
  `,
};
