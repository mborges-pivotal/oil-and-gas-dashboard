import { loadConfig, saveConfig, resetConfig, exportConfig } from './utils/config.js';
import { configureYahooFinance } from './services/yahooFinance.js';
import { fetchCurrentUser } from './services/auth.js';
import { THEME_OPTIONS, applyTheme, normalizeTheme } from './utils/theme.js';

// Lazy-loaded components — imported as strings for Vue CDN defineAsyncComponent pattern
import EconomicIndicatorsComponent from './components/EconomicIndicators.js';
import OilGasMarketsComponent from './components/OilGasMarkets.js';
import StocksComponent from './components/Stocks.js';
import NewsComponent from './components/News.js';
import AccountComponent from './components/Account.js';

const { createApp, ref, reactive, computed, provide, onMounted } = Vue;

// ── Settings Panel component ────────────────────────────────────────────────
const SettingsPanel = {
  emits: ['save', 'export', 'reset', 'go-account'],
  props: ['config', 'user'],
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
    if (local.news && local.news.economicNewsDays == null) {
      local.news.economicNewsDays = 7;
    }

    // Each settings section can be collapsed independently; open by default
    // so existing behavior (everything visible) is unchanged until a user
    // chooses to collapse something.
    const sections = reactive({
      refresh: true, proxy: true, crack: true,
      tickers: true, feeds: true,
    });
    function toggleSection(key) { sections[key] = !sections[key]; }

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
        local.news.feeds.push({ name, url, enabled: true });
        newFeedName.value = '';
        newFeedUrl.value = '';
      }
    }
    function removeFeed(i) { local.news.feeds.splice(i, 1); }
    function toggleFeed(i) {
      const feed = local.news.feeds[i];
      // Treat missing `enabled` field as true (backwards-compat with saved configs)
      feed.enabled = feed.enabled === false ? true : false;
    }

    // eiaApiKey/fredApiKey are fixed, operator-configured values (see
    // server.js) — this panel never shows or edits them, and neither an
    // exported file nor an imported one should be able to carry them.
    function stripApiKeys(obj) {
      const { eiaApiKey, fredApiKey, ...rest } = obj;
      return rest;
    }

    function save() { emit('save', JSON.parse(JSON.stringify(local))); }
    function exportCfg() { emit('export', stripApiKeys(JSON.parse(JSON.stringify(local)))); }
    function reset() { emit('reset'); }

    // Import Config — populates the form from an exported JSON file; the
    // user still has to click "Save Changes" to persist it, same as any
    // other edit made in this panel.
    const fileInput = ref(null);
    const importStatus = ref(null); // { type: 'success'|'error', message }
    function triggerImport() { fileInput.value.click(); }
    function onImportFile(e) {
      const file = e.target.files[0];
      e.target.value = ''; // allow re-importing the same file later
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (err) {
          importStatus.value = { type: 'error', message: `Not valid JSON: ${err.message}` };
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          importStatus.value = { type: 'error', message: 'File does not contain a config object.' };
          return;
        }

        Object.assign(local, stripApiKeys(parsed));
        // Configs exported before these settings existed won't have them
        if (!local.yahooFinance) {
          local.yahooFinance = { corsProxy: 'local', localProxyUrl: '/proxy?url=' };
        }
        if (!local.crackSpreadThresholds) {
          local.crackSpreadThresholds = { modestMax: 15, healthyMax: 25, veryStrongMax: 35 };
        }
        if (local.news && local.news.economicNewsDays == null) {
          local.news.economicNewsDays = 7;
        }
        importStatus.value = { type: 'success', message: `Imported "${file.name}" — review below, then click Save Changes.` };
      };
      reader.onerror = () => {
        importStatus.value = { type: 'error', message: 'Could not read the file.' };
      };
      reader.readAsText(file);
    }

    return {
      local, sections, toggleSection,
      newTicker, addTicker, removeTicker,
      newFeedName, newFeedUrl, addFeed, removeFeed, toggleFeed,
      save, exportCfg, reset,
      fileInput, importStatus, triggerImport, onImportFile,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Settings</div>
        <div class="flex gap-8">
          <input ref="fileInput" type="file" accept="application/json,.json" style="display:none" @change="onImportFile" />
          <button @click="triggerImport">Import Config</button>
          <button @click="exportCfg">Export Config</button>
          <button class="danger" @click="reset">Reset to Defaults</button>
          <button class="primary" @click="save">Save Changes</button>
        </div>
      </div>

      <div class="notice" style="margin-bottom:16px">
        <template v-if="user">
          Settings are saved to your account (<strong>{{ user.email }}</strong>) and follow you to any device you sign in on.
        </template>
        <template v-else>
          Settings are saved in this browser only.
          <a href="#" @click.prevent="$emit('go-account')">Sign in or create an account</a> to save them to a profile.
        </template>
      </div>

      <div v-if="importStatus" class="notice" :class="{ error: importStatus.type === 'error' }" style="margin-bottom:16px">
        {{ importStatus.type === 'error' ? '✗' : '✓' }} {{ importStatus.message }}
      </div>

      <!-- Refresh Interval -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.refresh }" @click="toggleSection('refresh')">
          <span>Auto-Refresh Interval</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.refresh">
          <div class="settings-row">
            <label style="display:inline;margin:0;margin-right:8px">Refresh every</label>
            <input v-model.number="local.ui.refreshIntervalSeconds" type="number" min="30" max="3600" style="width:80px" />
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
      </div>

      <!-- Crack Spread Thresholds -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.crack }" @click="toggleSection('crack')">
          <span>Crack Spread Strength Thresholds (USD/bbl)</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.crack">
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
      </div>

      <!-- Stock Tickers -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.tickers }" @click="toggleSection('tickers')">
          <span>Stock Watchlist Tickers</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.tickers">
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
            <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;margin:0;font-weight:normal" title="Show this feed's recent articles as news cards on the Economic Indicators tab">
              <input type="checkbox" v-model="feed.showInEconomicIndicators" style="width:auto" />
              <span class="text-sm">Econ Indicators</span>
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
            <label style="display:inline;margin:0;margin-right:8px">Economic Indicators news cards: show articles from the last</label>
            <input v-model.number="local.news.economicNewsDays" type="number" min="1" max="90" style="width:60px" />
            <span class="text-muted text-sm">days</span>
          </div>
        </div>
      </div>

    </div>
  `,
};

// ── Root App ────────────────────────────────────────────────────────────────
const App = {
  components: {
    EconomicIndicators: EconomicIndicatorsComponent,
    OilGasMarkets: OilGasMarketsComponent,
    Stocks: StocksComponent,
    News: NewsComponent,
    Account: AccountComponent,
    SettingsPanel,
  },
  setup() {
    const config = ref(null);
    // Signed-in user's profile (services/auth.js), or null when anonymous.
    const user = ref(null);
    const activeTab = ref('econ');
    const configLoaded = ref(false);
    const saveNotice = ref(null); // message string while shown
    const saveError = ref(null);
    // Bumped on reset to force SettingsPanel to remount — it clones config
    // into local state once at setup(), so it needs a fresh instance to
    // pick up the reset values instead of showing stale form state.
    const settingsKey = ref(0);

    const tabs = computed(() => [
      { id: 'econ',      label: 'Economic Indicators' },
      { id: 'markets',   label: 'Oil & Gas Markets' },
      { id: 'stocks',    label: 'Stocks' },
      { id: 'news',      label: 'News' },
      { id: 'settings',  label: '⚙ Settings' },
      { id: 'account',   label: user.value ? `👤 ${user.value.displayName || user.value.email}` : 'Sign In' },
    ]);

    function showNotice(message) {
      saveError.value = null;
      saveNotice.value = message;
      setTimeout(() => { if (saveNotice.value === message) saveNotice.value = null; }, 2500);
    }

    // Swaps in a freshly loaded config (after sign-in/out or reset) and
    // remounts SettingsPanel — it clones config into local state once at
    // setup(), so it needs a fresh instance to show the new values.
    function applyConfig(cfg) {
      config.value = cfg;
      applyTheme(cfg.ui?.theme);
      configureYahooFinance(cfg.yahooFinance);
      settingsKey.value++;
    }

    onMounted(async () => {
      user.value = await fetchCurrentUser();
      try {
        config.value = await loadConfig(user.value);
      } catch (err) {
        // Profile couldn't be read/seeded — fall back to this browser's
        // settings rather than leaving the whole dashboard on "Loading…".
        saveError.value = `Couldn't load your profile settings (${err.message}); showing this browser's settings.`;
        user.value = null;
        config.value = await loadConfig();
      }
      configureYahooFinance(config.value.yahooFinance);
      applyTheme(config.value.ui?.theme);
      configLoaded.value = true;
    });

    async function onSaveConfig(updated) {
      // eiaApiKey/fredApiKey are fixed, operator-configured values (never
      // edited in Settings) — re-apply whatever's currently live rather
      // than trust the SettingsPanel's clone, which could be a stale
      // snapshot from whenever that panel was mounted. saveConfig() also
      // strips them before writing to localStorage regardless.
      // Same for the theme: it's changed from the header switch, not this
      // panel, so the panel's clone may hold an outdated value.
      const next = {
        ...updated,
        ui: { ...updated.ui, theme: config.value.ui?.theme },
        eiaApiKey: config.value.eiaApiKey,
        fredApiKey: config.value.fredApiKey,
      };
      try {
        await saveConfig(next, user.value);
      } catch (err) {
        saveError.value = `Settings were not saved: ${err.message}`;
        return;
      }
      config.value = next;
      configureYahooFinance(config.value.yahooFinance);
      showNotice(user.value ? '✓ Settings saved to your profile.' : '✓ Settings saved.');
    }

    async function onResetConfig() {
      const where = user.value ? 'your profile' : 'this browser';
      if (!confirm(`Reset all settings in ${where} to defaults? This cannot be undone.`)) return;
      try {
        applyConfig(await resetConfig(user.value));
      } catch (err) {
        saveError.value = `Settings were not reset: ${err.message}`;
      }
    }

    function onExportConfig(cfg) { exportConfig(cfg); }

    async function onSignedIn(signedInUser, { isNew } = {}) {
      user.value = signedInUser;
      try {
        applyConfig(await loadConfig(signedInUser));
        showNotice(isNew
          ? '✓ Account created — your current settings were saved to your profile.'
          : '✓ Signed in — loaded your saved settings.');
      } catch (err) {
        saveError.value = `Signed in, but couldn't load your profile settings: ${err.message}`;
      }
    }

    async function onSignedOut() {
      user.value = null;
      applyConfig(await loadConfig());
      showNotice('✓ Signed out — using this browser\'s settings.');
    }

    function onUserUpdated(updatedUser) { user.value = updatedUser; }

    // Header light/dark/system switch — applies instantly and saves like
    // any other setting (to the profile when signed in, else this browser).
    const themePreference = computed(() => normalizeTheme(config.value?.ui?.theme));
    async function setTheme(theme) {
      if (theme === themePreference.value) return;
      applyTheme(theme);
      config.value = { ...config.value, ui: { ...config.value.ui, theme } };
      try {
        await saveConfig(config.value, user.value);
      } catch (err) {
        saveError.value = `Theme was applied but not saved: ${err.message}`;
      }
    }

    // Provide config to all child components
    provide('config', config);

    return {
      config, user, configLoaded, activeTab, tabs, saveNotice, saveError, settingsKey,
      onSaveConfig, onResetConfig, onExportConfig,
      onSignedIn, onSignedOut, onUserUpdated,
      themeOptions: THEME_OPTIONS, themePreference, setTheme,
    };
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
            :class="{ active: activeTab === tab.id, 'account-tab': tab.id === 'account' }"
            :title="tab.id === 'account' && user ? user.email : null"
            @click="activeTab = tab.id"
          >{{ tab.label }}</button>
        </nav>
        <div class="theme-switch" role="group" aria-label="Color theme">
          <button
            v-for="opt in themeOptions"
            :key="opt.value"
            type="button"
            :aria-pressed="themePreference === opt.value"
            :title="opt.label + ' theme'"
            :disabled="!configLoaded"
            @click="setTheme(opt.value)"
          >{{ opt.icon }}</button>
        </div>
      </header>

      <main class="tab-content">
        <template v-if="!configLoaded">
          <div class="loading-text">Loading…</div>
        </template>
        <template v-else>
          <div v-if="saveNotice" class="notice" style="margin-bottom:16px">{{ saveNotice }}</div>
          <div v-if="saveError" class="notice error" style="margin-bottom:16px">✗ {{ saveError }}</div>

          <EconomicIndicators v-if="activeTab === 'econ'" :config="config" />
          <OilGasMarkets v-if="activeTab === 'markets'"   :config="config" />
          <Stocks        v-if="activeTab === 'stocks'"    :config="config" />
          <News          v-if="activeTab === 'news'"      :config="config" />

          <SettingsPanel v-if="activeTab === 'settings'" :key="settingsKey" :config="config" :user="user"
            @save="onSaveConfig"
            @export="onExportConfig"
            @reset="onResetConfig"
            @go-account="activeTab = 'account'"
          />

          <Account v-if="activeTab === 'account'" :user="user"
            @signed-in="onSignedIn"
            @signed-out="onSignedOut"
            @updated="onUserUpdated"
          />
        </template>
      </main>
    </div>
  `,
};

createApp(App).mount('#app');
