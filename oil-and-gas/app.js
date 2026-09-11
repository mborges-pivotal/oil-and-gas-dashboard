import { loadConfig, saveConfig, exportConfig } from './utils/config.js';
import { configureYahooFinance } from './services/yahooFinance.js';
import { getCredentials, verifyLogin, updateCredentials, isSessionAuthed, setSessionAuthed } from './utils/auth.js';

// Lazy-loaded components — imported as strings for Vue CDN defineAsyncComponent pattern
import OilPricesComponent from './components/OilPrices.js';
import GasPricesComponent from './components/GasPrices.js';
import StocksComponent from './components/Stocks.js';
import NewsComponent from './components/News.js';
import DocumentsComponent from './components/Documents.js';
import LoginComponent from './components/Login.js';

const { createApp, ref, reactive, provide, onMounted } = Vue;

// ── Settings Panel component ────────────────────────────────────────────────
const SettingsPanel = {
  emits: ['save', 'export', 'reset', 'logout'],
  props: ['config'],
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

    // Each settings section can be collapsed independently; open by default
    // so existing behavior (everything visible) is unchanged until a user
    // chooses to collapse something.
    const sections = reactive({
      eia: true, refresh: true, proxy: true, crack: true,
      tickers: true, feeds: true, companies: true, admin: true,
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
    function logout() { emit('logout'); }

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

        Object.assign(local, parsed);
        // Configs exported before these settings existed won't have them
        if (!local.yahooFinance) {
          local.yahooFinance = { corsProxy: 'local', localProxyUrl: '/proxy?url=' };
        }
        if (!local.crackSpreadThresholds) {
          local.crackSpreadThresholds = { modestMax: 15, healthyMax: 25, veryStrongMax: 35 };
        }
        importStatus.value = { type: 'success', message: `Imported "${file.name}" — review below, then click Save Changes.` };
      };
      reader.onerror = () => {
        importStatus.value = { type: 'error', message: 'Could not read the file.' };
      };
      reader.readAsText(file);
    }

    // Admin Account — kept entirely separate from `local`/config: it's
    // stored under its own localStorage key so it's never swept up by
    // Export/Import/Reset Config.
    const adminUsername = ref('');
    const newAdminUsername = ref('');
    const currentPassword = ref('');
    const newPassword = ref('');
    const confirmPassword = ref('');
    const adminStatus = ref(null); // { type: 'success'|'error', message }

    onMounted(async () => {
      const creds = await getCredentials();
      adminUsername.value = creds.username;
      newAdminUsername.value = creds.username;
    });

    async function updateAdmin() {
      adminStatus.value = null;

      if (!currentPassword.value) {
        adminStatus.value = { type: 'error', message: 'Enter your current password to confirm this change.' };
        return;
      }
      const ok = await verifyLogin(adminUsername.value, currentPassword.value);
      if (!ok) {
        adminStatus.value = { type: 'error', message: 'Current password is incorrect.' };
        return;
      }
      if (!newAdminUsername.value.trim()) {
        adminStatus.value = { type: 'error', message: 'Username cannot be empty.' };
        return;
      }
      if (newPassword.value || confirmPassword.value) {
        if (newPassword.value.length < 4) {
          adminStatus.value = { type: 'error', message: 'New password must be at least 4 characters.' };
          return;
        }
        if (newPassword.value !== confirmPassword.value) {
          adminStatus.value = { type: 'error', message: 'New passwords do not match.' };
          return;
        }
      }

      const finalPassword = newPassword.value || currentPassword.value;
      await updateCredentials(newAdminUsername.value.trim(), finalPassword);
      adminUsername.value = newAdminUsername.value.trim();
      currentPassword.value = '';
      newPassword.value = '';
      confirmPassword.value = '';
      adminStatus.value = { type: 'success', message: 'Admin account updated.' };
    }

    return {
      local, sections, toggleSection,
      newTicker, addTicker, removeTicker,
      newFeedName, newFeedUrl, addFeed, removeFeed, toggleFeed,
      newCompanyTicker, newCompanyName, addCompany, removeCompany,
      save, exportCfg, reset, logout,
      fileInput, importStatus, triggerImport, onImportFile,
      adminUsername, newAdminUsername, currentPassword, newPassword, confirmPassword,
      adminStatus, updateAdmin,
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
          <button @click="logout">Log Out</button>
        </div>
      </div>

      <div v-if="importStatus" class="notice" :class="{ error: importStatus.type === 'error' }" style="margin-bottom:16px">
        {{ importStatus.type === 'error' ? '✗' : '✓' }} {{ importStatus.message }}
      </div>

      <!-- EIA API Key -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.eia }" @click="toggleSection('eia')">
          <span>EIA API Key</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.eia">
          <p class="text-muted text-sm mb-16" style="margin-bottom:10px">
            Required for Gas Prices tab. Get a free key at
            <a href="https://www.eia.gov/opendata/" target="_blank">eia.gov/opendata</a>.
            The key is stored locally and visible in browser DevTools — this is expected for public EIA keys.
          </p>
          <div class="settings-row">
            <input v-model="local.eiaApiKey" placeholder="Enter your free EIA API key…" style="max-width:400px" />
          </div>
        </div>
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
        </div>
      </div>

      <!-- Documents Companies -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.companies }" @click="toggleSection('companies')">
          <span>Document Collector Companies</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.companies">
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

      <!-- Admin Account -->
      <div class="accordion-item">
        <div class="accordion-header" :class="{ open: sections.admin }" @click="toggleSection('admin')">
          <span>Admin Account</span>
          <span class="chevron">▶</span>
        </div>
        <div class="accordion-body padded" v-if="sections.admin">
          <p class="text-muted text-sm mb-16" style="margin-bottom:10px">
            Changes the username/password for the Settings login on this browser. This is a
            lightweight client-side lock, not real access control — it isn't a substitute for
            keeping this dashboard off a network you don't trust.
          </p>
          <div class="settings-row" style="margin-bottom:8px">
            <label style="display:inline;margin:0;margin-right:8px;width:140px">New username</label>
            <input v-model="newAdminUsername" style="max-width:220px" />
          </div>
          <div class="settings-row" style="margin-bottom:8px">
            <label style="display:inline;margin:0;margin-right:8px;width:140px">New password</label>
            <input v-model="newPassword" type="password" placeholder="Leave blank to keep current password" style="max-width:220px" autocomplete="new-password" />
          </div>
          <div class="settings-row" style="margin-bottom:8px">
            <label style="display:inline;margin:0;margin-right:8px;width:140px">Confirm new password</label>
            <input v-model="confirmPassword" type="password" style="max-width:220px" autocomplete="new-password" />
          </div>
          <div class="settings-row" style="margin-bottom:8px">
            <label style="display:inline;margin:0;margin-right:8px;width:140px">Current password</label>
            <input v-model="currentPassword" type="password" placeholder="Required to confirm" style="max-width:220px" autocomplete="current-password" />
          </div>
          <div class="notice" :class="{ error: adminStatus.type === 'error' }" style="margin-bottom:8px" v-if="adminStatus">
            {{ adminStatus.type === 'error' ? '✗' : '✓' }} {{ adminStatus.message }}
          </div>
          <div class="settings-row">
            <button class="primary" @click="updateAdmin">Update Admin Account</button>
          </div>
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
    Login: LoginComponent,
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
    // Settings tab requires logging in (client-side gate only — see utils/auth.js).
    // Backed by sessionStorage so a page reload within the same tab session
    // doesn't force a re-login, but a new tab/browser session does.
    const settingsAuthed = ref(isSessionAuthed());

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

    function onLoginSuccess() {
      settingsAuthed.value = true;
      setSessionAuthed(true);
    }

    function onLogout() {
      settingsAuthed.value = false;
      setSessionAuthed(false);
    }

    // Provide config to all child components
    provide('config', config);

    return {
      config, configLoaded, activeTab, tabs, saveNotice, settingsKey, settingsAuthed,
      onSaveConfig, onResetConfig, onExportConfig, onLoginSuccess, onLogout,
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

          <template v-if="activeTab === 'settings'">
            <Login v-if="!settingsAuthed" @success="onLoginSuccess" />
            <SettingsPanel v-else :key="settingsKey" :config="config"
              @save="onSaveConfig"
              @export="onExportConfig"
              @reset="onResetConfig"
              @logout="onLogout"
            />
          </template>
        </template>
      </main>
    </div>
  `,
};

createApp(App).mount('#app');
