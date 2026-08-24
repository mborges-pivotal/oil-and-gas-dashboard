const { ref, reactive, onMounted, computed } = Vue;
import { resolveCIK, fetchFilings, extractFilings, buildFilingUrl, buildIndexUrl, getTranscriptLinks } from '../services/edgar.js';
import { formatDate } from '../utils/formatters.js';

const FORM_TABS = [
  { id: '10-K',    label: '10-K Annual' },
  { id: '10-Q',    label: '10-Q Quarterly' },
  { id: '8-K',     label: '8-K Current' },
  { id: 'DEF 14A', label: 'Proxy' },
  { id: 'transcript', label: 'Transcripts' },
];

const REQUEST_STAGGER_MS = 200; // 200ms between company fetches — well under 10 req/sec

export default {
  name: 'Documents',
  props: ['config'],
  setup(props) {
    // Per-company state: ticker → { loading, error, cik, filings: [], open: bool, activeTab: string }
    const companies = reactive({});
    const globalLoading = ref(true);
    const globalError = ref(null);

    const configuredCompanies = computed(() => props.config.documents?.companies ?? []);

    function ensureCompany(ticker) {
      if (!companies[ticker]) {
        companies[ticker] = {
          loading: true,
          error: null,
          cik: null,
          filings: [],
          open: false,
          activeTab: '10-K',
        };
      }
    }

    async function loadCompany(co, index) {
      const { ticker } = co;
      ensureCompany(ticker);
      if (index > 0) await new Promise(r => setTimeout(r, REQUEST_STAGGER_MS * index));
      try {
        const cik = await resolveCIK(ticker);
        if (!cik) throw new Error(`Ticker "${ticker}" not found in SEC EDGAR`);
        companies[ticker].cik = cik;

        const submissions = await fetchFilings(cik);
        companies[ticker].filings = extractFilings(submissions, ['10-K', '10-Q', '8-K', 'DEF 14A'], 10);
      } catch (e) {
        companies[ticker].error = e.message;
      } finally {
        companies[ticker].loading = false;
      }
    }

    onMounted(async () => {
      globalLoading.value = true;
      globalError.value = null;
      const list = configuredCompanies.value;
      if (list.length === 0) { globalLoading.value = false; return; }

      // Initialize all companies synchronously so the UI shows skeletons immediately
      list.forEach(co => ensureCompany(co.ticker));

      // Load in parallel with index-based stagger to stay under SEC rate limit
      await Promise.all(list.map((co, i) => loadCompany(co, i)));
      globalLoading.value = false;
    });

    function toggleCompany(ticker) {
      if (companies[ticker]) companies[ticker].open = !companies[ticker].open;
    }

    function setTab(ticker, tab) {
      if (companies[ticker]) companies[ticker].activeTab = tab;
    }

    function filingsForTab(ticker, tab) {
      return (companies[ticker]?.filings ?? []).filter(f => f.form === tab);
    }

    return {
      companies, globalLoading, globalError, configuredCompanies,
      toggleCompany, setTab, filingsForTab,
      buildFilingUrl, buildIndexUrl, getTranscriptLinks,
      formatDate, FORM_TABS,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16">
        <div class="section-header" style="margin-bottom:0">Document Collector</div>
        <div class="text-muted text-sm">SEC EDGAR filings + earnings transcripts</div>
      </div>

      <div class="notice" v-if="configuredCompanies.length === 0">
        No companies configured. Add companies in the ⚙ Settings tab.
      </div>

      <div class="notice error" v-if="globalError">{{ globalError }}</div>

      <!-- Company Accordions -->
      <div
        class="accordion-item"
        v-for="co in configuredCompanies"
        :key="co.ticker"
      >
        <!-- Accordion Header -->
        <div
          class="accordion-header"
          :class="{ open: companies[co.ticker]?.open }"
          @click="toggleCompany(co.ticker)"
        >
          <div>
            <span style="margin-right:10px">{{ co.name }}</span>
            <span class="text-muted text-sm">{{ co.ticker }}</span>
            <span v-if="companies[co.ticker]?.cik" class="text-muted text-sm" style="margin-left:8px">
              CIK: {{ companies[co.ticker].cik }}
            </span>
          </div>
          <span class="chevron">▶</span>
        </div>

        <!-- Accordion Body -->
        <div class="accordion-body" v-if="companies[co.ticker]?.open">
          <!-- Loading skeleton -->
          <template v-if="companies[co.ticker]?.loading">
            <div style="padding:16px">
              <div class="skeleton" style="width:60%;height:14px;margin-bottom:8px"></div>
              <div class="skeleton" style="width:40%;height:12px"></div>
            </div>
          </template>

          <!-- Error state -->
          <div class="notice error" style="margin:12px" v-else-if="companies[co.ticker]?.error">
            {{ companies[co.ticker].error }}
          </div>

          <!-- Content -->
          <template v-else>
            <!-- Filing type tabs -->
            <div class="filing-tabs">
              <button
                v-for="tab in FORM_TABS"
                :key="tab.id"
                class="filing-tab"
                :class="{ active: companies[co.ticker]?.activeTab === tab.id }"
                @click.stop="setTab(co.ticker, tab.id)"
              >{{ tab.label }}</button>
            </div>

            <!-- Transcript links tab -->
            <div style="padding:12px 16px" v-if="companies[co.ticker]?.activeTab === 'transcript'">
              <p class="text-muted text-sm" style="margin-bottom:12px">
                No free API exists for earnings transcripts. Links below open external search pages.
              </p>
              <div v-for="link in getTranscriptLinks(co.ticker)" :key="link.url" style="margin-bottom:8px">
                <a :href="link.url" target="_blank" rel="noopener">{{ link.label }}</a>
              </div>
            </div>

            <!-- Filing rows -->
            <div v-else style="padding:4px 0">
              <div v-if="filingsForTab(co.ticker, companies[co.ticker]?.activeTab).length === 0"
                   class="text-muted text-sm" style="padding:16px">
                No {{ companies[co.ticker]?.activeTab }} filings found in recent history.
              </div>
              <table class="data-table" v-else>
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Filed</th>
                    <th>Report Date</th>
                    <th>Document</th>
                    <th>Index</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="filing in filingsForTab(co.ticker, companies[co.ticker]?.activeTab)" :key="filing.accessionNumber">
                    <td style="font-weight:600">{{ filing.form }}</td>
                    <td>{{ filing.filingDate }}</td>
                    <td class="text-muted">{{ filing.reportDate || '—' }}</td>
                    <td>
                      <a
                        v-if="filing.primaryDocument"
                        :href="buildFilingUrl(companies[co.ticker].cik, filing.accessionNumber, filing.primaryDocument)"
                        target="_blank" rel="noopener"
                      >{{ filing.primaryDocument }}</a>
                      <span v-else class="text-muted">—</span>
                    </td>
                    <td>
                      <a
                        :href="buildIndexUrl(companies[co.ticker].cik, filing.accessionNumber)"
                        target="_blank" rel="noopener"
                        class="text-muted text-sm"
                      >View index</a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="configuredCompanies.length">
        Filings sourced from SEC EDGAR (data.sec.gov). No API key required.
        Rate limit: 10 req/sec — requests are staggered automatically.
        Manage companies in ⚙ Settings.
      </div>
    </div>
  `,
};
