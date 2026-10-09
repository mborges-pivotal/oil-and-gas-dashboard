const { ref, reactive } = Vue;
import { OPEN_ARTICLES_IN_DEFAULT } from '../utils/articleViewer.js';

/**
 * Profile → Dashboard: the dashboard's settings — auto-refresh interval,
 * the Yahoo Finance relay, crack-spread strength thresholds and the news
 * feeds. Edits a copy; **Save changes** emits just these fields
 * (`save` → { ui: { refreshIntervalSeconds }, yahooFinance, crackSpreadThresholds, news }),
 * which app.js merges into the live settings — so watchlists, portfolios
 * and the theme (edited elsewhere) are never overwritten by a stale copy.
 */
const clone = v => JSON.parse(JSON.stringify(v ?? null));

export default {
  name: 'DashboardSettings',
  props: { config: Object },
  emits: ['save'],
  setup(props, { emit }) {
    const c = props.config ?? {};
    const local = reactive({
      refreshIntervalSeconds: c.ui?.refreshIntervalSeconds ?? 60,
      yahooFinance: clone(c.yahooFinance) ?? { corsProxy: 'local', localProxyUrl: '/proxy?url=' },
      crackSpreadThresholds: clone(c.crackSpreadThresholds) ?? { modestMax: 15, healthyMax: 25, veryStrongMax: 35 },
      news: { feeds: [], rssProxy: 'rss2json', ...clone(c.news) },
    });
    if (local.news.economicNewsDays == null) local.news.economicNewsDays = 7;
    if (local.news.openArticlesIn == null) local.news.openArticlesIn = OPEN_ARTICLES_IN_DEFAULT;

    // Each section collapses independently (open to start).
    const sections = reactive({ refresh: true, proxy: true, crack: true, feeds: true });
    const toggleSection = key => { sections[key] = !sections[key]; };

    // News feeds
    const newFeedName = ref('');
    const newFeedUrl = ref('');
    function addFeed() {
      const name = newFeedName.value.trim();
      const url = newFeedUrl.value.trim();
      if (!name || !url) return;
      local.news.feeds.push({ name, url, enabled: true });
      newFeedName.value = '';
      newFeedUrl.value = '';
    }
    const removeFeed = i => local.news.feeds.splice(i, 1);
    // A missing `enabled` counts as on (older saved settings).
    const toggleFeed = i => { const f = local.news.feeds[i]; f.enabled = f.enabled === false; };

    function save() {
      emit('save', {
        ui: { refreshIntervalSeconds: Math.max(30, Number(local.refreshIntervalSeconds) || 60) },
        yahooFinance: clone(local.yahooFinance),
        crackSpreadThresholds: clone(local.crackSpreadThresholds),
        news: clone(local.news),
      });
    }

    return { local, sections, toggleSection, newFeedName, newFeedUrl, addFeed, removeFeed, toggleFeed, save };
  },
  template: `
    <div class="dashboard-settings">
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Dashboard</div>
        <button class="primary" @click="save">Save changes</button>
      </div>
      <p class="text-muted text-sm" style="margin:-8px 0 16px">
        Saved to your profile — they follow you to any device you sign in on. The theme is the ◐ button at the right of the bar under the header.
      </p>

      <!-- Refresh Interval -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.refresh }" @click="toggleSection('refresh')">
          <span>Auto-Refresh Interval</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.refresh">
          <div class="settings-row">
            <label style="display:inline;margin:0;margin-right:8px">Refresh every</label>
            <input v-model.number="local.refreshIntervalSeconds" type="number" min="30" max="3600" style="width:80px" />
            <span class="text-muted text-sm">seconds (min 30)</span>
          </div>
        </div>
      </div>

      <!-- Yahoo Finance CORS Proxy -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.proxy }" @click="toggleSection('proxy')">
          <span>Yahoo Finance CORS Proxy</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.proxy">
          <p class="text-muted text-sm" style="margin:0 0 10px">
            Yahoo Finance doesn't send CORS headers, so the browser can't call it directly.
            By default this app routes through the server's relay. Switch to "Direct only" to skip it,
            but prices will show "Unavailable" unless something else on your network allows direct access.
          </p>
          <div class="settings-row">
            <label style="display:inline;margin:0;margin-right:8px">Proxy mode:</label>
            <select v-model="local.yahooFinance.corsProxy">
              <option value="local">Local relay</option>
              <option value="none">Direct only (no proxy)</option>
            </select>
          </div>
          <div class="settings-row" style="margin-top:10px" v-if="local.yahooFinance.corsProxy === 'local'">
            <label style="display:inline;margin:0;margin-right:8px">Relay URL:</label>
            <input v-model="local.yahooFinance.localProxyUrl" style="flex:1;max-width:400px" placeholder="/proxy?url=" />
          </div>
        </div>
      </div>

      <!-- Crack Spread Thresholds -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.crack }" @click="toggleSection('crack')">
          <span>Crack Spread Strength Thresholds (USD/bbl)</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.crack">
          <p class="text-muted text-sm" style="margin:0 0 10px">
            Boundaries for the strength indicator next to the 3-2-1 crack spread on Energy → Retail Gas Prices.
            Each tier covers up to its value; anything above "Very Strong up to" is Extremely Strong.
          </p>
          <div class="settings-row" style="margin-bottom:8px">
            <label style="display:inline;margin:0;margin-right:8px;width:170px">Normal / Modest up to</label>
            <input v-model.number="local.crackSpreadThresholds.modestMax" type="number" step="0.5" style="width:100px" />
          </div>
          <div class="settings-row" style="margin-bottom:8px">
            <label style="display:inline;margin:0;margin-right:8px;width:170px">Healthy up to</label>
            <input v-model.number="local.crackSpreadThresholds.healthyMax" type="number" step="0.5" style="width:100px" />
          </div>
          <div class="settings-row">
            <label style="display:inline;margin:0;margin-right:8px;width:170px">Very Strong up to</label>
            <input v-model.number="local.crackSpreadThresholds.veryStrongMax" type="number" step="0.5" style="width:100px" />
          </div>
        </div>
      </div>

      <!-- News Feeds -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.feeds }" @click="toggleSection('feeds')">
          <span>News RSS Feeds</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.feeds">
          <div v-for="(feed, i) in local.news.feeds" :key="i" class="settings-row" style="margin-bottom:6px">
            <input v-model="feed.name" placeholder="Name" style="width:160px;flex:none" :style="feed.enabled === false ? 'opacity:0.45' : ''" />
            <input v-model="feed.url" placeholder="RSS URL" style="flex:1" :style="feed.enabled === false ? 'opacity:0.45' : ''" />
            <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;margin:0;font-weight:normal" title="Show this feed's recent articles as news cards on the Economy tab">
              <input type="checkbox" v-model="feed.showInEconomicIndicators" style="width:auto" />
              <span class="text-sm">Economy</span>
            </label>
            <button @click="toggleFeed(i)" :title="feed.enabled === false ? 'Enable feed' : 'Pause feed'">{{ feed.enabled === false ? '▶ Enable' : '⏸ Pause' }}</button>
            <button class="danger" @click="removeFeed(i)">Remove</button>
          </div>
          <div class="settings-row" style="margin-top:8px">
            <input v-model="newFeedName" placeholder="Source name" style="width:160px;flex:none" />
            <input v-model="newFeedUrl" placeholder="RSS feed URL" style="flex:1" @keyup.enter="addFeed" />
            <button @click="addFeed">Add Feed</button>
          </div>
          <div class="settings-row" style="margin-top:10px">
            <label style="display:inline;margin:0;margin-right:8px">RSS Proxy:</label>
            <select v-model="local.news.rssProxy">
              <option value="rss2json">rss2json.com (recommended, 10 req/hr)</option>
              <option value="allorigins">allorigins.win (raw XML, no rate limit)</option>
            </select>
          </div>
          <div class="settings-row" style="margin-top:10px">
            <label style="display:inline;margin:0;margin-right:8px">Open articles in:</label>
            <select v-model="local.news.openArticlesIn">
              <option value="popup">Popup viewer (inside the dashboard)</option>
              <option value="newTab">New browser tab</option>
            </select>
          </div>
          <p class="text-muted text-sm" style="margin:-2px 0 0" v-if="local.news.openArticlesIn === 'popup'">
            Some sites (e.g. Reuters, CNBC, Rigzone) don't allow being shown inside other pages — for those the
            popup offers to open the article in a new tab instead. Cmd/Ctrl-click always opens a new tab.
          </p>
          <div class="settings-row" style="margin-top:10px">
            <label style="display:inline;margin:0;margin-right:8px">Economy news cards: show articles from the last</label>
            <input v-model.number="local.news.economicNewsDays" type="number" min="1" max="90" style="width:60px" />
            <span class="text-muted text-sm">days</span>
          </div>
        </div>
      </div>

      <div class="flex-between" style="margin-top:16px">
        <span></span>
        <button class="primary" @click="save">Save changes</button>
      </div>
    </div>
  `,
};
