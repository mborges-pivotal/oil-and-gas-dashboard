import { loadConfig, saveConfig, exportConfig } from './utils/config.js';
import { configureYahooFinance } from './services/yahooFinance.js';

// Lazy-loaded components — imported as strings for Vue CDN defineAsyncComponent pattern
import OilPricesComponent from './components/OilPrices.js';
import GasPricesComponent from './components/GasPrices.js';
import StocksComponent from './components/Stocks.js';
import NewsComponent from './components/News.js';
import DocumentsComponent from './components/Documents.js';

const { createApp, ref, reactive, provide, onMounted } = Vue;

// ── Settings Panel component ────────────────────────────────────────────────
const SettingsPanel = {
  props: ['config'],
  emits: ['save', 'export', 'reset'],
  setup(props, { emit }) {
    // Work on a deep clone so changes aren't live until saved
    const local = reactive(JSON.parse(JSON.stringify(props.config)));
    // Configs saved before this setting existed won't have this section
    if (!local.yahooFinance) {
      local.yahooFinance = { corsProxy: 'local', localProxyUrl: '/proxy?url=' };
    }
    if (!local.crackSpreadThresholds) {
      local.crackSpreadThresholds = { modestMax: 15, healthyMax: 25, veryStrongMax: 35 };
    }

    // Stock ticker add
    const newTicker = ref('');
    function addTicker() {
      const t = newTicker.value.trim().toUpperCase();
      if (t && !local.stocks.tickers.includes(t)) {
        local.stocks.tickers.push(t);
      }
      newTicker.value = '';
    }
    function removeTicker(i) { local.stocks.tickers.splice(i, 1); }

    // News feed add
    const newFeedName = ref('');
    const newFeedUrl = ref('');
    function addFeed() {
      const name = newFeedName.value.trim();
      const url = newFeedUrl.value.trim();
      if (name && url) {
        local.news.feeds.push({ name, url });
        newFeedName.value = '';
        newFeedUrl.value = '';
      }
    }
    function removeFeed(i) { local.news.feeds.splice(i, 1); }

    // Company add
    const newCompanyTicker = ref('');
    const newCompanyName = ref('');
    function addCompany() {
      const ticker = newCompanyTicker.value.trim().toUpperCase();
      const name = newCompanyName.value.trim();
      if (ticker && name) {
        local.documents.companies.push({ ticker, name });
        newCompanyTicker.value = '';
        newCompanyName.value = '';
      }
    }
    function removeCompany(i) { local.documents.companies.splice(i, 1); }

    function save() { emit('save', JSON.parse(JSON.stringify(local))); }
    function exportCfg() { emit('export', JSON.parse(JSON.stringify(local))); }
    function reset() { emit('reset'); }

    return {
      local, newTicker, addTicker, removeTicker,
      newFeedName, newFeedUrl, addFeed, removeFeed,
      newCompanyTicker, newCompanyName, addCompany, removeCompany,
      save, exportCfg, reset,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Settings</div>
        <div class="flex gap-8">
          <button @click="exportCfg">Export Config</button>
          <button class="danger" @click="reset">Reset to Defaults</button>
          <button class="primary" @click="save">Save Changes</button>
        </div>
      </div>

      <!-- EIA API Key -->
      <div class="settings-section">
        <h3>EIA API Key</h3>
        <p class="text-muted text-sm mb-16" style="margin-bottom:10px">
          Required for Gas Prices tab. Get a free key at
          <a href="https://www.eia.gov/opendata/" target="_blank">eia.gov/opendata</a>.
          The key is stored locally and visible in browser DevTools — this is expected for public EIA keys.
        </p>
        <div class="settings-row">
          <input v-model="local.eiaApiKey" placeholder="Enter your free EIA API key…" style="max-width:400px" />
        </div>
      </div>

      <!-- Refresh Interval -->
      <div class="settings-section">
        <h3>Auto-Refresh Interval</h3>
        <div class="settings-row">
          <label style="display:inline;margin:0;margin-right:8px">Refresh every</label>
          <input v-model.number="local.ui.refreshIntervalSeconds" type="number" min="30" max="3600" style="width:80px" />
          <span class="text-muted text-sm">seconds (min 30)</span>
        </div>
      </div>

      <!-- Yahoo Finance CORS Proxy -->
      <div class="settings-section">
        <h3>Yahoo Finance CORS Proxy</h3>
        <p class="text-muted text-sm mb-16" style="margin-bottom:10px">
          Yahoo Finance doesn't send CORS headers, so the browser can't call it directly.
          By default this app routes through a small local relay — run
          <code>node local-proxy.js</code> alongside the static server. Switch to
          "Direct only" to skip that extra step, but Oil Prices and Stocks will show
          "Unavailable" unless something else on your network allows direct access.
        </p>
        <div class="settings-row">
          <label style="display:inline;margin:0;margin-right:8px">Proxy mode:</label>
          <select v-model="local.yahooFinance.corsProxy">
            <option value="local">Local relay (node local-proxy.js)</option>
            <option value="none">Direct only (no proxy)</option>
          </select>
        </div>
        <div class="settings-row" style="margin-top:10px" v-if="local.yahooFinance.corsProxy === 'local'">
          <label style="display:inline;margin:0;margin-right:8px">Relay URL:</label>
          <input v-model="local.yahooFinance.localProxyUrl" style="flex:1;max-width:400px" placeholder="/proxy?url=" />
        </div>
      </div>

      <!-- Crack Spread Thresholds -->
      <div class="settings-section">
        <h3>Crack Spread Strength Thresholds (USD/bbl)</h3>
        <p class="text-muted text-sm mb-16" style="margin-bottom:10px">
          Boundaries for the strength indicator shown next to the 3-2-1 crack spread
          on the Gas Prices tab. Each tier covers up to its value; anything above
          "Very Strong up to" is classified Extremely Strong.
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

      <!-- Stock Tickers -->
      <div class="settings-section">
        <h3>Stock Watchlist Tickers</h3>
        <div class="tag-list">
          <span class="tag" v-for="(t, i) in local.stocks.tickers" :key="t">
            {{ t }}
            <button class="remove-btn" @click="removeTicker(i)">×</button>
          </span>
        </div>
        <div class="settings-row">
          <input v-model="newTicker" placeholder="e.g. BP" @keyup.enter="addTicker" style="width:120px" />
          <button @click="addTicker">Add Ticker</button>
        </div>
      </div>

      <!-- News Feeds -->
      <div class="settings-section">
        <h3>News RSS Feeds</h3>
        <div v-for="(feed, i) in local.news.feeds" :key="i" class="settings-row" style="margin-bottom:6px">
          <input v-model="feed.name" placeholder="Name" style="width:160px;flex:none" />
          <input v-model="feed.url" placeholder="RSS URL" style="flex:1" />
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
      </div>

      <!-- Documents Companies -->
      <div class="settings-section">
        <h3>Document Collector Companies</h3>
        <div v-for="(co, i) in local.documents.companies" :key="i" class="settings-row" style="margin-bottom:6px">
          <input v-model="co.ticker" placeholder="Ticker" style="width:90px;flex:none" />
          <input v-model="co.name" placeholder="Company name" style="flex:1" />
          <button class="danger" @click="removeCompany(i)">Remove</button>
        </div>
        <div class="settings-row" style="margin-top:8px">
          <input v-model="newCompanyTicker" placeholder="Ticker" style="width:90px;flex:none" @keyup.enter="addCompany" />
          <input v-model="newCompanyName" placeholder="Company name" style="flex:1" @keyup.enter="addCompany" />
          <button @click="addCompany">Add Company</button>
        </div>
      </div>
    </div>
  `,
};

// ── Root App ────────────────────────────────────────────────────────────────
const App = {
  components: {
    OilPrices: OilPricesComponent,
    GasPrices: GasPricesComponent,
    Stocks: StocksComponent,
    News: NewsComponent,
    Documents: DocumentsComponent,
    SettingsPanel,
  },
  setup() {
    const config = ref(null);
    const activeTab = ref('oil');
    const configLoaded = ref(false);
    const saveNotice = ref(false);
    // Bumped on reset to force SettingsPanel to remount — it clones config
    // into local state once at setup(), so it needs a fresh instance to
    // pick up the reset values instead of showing stale form state.
    const settingsKey = ref(0);

    const tabs = [
      { id: 'oil',       label: 'Oil Prices' },
      { id: 'gas',       label: 'Gas Prices' },
      { id: 'stocks',    label: 'Stocks' },
      { id: 'news',      label: 'News' },
      { id: 'documents', label: 'Documents' },
      { id: 'settings',  label: '⚙ Settings' },
    ];

    onMounted(async () => {
      config.value = await loadConfig();
      configureYahooFinance(config.value.yahooFinance);
      configLoaded.value = true;
    });

    function onSaveConfig(updated) {
      config.value = updated;
      saveConfig(updated);
      configureYahooFinance(updated.yahooFinance);
      saveNotice.value = true;
      setTimeout(() => { saveNotice.value = false; }, 2500);
    }

    async function onResetConfig() {
      if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
      localStorage.removeItem('oilgas_config');
      const res = await fetch('./config.json', { cache: 'no-store' });
      config.value = await res.json();
      saveConfig(config.value);
      configureYahooFinance(config.value.yahooFinance);
      settingsKey.value++;
    }

    function onExportConfig(cfg) { exportConfig(cfg); }

    // Provide config to all child components
    provide('config', config);

    return { config, configLoaded, activeTab, tabs, saveNotice, settingsKey, onSaveConfig, onResetConfig, onExportConfig };
  },
  template: `
    <div id="app">
      <header class="app-header">
        <div class="logo">Oil &amp; Gas <span>Dashboard</span></div>
        <nav class="tab-bar">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="tab-btn"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >{{ tab.label }}</button>
        </nav>
      </header>

      <main class="tab-content">
        <template v-if="!configLoaded">
          <div class="loading-text">Loading…</div>
        </template>
        <template v-else>
          <div v-if="saveNotice" class="notice" style="margin-bottom:16px">✓ Settings saved.</div>

          <OilPrices     v-if="activeTab === 'oil'"       :config="config" />
          <GasPrices     v-if="activeTab === 'gas'"       :config="config" />
          <Stocks        v-if="activeTab === 'stocks'"    :config="config" />
          <News          v-if="activeTab === 'news'"      :config="config" />
          <Documents     v-if="activeTab === 'documents'" :config="config" />
          <SettingsPanel v-if="activeTab === 'settings'"  :key="settingsKey" :config="config"
            @save="onSaveConfig"
            @export="onExportConfig"
            @reset="onResetConfig"
          />
        </template>
      </main>
    </div>
  `,
};

createApp(App).mount('#app');
