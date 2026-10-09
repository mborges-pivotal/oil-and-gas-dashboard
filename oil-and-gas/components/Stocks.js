const { ref, shallowRef, reactive, onMounted, onUnmounted, computed, nextTick, watch } = Vue;
import { fetchQuote, fetchChart, fetchKeyStats, fetchTickerNews, searchSymbols, fetchSector, fetchPriceHistory } from '../services/yahooFinance.js';
import { fetchCompanyProfile } from '../services/companyProfile.js';
import { fetchEarnings } from '../services/events.js';
import { fetchBankAccounts, BANK_TYPES } from '../services/bankAccounts.js';
import { estimateNextDividend } from '../utils/dividends.js';
import { PERIODS, computePerformance } from '../utils/performance.js';
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_SHORT, autoCategory, buildSlices, assignSlots, shortSector } from '../utils/allocation.js';
import { fetchWatchlists, createWatchlist, updateWatchlist, deleteWatchlist } from '../services/watchlists.js';
import { resolveCIK, fetchFilings, extractFilings, buildFilingUrl, buildIndexUrl, getTranscriptLinks } from '../services/edgar.js';
import { formatUSD, formatPrice, formatCompactNumber, formatNumber, formatPct, formatPercentLevel, formatVolume, formatDate, formatRelativeTime, changeClass } from '../utils/formatters.js';
import { safeArticleUrl, onArticleClick } from '../utils/articleViewer.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';

// Stock charts also get a 1D (intraday) range; the shared RANGE_OPTIONS
// serve daily/weekly series where a single day doesn't make sense.
const STOCK_RANGE_OPTIONS = [{ id: '1D', label: '1D' }, ...RANGE_OPTIONS];
import HistoryChart from './HistoryChart.js';
import AllocationChart from './AllocationChart.js';
import NoteForm from './NoteForm.js';
import AlertForm from './AlertForm.js';
import TopMovers from './TopMovers.js';
import PortfolioActivity from './PortfolioActivity.js';
import PortfolioOverview from './PortfolioOverview.js';
import DiscoverPortfolios from './DiscoverPortfolios.js';
import { alertsStore, alertsFor, saveAlert, setAlertActive, removeAlert } from '../utils/alertsStore.js';
import { describeAlert, alertPresets, alertStatus, optionAlertPresets, alertSubject } from '../utils/alerts.js';
import { portfolioList, mergePortfolios, emptyPortfolio, summarizePortfolio, DEFAULT_PORTFOLIO_NAME } from '../utils/portfolios.js';
import { suggestPortfolioId, claimPortfolioId, setPortfolioImage, removePortfolioImage } from '../services/portfolios.js';
import ImagePicker from './ImagePicker.js';
import { MULTIPLIER, optionable, occSymbol, parseOcc, optionLabel, daysToExpiry, moneyness, breakeven, nextMonthlyExpiry, nearStrike } from '../utils/options.js';
import { notesStore, findNote, addNote } from '../utils/notesStore.js';

const INDEX_LABELS = {
  '^GSPC': 'S&P 500',
  '^DJI': 'Dow Jones',
  '^IXIC': 'Nasdaq Composite',
  '^RUT': 'Russell 2000',
  '^VIX': 'VIX (Volatility)',
};
// Matches config.json's marketIndexes.symbols — used as a fallback for
// anyone whose localStorage-persisted config predates this field (loadConfig
// only pulls in config.json's *new* top-level fields on a first-ever visit,
// not for a returning visitor who already has a saved config).
const DEFAULT_INDEX_SYMBOLS = Object.keys(INDEX_LABELS);

const FORM_TABS = [
  { id: '10-K',    label: '10-K Annual' },
  { id: '10-Q',    label: '10-Q Quarterly' },
  { id: '8-K',     label: '8-K Current' },
  { id: 'DEF 14A', label: 'Proxy' },
  { id: 'transcript', label: 'Transcripts' },
];

/**
 * Build a minimal inline SVG sparkline from today's intraday prices, with an
 * optional dashed reference line at the previous close. Both are green when
 * the price is at/above the previous close, red when below — the same
 * comparison as the Chg / Chg % columns.
 * Returns an SVG string (safe to use with v-html).
 */
function buildSparklineSVG(closes, { previousClose = null, price = null } = {}, width = 80, height = 30) {
  const vals = closes.filter(v => v != null);
  if (vals.length < 2) return '';
  const hasPrev = previousClose != null;
  // Include the previous close in the scale so its line never falls outside the box.
  const min = Math.min(...vals, ...(hasPrev ? [previousClose] : []));
  const max = Math.max(...vals, ...(hasPrev ? [previousClose] : []));
  const range = max - min || 1;
  const step = width / (vals.length - 1);
  const yFor = v => height - ((v - min) / range) * (height - 4) - 2;
  const points = vals.map((v, i) => {
    const x = i * step;
    const y = yFor(v);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = price ?? vals[vals.length - 1];
  const up = hasPrev ? last >= previousClose : last >= vals[0];
  const color = up ? 'var(--positive)' : 'var(--negative)';
  const prevLine = hasPrev
    ? `<line x1="0" x2="${width}" y1="${yFor(previousClose).toFixed(1)}" y2="${yFor(previousClose).toFixed(1)}"
        stroke="${color}" stroke-width="1" stroke-dasharray="2 2" opacity="0.8"/>`
    : '';
  return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${prevLine}
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// Base window fetched once per ticker; range buttons then filter this
// client-side (same pattern as the Oil & Gas Markets spread/gas history
// charts), so switching ranges doesn't re-hit the API.
const CHART_FETCH_RANGE = '5y';


// Shared by a stock's Portfolio tab ("Options on XOM") and the Portfolio
// page's Options card. Expect `sym` (the stock) in scope; the row also
// `occ` and `inList` (true in the Options card: shows the stock and an Open link).
const OPTION_FORM = `
              <form class="portfolio-form option-form" v-if="optionForms[sym]" @submit.prevent="saveOption(sym)" novalidate
                    @input="optionForms[sym].error = null">
                <div class="option-toggles">
                  <div class="range-btn-group" role="group" aria-label="Buy or sell to open">
                    <button type="button" class="range-btn" :class="{ active: optionForms[sym].side === 'long' }" @click="optionForms[sym].side = 'long'">Buy</button>
                    <button type="button" class="range-btn" :class="{ active: optionForms[sym].side === 'short' }" @click="optionForms[sym].side = 'short'">Sell</button>
                  </div>
                  <div class="range-btn-group" role="group" aria-label="Call or put">
                    <button type="button" class="range-btn" :class="{ active: optionForms[sym].type === 'call' }" @click="optionForms[sym].type = 'call'; onContractChange(sym)">Call</button>
                    <button type="button" class="range-btn" :class="{ active: optionForms[sym].type === 'put' }" @click="optionForms[sym].type = 'put'; onContractChange(sym)">Put</button>
                  </div>
                  <span class="text-muted text-sm">{{ optionForms[sym].side === 'long' ? 'Buy to open — you pay the premium' : 'Sell to open — you collect the premium' }}</span>
                </div>
                <div class="portfolio-fields">
                  <label>
                    <span>Expiration</span>
                    <input type="date" v-model="optionForms[sym].expiry" @input="onContractChange(sym)" />
                  </label>
                  <label>
                    <span>Strike</span>
                    <input type="number" inputmode="decimal" min="0" step="any" v-model="optionForms[sym].strike" @input="onContractChange(sym)" />
                  </label>
                  <label>
                    <span>Contracts</span>
                    <input type="number" inputmode="numeric" min="1" step="1" v-model="optionForms[sym].contracts" />
                  </label>
                  <label>
                    <span>Premium / share</span>
                    <input type="number" inputmode="decimal" min="0" step="any" v-model="optionForms[sym].premium" @input="optionForms[sym].premiumTouched = true" />
                  </label>
                  <label>
                    <span>Date</span>
                    <input type="date" :max="new Date().toLocaleDateString('en-CA')" v-model="optionForms[sym].date" />
                  </label>
                  <label>
                    <span>{{ optionForms[sym].side === 'long' ? 'Pay from' : 'Deposit to' }}</span>
                    <select :value="optionCashFor(sym)" @change="optionForms[sym].cash = $event.target.value; optionForms[sym].error = null">
                      <option v-for="c in cashSources(sym)" :key="c.symbol" :value="c.symbol">{{ c.label }} — {{ formatUSD(c.available) }}</option>
                      <option value="">Outside the portfolio</option>
                    </select>
                  </label>
                </div>
                <!-- Selling to open: covered by shares (call) or secured by reserved cash (put) -->
                <template v-if="coverPreview(sym)">
                <div class="option-cover" v-for="cv in [coverPreview(sym)]" :key="'cover-' + sym">
                  <label class="option-cover-check">
                    <input type="checkbox" :checked="cv.covered" :disabled="cv.locked"
                           @change="optionForms[sym].covered = $event.target.checked; optionForms[sym].error = null" />
                    <span>{{ cv.kind === 'shares' ? 'Covered call' : 'Cash-secured put' }}</span>
                    <span class="text-muted text-sm" v-if="cv.locked">(same as the contracts you already hold)</span>
                  </label>
                  <template v-if="cv.covered">
                    <p class="option-cover-detail" v-if="cv.kind === 'shares'">
                      Covers {{ formatShares(cv.need) }} of your {{ formatShares(cv.held) }} {{ sym }} shares
                      <template v-if="cv.held - cv.free > 0"> ({{ formatShares(cv.held - cv.free) }} already cover other calls)</template>
                      · if called away you receive {{ formatUSD(cv.receive) }}
                      <span class="negative" v-if="!cv.enough"><br />Not enough uncovered shares — {{ formatShares(Math.max(0, cv.free)) }} available.</span>
                    </p>
                    <template v-else>
                      <p class="option-cover-detail">
                        Obligation if assigned {{ formatUSD(cv.obligation) }} · premium collected {{ formatUSD(cv.premium) }}
                        → net cost {{ formatUSD(cv.netCost) }}<template v-if="Number(optionForms[sym].contracts) > 0"> ({{ formatPrice(cv.netCost / (Number(optionForms[sym].contracts) * MULTIPLIER)) }}/share)</template>
                      </p>
                      <div class="portfolio-fields option-cover-fields">
                        <label>
                          <span>Reserve from</span>
                          <select :value="cv.src?.symbol ?? ''" :disabled="cv.locked || !cashSources(sym).length"
                                  @change="optionForms[sym].reserveFrom = $event.target.value; optionForms[sym].error = null">
                            <option v-for="c in cashSources(sym)" :key="c.symbol" :value="c.symbol">{{ c.label }} — {{ formatUSD(c.available) }} available</option>
                            <option v-if="!cashSources(sym).length" value="">No cash holding</option>
                          </select>
                        </label>
                      </div>
                      <p class="option-cover-detail" v-if="cv.src">
                        {{ cv.src.label }}: {{ formatUSD(cv.available) }} available{{ cv.withPremium ? ' (with the premium)' : '' }} → {{ formatUSD(cv.after) }} available ({{ formatUSD(cv.obligation) }} reserved)
                        <span class="negative" v-if="!cv.enough"><br />Not enough available cash to secure this put.</span>
                      </p>
                      <p class="option-cover-detail negative" v-else>Securing a put needs a Cash holding in your portfolio.</p>
                    </template>
                  </template>
                  <p class="option-cover-detail warning-text" v-else>
                    ⚠ Uncovered (naked) — usually needs margin approval; losses on a naked {{ cv.kind === 'shares' ? 'call are unlimited' : 'put can reach the full strike' }}.
                  </p>
                </div>
                </template>
                <p class="option-check" :class="optionForms[sym].check?.state" aria-live="polite">
                  <template v-if="!optionForms[sym].check">Most monthly options expire on the third Friday.</template>
                  <template v-else-if="optionForms[sym].check.state === 'checking'">Checking {{ optionLabel(optionForms[sym].check.symbol) }}…</template>
                  <template v-else-if="optionForms[sym].check.state === 'ok'">
                    ✓ {{ optionLabel(optionForms[sym].check.symbol) }} · last {{ formatPrice(optionForms[sym].check.quote.price) }}<template v-if="optionForms[sym].check.quote.marketTime"> ({{ formatRelativeTime(optionForms[sym].check.quote.marketTime) }})</template>
                  </template>
                  <template v-else>✗ No such contract: {{ optionLabel(optionForms[sym].check.symbol) }} — check the expiration date and strike.</template>
                </p>
                <p class="purchase-preview" v-if="optionPreview(sym)">
                  <template v-for="pv in [optionPreview(sym)]">
                    <span class="negative" v-if="pv.conflict">You're {{ pv.conflict.side }} this contract — close it instead.</span>
                    <template v-else>
                      {{ pv.debit ? 'Cost' : 'Credit' }} {{ formatUSD(pv.amount) }} ({{ optionForms[sym].contracts }} × 100 × {{ formatPrice(Number(optionForms[sym].premium)) }}) ·
                      Breakeven {{ formatPrice(pv.breakeven) }} at expiration
                      <template v-if="pv.was"> · {{ pv.quantity }} contracts at an average of {{ formatPrice(pv.avg) }} (was {{ pv.was.quantity }} at {{ formatPrice(pv.was.avgCost) }})</template>
                      <br />
                      <template v-if="pv.cash">{{ cashName(pv.cash.symbol) }}: {{ formatUSD(pv.cash.available) }} → {{ formatUSD(pv.cash.after) }}<span class="negative" v-if="pv.cash.after < -0.005"> — not enough cash</span></template>
                      <span class="text-muted" v-else>{{ pv.debit ? 'Paid from outside the portfolio.' : 'Not deposited to a cash holding.' }}</span>
                    </template>
                  </template>
                </p>
                <div class="notice error portfolio-error" v-if="optionForms[sym].error">{{ optionForms[sym].error }}</div>
                <div class="portfolio-actions">
                  <button type="submit" class="primary">Add option</button>
                  <button type="button" @click="cancelOption(sym)">Cancel</button>
                </div>
              </form>
`;
const OPTION_ITEM = `
                  <template v-for="o in [optionSummary(occ)]" :key="occ + '-row'">
                  <div class="option-row" :title="optionTitle(o)">
                    <div class="option-id">
                      <span class="option-side" :class="o.side">{{ o.side === 'short' ? 'Short' : 'Long' }}</span>
                      <span class="option-underlying" v-if="inList">{{ o.underlying }}</span>
                      <span class="option-name">{{ o.label }}</span>
                      <span class="option-cover-badge" :class="coverInfo(o).kind" v-if="coverInfo(o)" :title="coverInfo(o).text">{{ coverInfo(o).badge }}</span>
                      <span class="option-money" :class="o.money" v-if="o.money && !o.expired">{{ o.money.toUpperCase() }}</span>
                      <span class="option-days" :class="{ soon: o.days <= 7, expired: o.expired }">{{ o.expired ? 'Expired' : o.days === 0 ? 'Expires today' : o.days + 'd left' }}</span>
                    </div>
                    <div class="option-nums">
                      <span class="stock-row-num"><span class="stock-row-label">Contracts</span><span>{{ o.quantity }}</span></span>
                      <span class="stock-row-num"><span class="stock-row-label">{{ o.side === 'short' ? 'Avg credit' : 'Avg cost' }}</span><span>{{ formatPrice(o.avgCost) }}</span></span>
                      <span class="stock-row-num"><span class="stock-row-label">Last</span><span>{{ o.price != null ? formatPrice(o.price) : (o.loading ? '…' : '—') }}</span></span>
                      <span class="stock-row-num"><span class="stock-row-label">Value</span><span>{{ o.value != null ? formatUSD(o.value) : '—' }}</span></span>
                      <span class="stock-row-num"><span class="stock-row-label">G/L</span>
                        <span :class="changeClass(o.gain)">{{ o.gain != null ? signedUSD(o.gain) + (o.gainPct != null ? ' (' + formatPct(o.gainPct) + ')' : '') : '—' }}</span>
                      </span>
                    </div>
                    <div class="option-actions">
                      <template v-if="portfolioOnly">
                        <button type="button" class="link-button" v-if="o.expired" @click="startClose(occ, { expire: true })">Record expiry</button>
                        <button type="button" class="link-button" v-else @click="startClose(occ)">Close</button>
                      </template>
                      <button type="button" class="link-button" :aria-expanded="optionPanels[occ] === 'alerts'" @click="toggleOptionPanel(occ, 'alerts')">
                        🔔<span class="sr-only"> Alerts</span><template v-if="alertsFor(occ).filter(a => a.active).length"> {{ alertsFor(occ).filter(a => a.active).length }}</template>
                      </button>
                      <button type="button" class="link-button" :aria-expanded="optionPanels[occ] === 'history'" @click="toggleOptionPanel(occ, 'history')">Trades</button>
                      <button type="button" class="link-button" v-if="inList && tickers.includes(o.underlying)" @click="openOptionsOf(o.underlying)">Open {{ o.underlying }}</button>
                      <button type="button" class="link-button danger-link" @click="removeOption(occ)">Remove</button>
                    </div>
                  </div>
                  <p class="text-muted text-sm option-sub">
                    <template v-if="coverInfo(o)">{{ coverInfo(o).text }} · </template>Breakeven {{ formatPrice(o.breakeven) }} · expires {{ formatDate(o.expiry + 'T12:00:00') }}<template v-if="o.marketTime"> · last trade {{ formatRelativeTime(o.marketTime) }}</template><template v-if="o.quoteError"> · no quote</template>
                  </p>

                  <!-- Close: sell to close (long) / buy to close (short); expiry = close at 0 or intrinsic value -->
                  <form class="portfolio-form option-close" v-if="closeForms[occ]" @submit.prevent="saveClose(occ)" novalidate
                        @input="closeForms[occ].error = null">
                    <p class="text-muted text-sm" style="margin:0 0 8px">
                      <template v-if="closeForms[occ].expire">
                        Record that {{ o.label }} expired.
                        <template v-if="o.money === 'itm'">{{ sym }} is in the money now — the premium is prefilled with its intrinsic value; use 0 if it expired worthless. (Exercise and assignment aren't tracked yet.)</template>
                        <template v-else>Out of the money, it expired worthless.</template>
                      </template>
                      <template v-else>{{ o.side === 'short' ? 'Buy to close' : 'Sell to close' }} {{ o.label }} — you have {{ o.quantity }} contract{{ o.quantity === 1 ? '' : 's' }}.</template>
                    </p>
                    <div class="portfolio-fields">
                      <label>
                        <span>Contracts</span>
                        <span class="sale-qty">
                          <input type="number" inputmode="numeric" min="1" step="1" :max="o.quantity" v-model="closeForms[occ].contracts" />
                          <button type="button" class="link-button" @click="closeForms[occ].contracts = String(o.quantity)">All</button>
                        </span>
                      </label>
                      <label>
                        <span>Premium / share</span>
                        <input type="number" inputmode="decimal" min="0" step="any" v-model="closeForms[occ].price" />
                      </label>
                      <label>
                        <span>Date</span>
                        <input type="date" :max="new Date().toLocaleDateString('en-CA')" v-model="closeForms[occ].date" />
                      </label>
                      <label v-if="Number(closeForms[occ].price) > 0">
                        <span>{{ o.side === 'short' ? 'Pay from' : 'Deposit to' }}</span>
                        <select :value="closeCashFor(occ)" @change="closeForms[occ].cash = $event.target.value; closeForms[occ].error = null">
                          <option v-for="c in cashSources(sym)" :key="c.symbol" :value="c.symbol">{{ c.label }} — {{ formatUSD(c.available) }}</option>
                          <option value="">Outside the portfolio</option>
                        </select>
                      </label>
                    </div>
                    <p class="purchase-preview" v-if="closePreview(occ)">
                      <template v-for="cp in [closePreview(occ)]">
                        {{ cp.credit ? 'Proceeds' : 'Cost to close' }} {{ formatUSD(cp.amount) }} ·
                        Realized G/L <span :class="changeClass(cp.realized)">{{ signedUSD(cp.realized) }}<template v-if="cp.realizedPct != null"> ({{ formatPct(cp.realizedPct) }})</template></span> ·
                        <span class="negative" v-if="cp.tooMany">more than you have</span>
                        <strong v-else-if="cp.closes">closes the position (moves to Closed positions)</strong>
                        <template v-else>{{ cp.remaining }} contract{{ cp.remaining === 1 ? '' : 's' }} left</template>
                        <template v-if="cp.cash"><br />{{ cashName(cp.cash.symbol) }}: {{ formatUSD(cp.cash.available) }} → {{ formatUSD(cp.cash.after) }}</template>
                      </template>
                    </p>
                    <div class="notice error portfolio-error" v-if="closeForms[occ].error">{{ closeForms[occ].error }}</div>
                    <div class="portfolio-actions">
                      <button type="submit" class="primary">{{ closeForms[occ].expire ? 'Record expiry' : 'Record close' }}</button>
                      <button type="button" @click="cancelClose(occ)">Cancel</button>
                    </div>
                  </form>

                  <!-- This contract's alerts (premium, gain/loss, days to expiry, in/out of the money) -->
                  <div class="option-panel" v-else-if="optionPanels[occ] === 'alerts'">
                    <AlertForm v-if="alertForms[occ]" :symbol="occ" :quote="optionQuotes[occ]" :avg-cost="o.avgCost"
                               :option="{ ...o, short: o.side === 'short' }" :underlying-price="stockQuotes[sym]?.price ?? null"
                               :initial="alertForms[occ].initial" :submit-label="alertForms[occ].alertId ? 'Save changes' : 'Create alert'"
                               :busy="alertForms[occ].busy" :error="alertForms[occ].error"
                               @save="submitAlert(occ, $event)" @cancel="closeAlertForm(occ)" />
                    <template v-else>
                      <div class="alert-presets">
                        <span class="alert-presets-label">Quick add</span>
                        <button type="button" class="note-chip" v-for="pr in optionAlertPresets({ short: o.side === 'short', covered: !!o.covered })" :key="pr.label"
                                @click.stop="openAlertForm(occ, pr)">{{ pr.label }}</button>
                        <button type="button" class="note-chip alert-custom" @click.stop="openAlertForm(occ, { kind: 'price', params: { direction: 'above', basis: 'percent', percent: 25 } })">＋ Custom</button>
                      </div>
                      <ul class="alert-list" v-if="alertsFor(occ).length">
                        <li v-for="a in alertsFor(occ)" :key="a.id" class="alert-item" :class="{ inactive: !a.active }">
                          <span class="alert-dot" :class="a.active ? 'on' : 'off'" aria-hidden="true"></span>
                          <div class="alert-item-body">
                            <div class="alert-item-title">{{ describeAlert(a) }}</div>
                            <div class="text-muted text-sm">{{ alertStatus(a) }} · {{ a.repeat === 'daily' ? 'every day' : 'once' }}</div>
                            <div class="alert-item-note" v-if="a.note">{{ a.note }}</div>
                            <div class="notice error" v-if="a._error" style="margin:4px 0 0">{{ a._error }}</div>
                          </div>
                          <div class="alert-item-actions">
                            <button type="button" class="link-button" @click.stop="openAlertForm(occ, a, a.id)">Edit</button>
                            <button type="button" class="link-button" @click.stop="toggleAlert(a)">
                              {{ a.active ? 'Pause' : (a.repeat === 'once' && a.lastTriggeredAt ? 'Re-arm' : 'Resume') }}
                            </button>
                            <button type="button" class="link-button danger-link" @click.stop="deleteAlertConfirm(a)">Delete</button>
                          </div>
                        </li>
                      </ul>
                      <p class="text-muted text-sm alert-empty" v-else>No alerts on this contract yet — triggered alerts arrive in <strong>Inbox → Alerts</strong>.</p>
                    </template>
                  </div>

                  <!-- This contract's trades -->
                  <div class="transactions option-panel" v-else-if="optionPanels[occ] === 'history'">
                    <table class="data-table transactions-table">
                      <thead>
                        <tr><th>Date</th><th class="num">Contracts</th><th class="num">Premium</th><th class="num tx-amount">Amount</th><th class="num">Realized</th><th><span class="sr-only">Delete</span></th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="tx in optionTransactions(occ)" :key="tx.id">
                          <td>
                            {{ formatDate(tx.date + 'T12:00:00') }}
                            <div class="tx-from">
                              {{ tx.type === 'close' ? (tx.expired ? 'Expired' : o.side === 'short' ? 'Buy to close' : 'Sell to close') : (o.side === 'short' ? 'Sell to open' : 'Buy to open') }}<template v-if="tx.cash"> · {{ tx.cashDir === 'out' ? 'from' : 'to' }} {{ cashName(tx.cash) }}</template>
                            </div>
                          </td>
                          <td class="num" :class="tx.type === 'close' ? 'negative' : ''">{{ (tx.type === 'close' ? '−' : '+') + tx.quantity }}</td>
                          <td class="num">{{ formatPrice(tx.price) }}</td>
                          <td class="num tx-amount">{{ formatUSD(tx.quantity * (o.multiplier ?? MULTIPLIER) * tx.price) }}</td>
                          <td class="num" :class="tx.type === 'close' ? changeClass(tx.realized) : ''">{{ tx.type === 'close' ? signedUSD(tx.realized) : '' }}</td>
                          <td class="num">
                            <button type="button" class="link-button danger-link" :aria-label="'Delete trade on ' + tx.date" title="Delete this trade"
                                    @click="deleteOptionTransaction(occ, tx)">✕</button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  </template>
`;

// The list picker for copying / moving stocks between watchlists (edit mode).
const TRANSFER_PICKER = `
        <div class="wl-transfer-backdrop" @click.stop="closeTransfer" @pointerdown.stop></div>
        <div class="wl-transfer" role="dialog" aria-label="Copy or move to another watchlist"
             @click.stop @pointerdown.stop @keydown.esc="closeTransfer">
          <div class="wl-transfer-head">
            <strong>{{ transfer.symbols.length === 1 ? transfer.symbols[0] : transfer.symbols.length + ' stocks' }}</strong>
            <button type="button" class="link-button" aria-label="Close" @click="closeTransfer">✕</button>
          </div>
          <template v-for="mode in (transfer.mode ? [transfer.mode] : ['copy', 'move'])" :key="mode">
            <div class="wl-transfer-label">{{ mode === 'copy' ? 'Copy to' : 'Move to' }}</div>
            <button v-for="l in transferTargets(transfer.symbols)" :key="mode + '-' + l.id" type="button" class="wl-transfer-item"
                    :disabled="transfer.busy || !l.fits || (mode === 'copy' && l.all)" @click="doTransfer(l.id, mode)">
              <span class="wl-transfer-name">{{ l.name }}</span>
              <span class="wl-transfer-note">{{ l.all ? '✓ already' : !l.fits ? 'full' : l.have ? l.have + ' already' : l.tickers.length + ' stock' + (l.tickers.length === 1 ? '' : 's') }}</span>
            </button>
          </template>
          <div class="wl-transfer-new">
            <button type="button" class="link-button" v-if="!transfer.creating" :disabled="transfer.busy" @click="transfer.creating = true">＋ New list…</button>
            <form v-else @submit.prevent="createAndTransfer(transfer.mode || 'copy')" novalidate>
              <input v-model="transfer.newName" maxlength="40" placeholder="New list name" aria-label="New list name"
                     @input="transfer.error = null" />
              <div class="wl-transfer-new-actions">
                <button type="submit" class="primary" :disabled="transfer.busy">{{ (transfer.mode || 'copy') === 'move' ? 'Create & move' : 'Create & copy' }}</button>
                <button type="button" v-if="!transfer.mode" :disabled="transfer.busy" @click="createAndTransfer('move')">Create & move</button>
              </div>
            </form>
          </div>
          <div class="notice error wl-transfer-error" v-if="transfer.error">{{ transfer.error }}</div>
        </div>
`;

export default {
  name: 'Stocks',
  components: { HistoryChart, AllocationChart, NoteForm, AlertForm, TopMovers, PortfolioActivity, PortfolioOverview, ImagePicker, DiscoverPortfolios },
  // portfolioOnly: render as the top-level Portfolio page (app.js) — just
  // the stocks you hold a position in, with totals; no indexes or list picker.
  // startTab: the Account sub-tab to open on (else the last one used).
  // discoverQuery: a forwarded portfolio link's @id, searched in Portfolios → Discover.
  // startShare: open Transactions in "Share update" mode (from Inbox → Activity).
  props: {
    config: Object, user: Object, portfolioOnly: Boolean, startTab: { type: String, default: null },
    discoverQuery: { type: String, default: null }, startShare: Boolean,
  },
  // set-tickers: new order/contents for the default watchlist (config.stocks.tickers)
  // set-position: { symbol, position: { quantity, avgCost, category?, transactions? } | null }
  //   or { updates: { SYMBOL: position | null } } to save several together — for config.portfolio
  // go-notes: open the Notes tab (from a news item already saved there)
  // go-activity: open Inbox → Activity (tab: 'you' | 'following')
  emits: ['set-tickers', 'set-position', 'move-position', 'set-portfolios', 'set-account-cash', 'updated', 'go-account', 'go-notes', 'go-bank-accounts', 'go-activity'],
  setup(props, { emit }) {
    const configTickers = computed(() => props.config.stocks?.tickers ?? []);

    // ── Watchlists ──────────────────────────────────────────────────────────
    // 'default' is config.stocks.tickers — part of the dashboard settings, so
    // it works signed out (and is still editable in ⚙ Settings). Signed-in
    // users can add named lists, stored only in the DB (services/watchlists.js).
    const MAX_LIST_TICKERS = 50; // matches server/watchlists.js
    const LIST_STORAGE_KEY = 'oilgas_watchlist';
    const customLists = ref([]);
    const listsLoading = ref(false);
    const listsError = ref(null);
    const activeListId = ref(readSavedListId());
    const activeList = computed(() =>
      customLists.value.find(l => String(l.id) === activeListId.value) ?? null
    );
    // ── Portfolios (config.portfolios — see utils/portfolios.js) ──
    // The Account page (portfolioOnly) has sub-tabs Summary · Portfolios ·
    // Transactions; under Portfolios, a card per portfolio, and an opened one
    // shows its holdings, options and closed positions. On Markets, each
    // stock's Portfolio tab works in one portfolio at a time, chosen there.
    const portfolios = computed(() => portfolioList(props.config));
    const allPf = computed(() => mergePortfolios(portfolios.value));
    const portfolioById = id => portfolios.value.find(p => p.id === id) ?? null;

    const PORTFOLIO_TABS = [
      { id: 'summary',    label: 'Summary' },
      { id: 'portfolios', label: 'Portfolios' },
      { id: 'activity',   label: 'Transactions' }, // id kept: a remembered tab still opens it
    ];
    const PF_TAB_KEY = 'oilgas_portfolio_tab';
    const pfTab = ref((() => {
      try {
        const saved = localStorage.getItem(PF_TAB_KEY);
        if (props.startTab && PORTFOLIO_TABS.some(t => t.id === props.startTab)) return props.startTab;
        if (saved === 'positions') return 'portfolios'; // renamed
        if (saved === 'leaderboard') return 'summary'; // moved to the top bar
        if (PORTFOLIO_TABS.some(t => t.id === saved)) return saved;
      } catch { /* none saved */ }
      return 'summary';
    })());
    watch(pfTab, t => { try { localStorage.setItem(PF_TAB_KEY, t); } catch { /* per-browser only */ } }, { immediate: !!props.startTab });
    const openPfId = ref(null); // the portfolio opened from its card
    const openPf = computed(() => (props.portfolioOnly && pfTab.value === 'portfolios' && openPfId.value ? portfolioById(openPfId.value) : null));
    // What the Account page shows: an opened portfolio, else all of them combined.
    const viewPf = computed(() => openPf.value ?? allPf.value);
    // Holdings / Options / Closed positions (and their quotes) — inside an opened portfolio.
    const onPositions = computed(() => !props.portfolioOnly || !!openPf.value);
    watch(pfTab, () => { openPfId.value = null; });
    // Sent to a sub-tab while Account is already open (a forwarded link, Inbox → Share update).
    watch(() => props.startTab, t => { if (t && PORTFOLIO_TABS.some(x => x.id === t)) pfTab.value = t; });

    // Markets → a stock's Portfolio tab: which portfolio it's working in.
    // { id } or { id: null, newName } for "＋ New portfolio" (created on the first save).
    const pfChoice = reactive({});
    const LAST_PF_KEY = 'oilgas_last_portfolio';
    function holdsIn(pf, ticker) {
      return !!(pf.portfolio?.[ticker]?.quantity > 0
        || Object.values(pf.optionPositions ?? {}).some(o => o?.quantity > 0 && o.underlying === ticker));
    }
    function defaultPfId(ticker) {
      const list = portfolios.value;
      const holding = list.find(pf => holdsIn(pf, ticker));
      if (holding) return holding.id;
      let last = null;
      try { last = localStorage.getItem(LAST_PF_KEY); } catch { /* none */ }
      return (list.find(p => p.id === last) ?? list[0])?.id ?? null;
    }
    // The portfolio a stock's positions are read from and saved to.
    function pfFor(ticker) {
      if (props.portfolioOnly) return viewPf.value;
      const c = pfChoice[ticker];
      if (c && c.id === null) return { ...emptyPortfolio(c.newName ?? '', null), pending: true };
      const pf = portfolioById(c?.id ?? defaultPfId(ticker));
      return pf ?? { ...emptyPortfolio(DEFAULT_PORTFOLIO_NAME, null), pending: true };
    }
    function choosePortfolio(ticker, value) {
      if (value === '__new') pfChoice[ticker] = { id: null, newName: '' };
      else {
        pfChoice[ticker] = { id: value };
        try { localStorage.setItem(LAST_PF_KEY, value); } catch { /* per-browser only */ }
      }
      // Nothing held there yet: straight to "add a purchase".
      if (!positionFor(ticker) && !optionsFor(ticker).length && !positionForms[ticker]) startPurchase(ticker);
    }
    // Where a save goes: the stock's portfolio, creating it first when it's new
    // (its ID — derived from the name, unique across accounts — comes from the server).
    async function pfTarget(ticker) {
      const pf = pfFor(ticker);
      if (pf.id) return { portfolioId: pf.id };
      const name = (pf.name || '').trim().replace(/\s+/g, ' ').slice(0, 40) || DEFAULT_PORTFOLIO_NAME;
      const id = await claimPortfolioId(name);
      if (!props.portfolioOnly) {
        pfChoice[ticker] = { id };
        try { localStorage.setItem(LAST_PF_KEY, id); } catch { /* per-browser only */ }
      }
      return { portfolioId: id, newPortfolio: { id, name } };
    }
    function newPortfolioNameError(ticker) {
      const pf = pfFor(ticker);
      if (!pf.pending) return null;
      const name = (pf.name || '').trim() || DEFAULT_PORTFOLIO_NAME;
      return portfolios.value.some(p => p.name.toLowerCase() === name.toLowerCase()) ? `You already have a portfolio named "${name}".` : null;
    }
    const pfError = ref(null); // a new portfolio couldn't be created (its ID)
    async function emitPosition(ticker, payload) {
      pfError.value = null;
      try {
        emit('set-position', { ...withCash(payload), ...(await pfTarget(ticker)) });
      } catch (e) {
        pfError.value = `Couldn't create the portfolio: ${e.message}. Nothing was saved.`;
      }
    }

    // Account → Portfolios: create, rename, delete; each card's headline numbers.
    const pfForm = ref(null); // { mode: 'create' | 'edit', name, visibility, id…, error }
    // Creating: the ID fills in from the name (the server's suggestion — unique
    // across accounts) until you edit it; edited, it's checked as you type.
    // Renaming keeps the ID.
    // mode: 'create' | 'edit' (name and visibility; the ID never changes).
    // Public portfolios appear on the Leaderboard (top bar): name, your display name, return %.
    function openPfForm(mode) {
      const cur = mode === 'edit' ? openPf.value : null;
      pfForm.value = {
        mode, name: cur?.name ?? '', visibility: cur?.visibility === 'public' ? 'public' : 'private',
        image: null, // create: a picked picture (data URL), uploaded once the portfolio has its ID
        id: '', idEdited: false, idState: null, busy: false, error: null,
      };
    }
    let idTimer = null;
    function onPfFormInput(field) {
      const f = pfForm.value;
      if (!f || f.mode !== 'create') return;
      f.error = null;
      if (field === 'id') {
        f.idEdited = true;
        f.id = f.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').slice(0, 40);
      }
      f.idState = 'checking';
      clearTimeout(idTimer);
      idTimer = setTimeout(async () => {
        if (pfForm.value !== f) return;
        try {
          const r = await suggestPortfolioId(f.name, f.idEdited ? f.id : '');
          if (pfForm.value !== f) return;
          if (!f.idEdited) { f.id = r.id; f.idState = 'ok'; }
          else f.idState = !f.id ? null : !r.valid ? 'invalid' : r.available ? 'ok' : { taken: true, suggestion: r.id === f.id ? null : r.id };
          if (f.idEdited && r.available === false) f.idState = { taken: true, suggestion: null };
        } catch { f.idState = null; }
      }, 300);
    }
    async function submitPfForm() {
      const f = pfForm.value;
      const name = f.name.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!name) { f.error = 'Name the portfolio.'; return; }
      const others = portfolios.value.filter(p => f.mode === 'create' || p.id !== openPf.value?.id);
      if (others.some(p => p.name.toLowerCase() === name.toLowerCase())) { f.error = `You already have a portfolio named "${name}".`; return; }
      if (f.mode === 'edit') {
        emit('set-portfolios', portfolios.value.map(p => (p.id === openPf.value.id ? { ...p, name, visibility: f.visibility } : p)));
        pfForm.value = null;
        return;
      }
      f.busy = true;
      try {
        const id = await claimPortfolioId(name, f.idEdited ? f.id : '');
        let image = null;
        if (f.image) {
          try {
            image = await setPortfolioImage(id, f.image);
          } catch (e) {
            // The portfolio is still worth creating; the picture can be added with Edit.
            pfImageError.value = `The portfolio was created, but its picture couldn't be saved: ${e.message}`;
          }
        }
        emit('set-portfolios', [...portfolios.value, { ...emptyPortfolio(name, id), visibility: f.visibility, ...(image ? { image } : {}) }]);
        pfForm.value = null;
      } catch (e) {
        f.error = e.message + (e.suggestion ? ` — try "${e.suggestion}".` : '');
        if (e.suggestion) { f.id = e.suggestion; f.idEdited = true; f.idState = 'ok'; }
        f.busy = false;
      }
    }
    // A portfolio's picture (Edit): saved on the server, its URL kept on the portfolio.
    const pfImageBusy = ref(false);
    const pfImageError = ref(null);
    async function changePortfolioImage(dataUrl) {
      const pf = openPf.value;
      if (!pf) return;
      pfImageBusy.value = true;
      pfImageError.value = null;
      try {
        const url = await setPortfolioImage(pf.id, dataUrl);
        emit('set-portfolios', portfolios.value.map(p => (p.id === pf.id ? { ...p, image: url } : p)));
      } catch (e) {
        pfImageError.value = `Couldn't save the picture: ${e.message}`;
      } finally {
        pfImageBusy.value = false;
      }
    }
    async function clearPortfolioImage() {
      const pf = openPf.value;
      if (!pf || !confirm(`Remove the picture from "${pf.name}"?`)) return;
      pfImageBusy.value = true;
      pfImageError.value = null;
      try {
        await removePortfolioImage(pf.id);
        emit('set-portfolios', portfolios.value.map(p => (p.id === pf.id ? { ...p, image: null } : p)));
      } catch (e) {
        pfImageError.value = `Couldn't remove the picture: ${e.message}`;
      } finally {
        pfImageBusy.value = false;
      }
    }
    const pfInitials = name => ((name || '').trim().split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('') || '?').toUpperCase();

    function deletePortfolio() {
      const pf = openPf.value;
      if (!pf) return;
      const n = Object.values(pf.portfolio ?? {}).filter(p => p?.quantity > 0).length + openOptionsIn(pf).length;
      const closed = (pf.closedPositions ?? []).length;
      const what = [n && `${n} open position${n === 1 ? '' : 's'}`, closed && `${closed} closed`].filter(Boolean).join(' and ');
      if (!confirm(`Delete the "${pf.name}" portfolio${what ? ` and its ${what}` : ''}? This can't be undone.`)) return;
      emit('set-portfolios', portfolios.value.filter(p => p.id !== pf.id));
      openPfId.value = null;
    }
    const quoteOf = sym => (parseOcc(sym.split('#')[0]) ? optionQuotes[sym.split('#')[0]] : stockQuotes[sym]);
    const pfMetrics = pf => summarizePortfolio(pf, quoteOf, (sym, p) => (p.category || autoCategoryFor(sym)) === 'cash');

    // The Account page's holdings: every stock with a position in the
    // portfolio being shown (or in any portfolio, combined), in the order added.
    const portfolioTickers = computed(() =>
      Object.entries(viewPf.value.portfolio ?? {})
        .filter(([, p]) => p?.quantity > 0)
        .map(([sym]) => sym)
    );
    const isPortfolioList = computed(() => props.portfolioOnly);
    // Default has no Portfolio tab; your own lists and the Portfolio list do.

    // The Portfolio page's sorted order — a computed defined with the sort
    // controls further down (watches here read activeTickers right away).
    const holdingsOrder = shallowRef(null);

    // While a remembered custom list is still loading, show nothing rather
    // than flashing the default list's cards.
    const activeTickers = computed(() => {
      if (isPortfolioList.value) return holdingsOrder.value ? holdingsOrder.value.value : portfolioTickers.value;
      if (activeList.value) return activeList.value.tickers;
      if (activeListId.value !== 'default' && listsLoading.value) return [];
      return configTickers.value;
    });

    function readSavedListId() {
      let id = 'default';
      try { id = localStorage.getItem(LIST_STORAGE_KEY) || 'default'; } catch { /* ignore */ }
      // 'portfolio' was once a choice in the picker; it's its own page now.
      return id === 'portfolio' ? 'default' : id;
    }
    watch(activeListId, id => {
      if (props.portfolioOnly) return;
      try { localStorage.setItem(LIST_STORAGE_KEY, id); } catch { /* per-browser convenience only */ }
    });

    async function loadLists() {
      listsError.value = null;
      if (!props.user) {
        customLists.value = [];
        activeListId.value = 'default';
        return;
      }
      listsLoading.value = true;
      try {
        customLists.value = await fetchWatchlists();
      } catch (e) {
        customLists.value = [];
        listsError.value = `Couldn't load your watchlists: ${e.message}`;
      } finally {
        listsLoading.value = false;
      }
      if (!activeList.value) activeListId.value = 'default';
    }
    // Loaded on the Portfolio page too: Top movers can rank any watchlist.
    watch(() => props.user?.id ?? null, loadLists, { immediate: true });

    function selectList(id) {
      activeListId.value = String(id);
      editMode.value = false;
      listForm.value = null;
    }

    // Saves a new ticker array for whichever list is showing.
    async function saveTickers(order) {
      if (isPortfolioList.value) return; // derived from positions — nothing to save
      const list = activeList.value;
      if (!list) {
        // Parent updates config synchronously, so the list never snaps back.
        emit('set-tickers', order);
        return;
      }
      const previous = list.tickers;
      list.tickers = order; // optimistic — reverted below if the save fails
      try {
        list.tickers = (await updateWatchlist(list.id, { tickers: order })).tickers;
      } catch (e) {
        list.tickers = previous;
        listsError.value = `Couldn't save "${list.name}": ${e.message}`;
      }
    }

    // Create / rename form, and delete.
    const listForm = ref(null); // { mode: 'create' | 'rename', name, busy, error }
    const listNameInput = ref(null);
    function openListForm(mode) {
      listForm.value = { mode, name: mode === 'rename' ? activeList.value.name : '', busy: false, error: null };
      nextTick(() => listNameInput.value?.focus());
    }
    async function submitListForm() {
      const f = listForm.value;
      if (!f || f.busy) return;
      f.busy = true;
      f.error = null;
      try {
        if (f.mode === 'create') {
          const created = await createWatchlist(f.name);
          customLists.value.push(created);
          selectList(created.id);
        } else {
          const updated = await updateWatchlist(activeList.value.id, { name: f.name });
          activeList.value.name = updated.name;
          listForm.value = null;
        }
      } catch (e) {
        f.error = e.message;
        f.busy = false;
      }
    }
    async function deleteActiveList() {
      const list = activeList.value;
      if (!list || !confirm(`Delete the "${list.name}" watchlist? This can't be undone.`)) return;
      try {
        await deleteWatchlist(list.id);
        customLists.value = customLists.value.filter(l => l.id !== list.id);
        selectList('default');
      } catch (e) {
        listsError.value = `Couldn't delete "${list.name}": ${e.message}`;
      }
    }

    // ── ☰ watchlist menu: search, edit, new / rename / delete list ──
    const wlMenuOpen = ref(false);
    const wlMenuRoot = ref(null);
    const wlMenuButton = ref(null);
    const wlMenu = ref(null);
    const searchVisible = ref(false);
    const searchInput = ref(null);

    function wlMenuItems() {
      return [...(wlMenu.value?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];
    }
    function closeWlMenu({ refocus = false } = {}) {
      wlMenuOpen.value = false;
      if (refocus) wlMenuButton.value?.focus();
    }
    function onDocPointerDown(e) {
      if (!wlMenuRoot.value?.contains(e.target)) closeWlMenu();
    }
    watch(wlMenuOpen, open => {
      if (open) {
        document.addEventListener('pointerdown', onDocPointerDown);
        nextTick(() => wlMenuItems()[0]?.focus());
      } else {
        document.removeEventListener('pointerdown', onDocPointerDown);
      }
    });
    onUnmounted(() => document.removeEventListener('pointerdown', onDocPointerDown));

    function onWlMenuButtonKeydown(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        wlMenuOpen.value = true;
      }
    }
    function onWlMenuKeydown(e) {
      const list = wlMenuItems();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeWlMenu({ refocus: true }); }
      else if (e.key === 'Tab') closeWlMenu();
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    }

    function menuAction(action) {
      closeWlMenu();
      if (action === 'edit') editMode.value = !editMode.value;
      else if (action === 'new') openListForm('create');
      else if (action === 'rename') openListForm('rename');
      else if (action === 'delete') deleteActiveList();
      else if (action === 'signin') emit('go-account');
    }

    const searchShown = computed(() =>
      !isPortfolioList.value && (searchVisible.value || (!tickers.value.length && !listsLoading.value))
    );
    function openSearch() {
      searchVisible.value = true;
      nextTick(() => searchInput.value?.focus());
    }
    function closeSearch() {
      searchQuery.value = '';
      searchVisible.value = false;
    }

    // Edit mode: a remove button on each card; signed in, also ⇄ copy/move
    // and checkboxes for doing several stocks at once.
    const editMode = ref(false);
    function removeTicker(sym) {
      saveTickers(activeTickers.value.filter(t => t !== sym));
    }

    // ── Copy / move stocks to another watchlist (edit mode, signed in) ──
    // Destinations are Default (settings) and your lists (DB). Stocks land
    // at the end of the destination; a move removes them from this list.
    // Notes, alerts and positions belong to the stock, so they're untouched.
    const selected = ref([]); // checked stocks, in list order
    watch([editMode, activeListId], () => { selected.value = []; closeTransfer(); });
    watch(activeTickers, list => { selected.value = selected.value.filter(s => list.includes(s)); });
    const isSelected = sym => selected.value.includes(sym);
    function toggleSelected(sym) {
      selected.value = isSelected(sym) ? selected.value.filter(s => s !== sym) : activeTickers.value.filter(t => t === sym || isSelected(t));
    }
    const allSelected = computed(() => tickers.value.length > 0 && selected.value.length === tickers.value.length);
    function selectAll() { selected.value = [...activeTickers.value]; }
    function clearSelected() { selected.value = []; }
    function removeSelected() {
      const syms = selected.value;
      if (!syms.length) return;
      const before = [...activeTickers.value];
      const listId = activeListId.value;
      saveTickers(activeTickers.value.filter(t => !syms.includes(t)));
      selected.value = [];
      showTransferToast(`Removed ${syms.join(', ')}`, async () => {
        const current = listTickers(listId) ?? [];
        await setListTickers(listId, restoreOrder(before, current, syms));
      });
    }

    const allLists = computed(() => [
      { id: 'default', name: 'Default', tickers: configTickers.value },
      ...customLists.value.map(l => ({ id: String(l.id), name: l.name, tickers: l.tickers, limited: true })),
    ]);
    const listTickers = id => allLists.value.find(l => l.id === String(id))?.tickers ?? null;
    // Any list's tickers (not just the one showing); throws if the save fails.
    async function setListTickers(id, list) {
      if (String(id) === 'default') {
        emit('set-tickers', list);
        return;
      }
      const target = customLists.value.find(l => String(l.id) === String(id));
      if (!target) throw new Error('That watchlist no longer exists');
      const previous = target.tickers;
      target.tickers = list;
      try {
        target.tickers = (await updateWatchlist(target.id, { tickers: list })).tickers;
      } catch (e) {
        target.tickers = previous;
        throw e;
      }
    }
    // Put moved-away stocks back where they were, keeping any other changes since.
    function restoreOrder(before, current, syms) {
      const back = before.filter(t => current.includes(t) || syms.includes(t));
      return [...back, ...current.filter(t => !before.includes(t))];
    }

    // The list picker: per card (Copy to / Move to) or for the selection (one mode).
    const transfer = ref(null); // { symbols, mode: null | 'copy' | 'move', anchor, newName, creating, busy, error }
    function openTransfer(symbols, mode, anchor) {
      if (!symbols.length) return;
      transfer.value = { symbols: [...symbols], mode, anchor, newName: '', creating: false, busy: false, error: null };
    }
    function closeTransfer() { transfer.value = null; }
    // Each other list, with how many of these stocks it already has and its room left.
    function transferTargets(symbols) {
      return allLists.value.filter(l => l.id !== String(activeListId.value)).map(l => {
        const have = symbols.filter(s => l.tickers.includes(s)).length;
        const room = l.limited ? MAX_LIST_TICKERS - l.tickers.length : Infinity;
        return { ...l, have, room, all: have === symbols.length, fits: symbols.length - have <= room };
      });
    }

    async function doTransfer(destId, mode, { name } = {}) {
      const t = transfer.value;
      if (!t || t.busy) return;
      const symbols = t.symbols;
      const srcId = String(activeListId.value);
      t.busy = true;
      t.error = null;
      let destName = name;
      let added = [];
      let createdId = null;
      try {
        if (destId === 'new') {
          const created = await createWatchlist(name, symbols);
          customLists.value.push(created);
          destId = String(created.id);
          createdId = created.id;
          destName = created.name;
          added = [...symbols];
        } else {
          const dest = allLists.value.find(l => l.id === String(destId));
          destName = dest.name;
          added = symbols.filter(s => !dest.tickers.includes(s));
          if (dest.limited && dest.tickers.length + added.length > MAX_LIST_TICKERS) {
            throw new Error(`${dest.name} has room for ${Math.max(0, MAX_LIST_TICKERS - dest.tickers.length)} more (${MAX_LIST_TICKERS} max)`);
          }
          if (added.length) await setListTickers(destId, [...dest.tickers, ...added]);
        }
      } catch (e) {
        t.error = e.message;
        t.busy = false;
        return;
      }
      const before = [...(listTickers(srcId) ?? [])];
      if (mode === 'move') {
        try {
          await setListTickers(srcId, before.filter(s => !symbols.includes(s)));
        } catch (e) {
          // The copy went through — nothing is lost, it's just in both lists.
          listsError.value = `Copied to ${destName}, but couldn't remove from this list: ${e.message}`;
          transfer.value = null;
          return;
        }
      }
      transfer.value = null;
      selected.value = [];
      const skipped = symbols.length - added.length;
      const verb = mode === 'move' ? 'Moved' : 'Copied';
      const msg = `${verb} ${symbols.join(', ')} to ${destName}` + (skipped && destId !== 'new' ? ` (${skipped} already there)` : '');
      showTransferToast(msg, async () => {
        const destNow = listTickers(destId);
        if (createdId != null) {
          await deleteWatchlist(createdId); // undoing "＋ New list" removes that list
          customLists.value = customLists.value.filter(l => l.id !== createdId);
        } else if (destNow) await setListTickers(destId, destNow.filter(s => !added.includes(s)));
        if (mode === 'move') await setListTickers(srcId, restoreOrder(before, listTickers(srcId) ?? [], symbols));
      });
    }
    function createAndTransfer(mode) {
      const t = transfer.value;
      const name = t.newName.trim();
      if (!name) { t.error = 'Name the new list.'; return; }
      doTransfer('new', mode, { name });
    }

    // "Moved XOM to Refiners · Undo" — for a few seconds after each change.
    const transferToast = ref(null); // { message, undo, busy, error }
    let toastTimer = null;
    function showTransferToast(message, undo) {
      clearTimeout(toastTimer);
      transferToast.value = { message, undo, busy: false, error: null };
      toastTimer = setTimeout(() => { transferToast.value = null; }, 10000);
    }
    async function undoTransfer() {
      const t = transferToast.value;
      if (!t || t.busy) return;
      t.busy = true;
      clearTimeout(toastTimer);
      try {
        await t.undo();
        transferToast.value = null;
      } catch (e) {
        t.busy = false;
        t.error = `Couldn't undo: ${e.message}`;
      }
    }

    // ── Stock search (adds to the watchlist that's showing) ──
    const searchQuery = ref('');
    const searchResults = ref([]);
    const searchLoading = ref(false);
    const searchError = ref(null);
    const searchOpen = ref(false);
    const searchIndex = ref(-1);
    const justAdded = ref(null);
    let searchTimer = null;
    let searchSeq = 0;

    watch(searchQuery, q => {
      clearTimeout(searchTimer);
      searchError.value = null;
      if (!q.trim()) {
        searchSeq++; // drop any in-flight response
        searchResults.value = [];
        searchLoading.value = false;
        return;
      }
      searchLoading.value = true;
      searchOpen.value = true;
      searchTimer = setTimeout(async () => {
        const seq = ++searchSeq;
        try {
          const results = await searchSymbols(q);
          if (seq !== searchSeq) return;
          searchResults.value = results;
          searchIndex.value = results.length ? 0 : -1;
        } catch (e) {
          if (seq !== searchSeq) return;
          searchResults.value = [];
          searchError.value = e.message;
        } finally {
          if (seq === searchSeq) searchLoading.value = false;
        }
      }, 250);
    });

    function inActiveList(sym) {
      return activeTickers.value.includes(sym);
    }
    const listFull = computed(() => !!activeList.value && activeTickers.value.length >= MAX_LIST_TICKERS);

    async function addTicker(sym) {
      if (inActiveList(sym) || listFull.value) return;
      searchQuery.value = '';
      searchOpen.value = false;
      await saveTickers([...activeTickers.value, sym]);
      searchInput.value?.focus();
      // Point at the new card at the bottom of the list.
      justAdded.value = sym;
      setTimeout(() => { if (justAdded.value === sym) justAdded.value = null; }, 2000);
      await nextTick();
      watchlistEl.value?.querySelector(`[data-ticker="${CSS.escape(sym)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function onSearchKeydown(e) {
      const n = searchResults.value.length;
      if (e.key === 'ArrowDown' && n) {
        e.preventDefault();
        searchOpen.value = true;
        searchIndex.value = (searchIndex.value + 1) % n;
      } else if (e.key === 'ArrowUp' && n) {
        e.preventDefault();
        searchIndex.value = (searchIndex.value - 1 + n) % n;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = searchResults.value[searchIndex.value];
        if (r) addTicker(r.symbol);
      } else if (e.key === 'Escape') {
        if (searchOpen.value && n) searchOpen.value = false;
        else if (searchQuery.value) searchQuery.value = '';
        else closeSearch();
      }
    }
    function onSearchBlur() {
      // Result buttons use mousedown.prevent, so blur here means focus truly left.
      searchOpen.value = false;
    }

    // ── Watchlist reordering ────────────────────────────────────────────────
    // Drag a card by its ⠿ handle (mouse or touch, via Pointer Events —
    // native HTML5 drag-and-drop doesn't work on most touch browsers), on a
    // touch screen long-press anywhere on the card, or focus the handle and
    // use ↑/↓. While dragging, the list renders from
    // `dragOrder` and reorders live as the pointer passes a neighbor's
    // midpoint; on release the new order is emitted once, and the parent
    // saves it into config.stocks.tickers like any other setting.
    const dragOrder = ref(null);   // working order while a drag is active
    const tickers = computed(() => dragOrder.value ?? activeTickers.value);
    const draggingTicker = ref(null);
    const watchlistEl = ref(null);
    let lastPointerY = 0;
    let autoScrollFrame = null;
    const AUTO_SCROLL_EDGE_PX = 60;
    const AUTO_SCROLL_MAX_SPEED = 14;

    function watchlistItems() {
      return [...watchlistEl.value.querySelectorAll(':scope > .watchlist-item')];
    }

    // Move the dragged ticker one slot at a time while the pointer is past
    // a neighbor's midpoint. Comparing only against neighbors (rather than
    // every card) keeps it stable when cards differ in height — e.g. when
    // one of them is expanded to show its chart.
    function repositionDragged() {
      const order = dragOrder.value;
      const items = watchlistItems();
      const start = order.indexOf(draggingTicker.value);
      let i = start;
      let moved = false;
      while (i > 0) {
        const r = items[i - 1].getBoundingClientRect();
        if (lastPointerY >= r.top + r.height / 2) break;
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        [items[i - 1], items[i]] = [items[i], items[i - 1]];
        i--; moved = true;
      }
      while (!moved && i < order.length - 1) {
        const r = items[i + 1].getBoundingClientRect();
        if (lastPointerY <= r.top + r.height / 2) break;
        [order[i + 1], order[i]] = [order[i], order[i + 1]];
        [items[i + 1], items[i]] = [items[i], items[i + 1]];
        i++;
      }
      if (i !== start) buzz(5); // a light tick each time the card changes slot
    }

    // Haptic feedback where supported (Android Chrome; iOS Safari has no
    // Vibration API, so this is a silent no-op there).
    function buzz(ms) {
      try { navigator.vibrate?.(ms); } catch { /* ignore */ }
    }

    // Pointer capture stops a touch drag from scrolling the page, so scroll
    // it ourselves when the pointer nears the top/bottom of the viewport.
    function autoScrollStep() {
      if (!draggingTicker.value) return;
      const y = lastPointerY;
      let speed = 0;
      if (y < AUTO_SCROLL_EDGE_PX) speed = -AUTO_SCROLL_MAX_SPEED * (1 - y / AUTO_SCROLL_EDGE_PX);
      else if (y > window.innerHeight - AUTO_SCROLL_EDGE_PX) speed = AUTO_SCROLL_MAX_SPEED * (1 - (window.innerHeight - y) / AUTO_SCROLL_EDGE_PX);
      if (speed) {
        window.scrollBy(0, speed);
        repositionDragged();
      }
      autoScrollFrame = requestAnimationFrame(autoScrollStep);
    }

    // Move/up are tracked on window rather than via setPointerCapture on
    // the handle: reordering can make Vue move the dragged card's DOM node,
    // and moving a node silently drops its pointer capture — the drop would
    // never arrive and the drag would get stuck.
    let activePointerId = null;
    // Releasing a drag fires a click on the card header (the press began on
    // the handle inside it), which would toggle that card open — swallow
    // the one click that immediately follows a drop.
    let suppressHeaderClick = false;

    function onHandlePointerDown(e, sym) {
      if (e.button !== 0 || draggingTicker.value || activeTickers.value.length < 2 || isPortfolioList.value) return;
      e.preventDefault(); // no text selection / focus-scroll while dragging
      startDrag(e.pointerId, e.clientY, sym);
    }

    function startDrag(pointerId, y, sym) {
      activePointerId = pointerId;
      lastPointerY = y;
      dragOrder.value = [...activeTickers.value];
      draggingTicker.value = sym;
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      window.addEventListener('blur', endDrag);
      // The card itself allows touch panning (unlike the handle's
      // touch-action: none), and touch-action can't change mid-gesture —
      // so a long-press drag blocks the page scroll by cancelling touchmove.
      window.addEventListener('touchmove', blockTouchScroll, { passive: false });
      autoScrollFrame = requestAnimationFrame(autoScrollStep);
      buzz(15);
    }

    function blockTouchScroll(e) {
      if (draggingTicker.value) e.preventDefault();
    }

    // ── Long-press to drag (touch only) ──
    // Hold a card still for LONG_PRESS_MS to pick it up. Moving the finger
    // first means a scroll, and a quick tap still expands the card.
    const LONG_PRESS_MS = 400;
    const LONG_PRESS_SLOP_PX = 8;
    let pressTimer = null;
    let press = null; // { pointerId, sym, x, y }

    function onCardPointerDown(e, sym) {
      if (e.pointerType !== 'touch' || draggingTicker.value || press || activeTickers.value.length < 2 || isPortfolioList.value) return;
      if (e.target.closest('.drag-handle')) return; // the handle drags immediately
      press = { pointerId: e.pointerId, sym, x: e.clientX, y: e.clientY };
      window.addEventListener('pointermove', onPressMove);
      window.addEventListener('pointerup', cancelPress);
      window.addEventListener('pointercancel', cancelPress);
      // Registered now (not when the drag starts) so it's in place before
      // the browser decides whether the gesture is a scroll.
      window.addEventListener('touchmove', blockTouchScroll, { passive: false });
      pressTimer = setTimeout(() => {
        const { pointerId, sym: pressed, y } = press;
        cancelPress();
        startDrag(pointerId, y, pressed);
      }, LONG_PRESS_MS);
    }

    function onPressMove(e) {
      if (e.pointerId !== press?.pointerId) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) cancelPress();
      else press.y = e.clientY;
    }

    function cancelPress() {
      clearTimeout(pressTimer);
      press = null;
      window.removeEventListener('pointermove', onPressMove);
      window.removeEventListener('pointerup', cancelPress);
      window.removeEventListener('pointercancel', cancelPress);
      if (!draggingTicker.value) window.removeEventListener('touchmove', blockTouchScroll);
    }

    // Long-pressing also opens the browser's context menu / text-selection
    // callout on some phones — suppress it while a press or drag is live.
    function onCardContextMenu(e) {
      if (press || draggingTicker.value) e.preventDefault();
    }

    function onDragMove(e) {
      if (e.pointerId !== activePointerId) return;
      lastPointerY = e.clientY;
      repositionDragged();
    }

    function stopListening() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
      window.removeEventListener('touchmove', blockTouchScroll);
      cancelAnimationFrame(autoScrollFrame);
    }

    // Drop — also on pointercancel and window blur (e.g. alt-tab mid-drag),
    // which keep whatever order was reached rather than leave a drag open.
    function endDrag(e) {
      if (e?.pointerId !== undefined && e.pointerId !== activePointerId) return;
      if (!draggingTicker.value) return;
      stopListening();
      suppressHeaderClick = true;
      // The click, if any, follows the drop — on touch screens a little later
      // than the pointerup, so hold the flag briefly rather than one tick.
      setTimeout(() => { suppressHeaderClick = false; }, 350);
      const order = dragOrder.value;
      const changed = order.some((t, i) => t !== activeTickers.value[i]);
      draggingTicker.value = null;
      // saveTickers updates the list synchronously (config via the parent,
      // or optimistically for a DB list), so it never snaps back.
      if (changed) {
        saveTickers([...order]);
        buzz(10);
      }
      dragOrder.value = null;
    }

    async function onHandleKeydown(e, sym) {
      if (isPortfolioList.value) return;
      const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!delta) return;
      e.preventDefault();
      const order = [...activeTickers.value];
      const from = order.indexOf(sym);
      const to = from + delta;
      if (to < 0 || to >= order.length) return;
      [order[from], order[to]] = [order[to], order[from]];
      saveTickers(order);
      // Moving a DOM node can drop its focus — put it back on the handle.
      await nextTick();
      watchlistEl.value?.querySelector(`[data-ticker="${CSS.escape(sym)}"] .drag-handle`)?.focus();
    }

    onUnmounted(() => { cancelPress(); stopListening(); });

    // ── Quotes (ticker → { price, change, pctChange, volume, shortName, loading, error }) ──
    const stockQuotes = reactive({});
    const sparklines = reactive({});   // ticker → SVG string
    // ticker → { series: [{ period (ISO timestamp), value }], previousClose, error }
    // Today's 5-minute prices — drives both the sparkline and the 1D chart.
    const intraday = reactive({});
    const lastUpdated = ref(null);
    watch(lastUpdated, v => emit('updated', v));
    let refreshTimer = null;

    async function fetchStockQuotes(symbols = tickers.value) {
      await Promise.all(symbols.map(async (sym) => {
        if (!stockQuotes[sym]) stockQuotes[sym] = { price: null, change: null, pctChange: null, volume: null, shortName: '', loading: true, error: null };
        else stockQuotes[sym].loading = true;
        try {
          const q = await fetchQuote(sym);
          stockQuotes[sym] = { ...q, loading: false, error: null };
          // Intraday is best-effort — don't let a slow/failed chart block the quote
          fetchChart(sym, '1d', '5m')
            .then(chart => {
              const series = [];
              chart.timestamps.forEach((ts, i) => {
                const close = chart.closes[i];
                if (close != null) series.push({ period: new Date(ts * 1000).toISOString(), value: close });
              });
              intraday[sym] = { series, previousClose: q.previousClose, error: null };
              sparklines[sym] = buildSparklineSVG(chart.closes, q);
            })
            .catch(e => {
              sparklines[sym] = '';
              // Keep the last good series on a failed refresh.
              if (!intraday[sym]?.series.length) intraday[sym] = { series: [], previousClose: null, error: e.message };
            });
        } catch (e) {
          stockQuotes[sym] = { price: null, change: null, pctChange: null, volume: null, shortName: '', loading: false, error: e.message };
        }
      }));
      lastUpdated.value = new Date().toLocaleTimeString();
    }

    // ── Major market indexes — symbol → { price, change, pctChange, loading, error } ──
    const indexSymbols = computed(() => props.config.marketIndexes?.symbols ?? DEFAULT_INDEX_SYMBOLS);
    const indexes = reactive({});

    async function fetchIndexes() {
      await Promise.all(indexSymbols.value.map(async (sym) => {
        if (!indexes[sym]) indexes[sym] = { price: null, change: null, pctChange: null, loading: true, error: null };
        else indexes[sym].loading = true;
        try {
          const q = await fetchQuote(sym);
          indexes[sym] = { ...q, loading: false, error: null };
        } catch (e) {
          indexes[sym] = { price: null, change: null, pctChange: null, loading: false, error: e.message };
        }
      }));
    }

    // ── Top movers card ──
    // Markets → Stocks: any combination of your watchlists (Default + yours),
    // remembered per browser. Portfolio page: just your holdings.
    const MOVERS_KEY = 'oilgas_movers_lists';
    const moverSources = computed(() => (props.portfolioOnly
      ? [{ id: 'portfolio', label: 'Your holdings', symbols: portfolioTickers.value }]
      : [
          { id: 'default', label: 'Default', symbols: configTickers.value },
          ...customLists.value.map(l => ({ id: 'wl-' + l.id, label: l.name, symbols: l.tickers })),
        ]
    ).filter(src => src.symbols.length));
    const moverSelected = ref((() => {
      try {
        const saved = JSON.parse(localStorage.getItem(MOVERS_KEY));
        if (Array.isArray(saved) && saved.length) return saved;
      } catch { /* none saved */ }
      return ['default'];
    })());
    watch(moverSelected, ids => {
      if (props.portfolioOnly) return;
      try { localStorage.setItem(MOVERS_KEY, JSON.stringify(ids)); } catch { /* per-browser only */ }
    });
    const moverSymbols = computed(() => {
      const srcs = moverSources.value;
      const picked = props.portfolioOnly ? srcs : srcs.filter(src => moverSelected.value.includes(src.id));
      return [...new Set((picked.length ? picked : srcs.slice(0, 1)).flatMap(src => src.symbols))];
    });
    // Picking another list: fetch quotes for its stocks we don't have yet.
    watch(moverSymbols, syms => {
      const missing = syms.filter(sym => !stockQuotes[sym]);
      if (missing.length) fetchStockQuotes(missing);
    });
    // A mover in the list below: open its card and bring it into view.
    function openMover(sym) {
      if (!tickers.value.includes(sym)) return;
      if (props.portfolioOnly) holdingsOpen.value = true; // movers only show inside an opened portfolio
      ensureDetail(sym);
      if (!details[sym].open) toggleDetail(sym);
      nextTick(() => watchlistEl.value?.querySelector(`[data-ticker="${CSS.escape(sym)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }

    async function refreshAll() {
      // The list shown plus whatever Top movers ranks (they can differ).
      // …and the stocks behind open options (moneyness, intrinsic value).
      const symbols = [...new Set([...tickers.value, ...moverSymbols.value, ...optionUnderlyings.value])];
      await Promise.all([fetchStockQuotes(symbols), fetchOptionQuotes(), props.portfolioOnly ? null : fetchIndexes(), loadEarnings(tickers.value)]);
    }

    // Switching lists or adding a ticker: fetch whatever has no quote yet.
    watch(activeTickers, syms => {
      const missing = syms.filter(s => !stockQuotes[s]);
      if (missing.length) fetchStockQuotes(missing);
    });

    onMounted(() => {
      refreshAll();
      const interval = Math.max(30, props.config.ui?.refreshIntervalSeconds ?? 60) * 1000;
      refreshTimer = setInterval(refreshAll, interval);
    });
    onUnmounted(() => clearInterval(refreshTimer));

    // ── Per-ticker detail panel: "Charts" (price history) and ──
    // "Documents" (SEC filings — was a separate Documents tab with its own
    // configured company list; now pulled directly for whatever's in the
    // Stock Watchlist, so there's nothing extra to configure). Both tabs
    // load lazily — only when a row is first expanded, or when that tab is
    // first switched to — rather than eagerly for the whole watchlist on
    // every visit, since SEC EDGAR is rate-limited and Yahoo chart history
    // is one more request per ticker either way.
    const details = reactive({}); // ticker → { open, tab: 'summary'|'chart'|'news'|'documents'|'portfolio'|'alerts', … }

    function ensureDetail(ticker) {
      if (!details[ticker]) {
        details[ticker] = {
          open: false,
          tab: 'summary',
          summary: { loading: false, loaded: false, profile: null, profileError: null, perf: null, spx: null, perfError: null, dividend: null },
          chart: { loading: false, loaded: false, error: null, series: [], range: '1Y' },
          stats: { loading: false, loaded: false, data: null },
          news: { loading: false, loaded: false, error: null, items: [] },
          docs: { loading: false, loaded: false, error: null, cik: null, filings: [], activeTab: '10-K' },
        };
      }
    }

    async function loadChart(ticker) {
      const d = details[ticker].chart;
      if (d.loaded || d.loading) return;
      d.loading = true;
      d.error = null;
      try {
        const chart = await fetchChart(ticker, CHART_FETCH_RANGE, '1d');
        const series = [];
        chart.timestamps.forEach((ts, i) => {
          const close = chart.closes[i];
          if (close == null) return;
          series.push({ period: new Date(ts * 1000).toISOString().slice(0, 10), value: close });
        });
        d.series = series;
        d.loaded = true;
      } catch (e) {
        d.error = e.message;
      } finally {
        d.loading = false;
      }
    }

    // Key statistics under the chart. Best-effort: fetchKeyStats never
    // throws per-field, so a failure here just leaves those values as '—'.
    async function loadStats(ticker) {
      const d = details[ticker].stats;
      if (d.loaded || d.loading) return;
      d.loading = true;
      try {
        d.data = await fetchKeyStats(ticker);
        d.loaded = true;
      } catch {
        d.data = null;
      } finally {
        d.loading = false;
      }
    }

    // Day values come from the live quote (refreshed with the watchlist);
    // P/E, market cap and yield are recomputed against the live price.
    function keyStats(ticker) {
      const q = stockQuotes[ticker] ?? {};
      const s = details[ticker]?.stats.data ?? {};
      const price = q.price;
      const pe = price != null && s.eps > 0 ? price / s.eps : null;
      const marketCap = price != null && s.sharesOutstanding ? price * s.sharesOutstanding : null;
      const divYield = price && s.dividendsTTM != null ? (s.dividendsTTM / price) * 100 : null;
      return [
        { label: 'Open', value: formatPrice(q.open) },
        { label: 'High', value: formatPrice(q.dayHigh) },
        { label: 'Low', value: formatPrice(q.dayLow) },
        { label: 'Vol', value: formatVolume(q.volume) },
        { label: 'Avg Vol (3M)', fromStats: true, value: formatVolume(s.avgVolume) },
        { label: 'Mkt Cap', fromStats: true, value: formatCompactNumber(marketCap) },
        { label: 'P/E (TTM)', fromStats: true, value: formatNumber(pe) },
        { label: 'EPS (TTM)', fromStats: true, value: formatPrice(s.eps) },
        { label: 'Div Yield (TTM)', fromStats: true, value: formatPercentLevel(divYield) },
        { label: 'Beta (5Y)', fromStats: true, value: formatNumber(s.beta) },
        { label: '52W High', value: formatPrice(q.fiftyTwoWeekHigh) },
        { label: '52W Low', value: formatPrice(q.fiftyTwoWeekLow) },
      ];
    }

    // ── Upcoming earnings (Nasdaq / Zacks via the server): card badge + Summary ──
    const earnings = reactive({}); // symbol → { date, time, confirmed, … } | null
    async function loadEarnings(symbols) {
      const want = symbols.filter(s => !s.startsWith('^') && !s.includes('='));
      if (!want.length) return;
      try { Object.assign(earnings, await fetchEarnings(want)); } catch { /* best-effort: no badge */ }
    }
    watch(() => tickers.value, syms => loadEarnings(syms.filter(s => !(s in earnings))));
    const todayIso = () => new Date().toLocaleDateString('en-CA');
    const daysUntil = iso => daysToExpiry(iso);
    // The badge: earnings within a week.
    function earningsSoon(sym) {
      const e = earnings[sym];
      if (!e?.date) return null;
      const days = daysUntil(e.date);
      return days >= 0 && days <= 7 ? { ...e, days } : null;
    }
    const earningsWhen = e => (e.time === 'before-open' ? 'before the open' : e.time === 'after-close' ? 'after the close' : '');
    function earningsTitle(sym) {
      const e = earnings[sym];
      if (!e?.date) return '';
      return `Earnings ${formatDate(e.date + 'T12:00:00')}${earningsWhen(e) ? ' ' + earningsWhen(e) : ''}`
        + (e.confirmed ? ' (confirmed)' : ' (estimated date)') + (e.epsForecast != null ? ` · consensus EPS ${formatPrice(e.epsForecast)}` : '');
    }
    // Summary tab: earnings, the estimated next dividend, and your option expirations — soonest first.
    function upcomingEvents(sym) {
      const out = [];
      const e = earnings[sym];
      if (e?.date && e.date >= todayIso()) {
        out.push({
          key: 'earnings', date: e.date, kind: 'earnings', title: 'Earnings' + (e.quarter ? ` · quarter ending ${e.quarter}` : ''),
          detail: [earningsWhen(e), e.epsForecast != null ? `consensus EPS ${formatPrice(e.epsForecast)}` : '', e.epsLastYear != null ? `a year ago ${formatPrice(e.epsLastYear)}` : ''].filter(Boolean).join(' · '),
          tag: e.confirmed ? 'Confirmed' : 'Estimated', estimated: !e.confirmed,
        });
      }
      const div = details[sym]?.summary?.dividend;
      if (div) {
        out.push({
          key: 'dividend', date: div.date, kind: 'dividend', approx: true, title: 'Ex-dividend',
          detail: `~${formatPrice(div.amount)} per share · ${div.frequency}, last ${formatDate(div.lastDate + 'T12:00:00')}`,
          tag: 'Estimated from history', estimated: true,
        });
      }
      const byExpiry = new Map();
      for (const occ of optionsFor(sym)) {
        const o = optPos(occ);
        if (daysUntil(o.expiry) < 0) continue;
        if (!byExpiry.has(o.expiry)) byExpiry.set(o.expiry, []);
        byExpiry.get(o.expiry).push(`${o.quantity} × ${optionLabel(o, { withUnderlying: false }).replace(/^\w+ \d+ '\d+ /, '')}${o.side === 'short' ? ' (short)' : ''}`);
      }
      for (const [date, items] of byExpiry) {
        out.push({ key: 'exp-' + date, date, kind: 'options', title: 'Your options expire', detail: items.join(', '), tag: 'Your portfolio' });
      }
      return out.sort((a, b) => a.date.localeCompare(b.date)).map(ev => ({ ...ev, days: daysUntil(ev.date) }));
    }

    // ── Summary tab: company profile + performance vs. the S&P 500 ──
    async function loadSummary(ticker) {
      const d = details[ticker].summary;
      if (d.loading || d.loaded) return;
      d.loading = true;
      const [profile, history, spx] = await Promise.allSettled([
        fetchCompanyProfile(ticker), fetchPriceHistory(ticker), fetchPriceHistory('^GSPC'),
      ]);
      if (profile.status === 'fulfilled') d.profile = profile.value;
      else d.profileError = profile.reason?.message ?? 'Unavailable';
      if (history.status === 'fulfilled') {
        d.perf = computePerformance(history.value);
        d.dividend = estimateNextDividend(history.value.dividends);
      } else d.perfError = history.reason?.message ?? 'Unavailable';
      if (!(ticker in earnings)) loadEarnings([ticker]);
      if (spx.status === 'fulfilled') d.spx = computePerformance(spx.value);
      d.loading = false;
      d.loaded = true;
    }
    const perfDiff = (a, b) => (a != null && b != null ? a - b : null);
    // The latest close the table measures to (kept on the computed periods).
    const lastCloseDate = d => (d.perf?.latest ? d.perf.latest + 'T12:00:00' : null);

    async function loadNews(ticker) {
      const d = details[ticker].news;
      if (d.loaded || d.loading) return;
      d.loading = true;
      d.error = null;
      try {
        d.items = await fetchTickerNews(ticker);
        d.loaded = true;
      } catch (e) {
        d.error = e.message;
      } finally {
        d.loading = false;
      }
    }

    // Some thumbnail URLs 404 or block hotlinking — hide the broken image.
    function onNewsImageError(e) {
      e.target.style.display = 'none';
    }

    async function loadDocs(ticker) {
      const d = details[ticker].docs;
      if (d.loaded || d.loading) return;
      d.loading = true;
      d.error = null;
      try {
        const cik = await resolveCIK(ticker);
        if (!cik) throw new Error(`Ticker "${ticker}" not found in SEC EDGAR`);
        d.cik = cik;
        const submissions = await fetchFilings(cik);
        d.filings = extractFilings(submissions, ['10-K', '10-Q', '8-K', 'DEF 14A'], 10);
        d.loaded = true;
      } catch (e) {
        d.error = e.message;
      } finally {
        d.loading = false;
      }
    }

    function loadActiveTab(ticker) {
      const tab = details[ticker].tab;
      if (tab === 'summary') loadSummary(ticker);
      else if (tab === 'chart') {
        loadChart(ticker);
        loadStats(ticker);
      } else if (tab === 'news') loadNews(ticker);
      else if (tab === 'documents') loadDocs(ticker);
      else if (tab === 'portfolio' && props.user && !positionFor(ticker) && !positionForms[ticker] && !optionsFor(ticker).length) startPurchase(ticker);
    }

    // ── Save stock news to Notes (signed in) ──
    // One open form at a time per article: `${ticker}|${link}` → { busy, error }.
    const noteForms = reactive({});
    const noteKey = (ticker, article) => `${ticker}|${article.link}`;
    function openNoteForm(ticker, article) {
      noteForms[noteKey(ticker, article)] = { busy: false, error: null };
    }
    function closeNoteForm(ticker, article) {
      delete noteForms[noteKey(ticker, article)];
    }
    async function saveNewNote(ticker, article, { labels, note }) {
      const f = noteForms[noteKey(ticker, article)];
      f.busy = true;
      f.error = null;
      try {
        await addNote({
          symbol: ticker, title: article.title, link: article.link,
          source: article.source, pubDate: article.pubDate, image: article.image || '',
        }, note, labels);
        closeNoteForm(ticker, article);
      } catch (e) {
        f.error = e.message;
        f.busy = false;
      }
    }

    // ── Alerts (🔔 tab; signed in) ──
    // One open form per ticker: { alertId (null = new), initial, busy, error }.
    const alertForms = reactive({});
    function activeAlertCount(ticker) {
      return alertsFor(ticker).filter(a => a.active).length;
    }
    function openAlertForm(ticker, initial, alertId = null) {
      alertForms[ticker] = { alertId, initial, busy: false, error: null };
    }
    function closeAlertForm(ticker) {
      delete alertForms[ticker];
    }
    async function submitAlert(ticker, fields) {
      const f = alertForms[ticker];
      f.busy = true;
      f.error = null;
      try {
        // Re-saving a one-time alert that already fired re-arms it.
        await saveAlert(f.alertId, f.alertId ? { ...fields, active: true } : { symbol: ticker, ...fields });
        closeAlertForm(ticker);
      } catch (e) {
        f.error = e.message;
        f.busy = false;
      }
    }
    async function toggleAlert(alert) {
      try { await setAlertActive(alert, !alert.active); } catch (e) { alert._error = e.message; }
    }
    async function deleteAlertConfirm(alert) {
      if (!confirm(`Delete this ${alertSubject(alert.symbol)} alert?\n\n${describeAlert(alert)}`)) return;
      try { await removeAlert(alert.id); } catch (e) { alert._error = e.message; }
    }

    // Portfolio page: is the Holdings section expanded? (remembered per browser)
    const HOLDINGS_KEY = 'oilgas_holdings_open';
    const holdingsOpen = ref((() => {
      try { return localStorage.getItem(HOLDINGS_KEY) !== '0'; } catch { return true; }
    })());
    watch(holdingsOpen, open => { try { localStorage.setItem(HOLDINGS_KEY, open ? '1' : '0'); } catch { /* per-browser only */ } });

    // ── Portfolio: your position in a ticker (quantity × average cost) ──
    // Saved in config.portfolio — with the rest of the settings, so in the
    // profile when signed in, else this browser — keyed by symbol, so the
    // same holding shows in every watchlist that contains the ticker.
    const positionForms = reactive({}); // ticker → { quantity, avgCost, category, error } while editing


    function positionFor(ticker) {
      const p = pfFor(ticker)?.portfolio?.[ticker];
      return p && p.quantity > 0 ? p : null;
    }

    function startPositionEdit(ticker) {
      const p = positionFor(ticker);
      positionForms[ticker] = {
        quantity: p ? String(p.quantity) : '',
        avgCost: p ? String(p.avgCost) : '',
        category: p?.category ?? '', // '' = automatic, from Yahoo's instrument type
        error: null,
      };
    }

    function cancelPositionEdit(ticker) {
      delete positionForms[ticker];
    }

    function savePosition(ticker) {
      const f = positionForms[ticker];
      const quantity = Number(f.quantity);
      const avgCost = Number(f.avgCost);
      if (!(quantity > 0) || !Number.isFinite(quantity)) { f.error = 'Enter a quantity greater than 0.'; return; }
      if (!(avgCost >= 0) || !Number.isFinite(avgCost) || String(f.avgCost).trim() === '') {
        f.error = 'Enter an average cost of 0 or more.';
        return;
      }
      const covering = sharesCovering(ticker);
      if (quantity < covering - 1e-9) { f.error = `${formatShares(covering)} shares cover open calls — the quantity can't go below that.`; return; }
      const pfErr = newPortfolioNameError(ticker);
      if (pfErr) { f.error = pfErr; return; }
      const position = { quantity, avgCost };
      if (f.category) position.category = f.category;
      // Editing the totals keeps the purchase history.
      const txs = positionFor(ticker)?.transactions;
      if (txs?.length) position.transactions = txs;
      emitPosition(ticker, { symbol: ticker, position });
      delete positionForms[ticker];
    }

    // ── Purchase transactions (Portfolio tab) ──
    // A purchase adds shares at a price on a date: the position's quantity
    // grows and its average cost becomes the share-weighted average.
    // Purchases are kept on the position (config.portfolio[sym].transactions)
    // and listed in the tab; deleting one reverses its effect.
    const purchaseForms = reactive({}); // ticker → { quantity, price, date, payFrom, error }
    const todayISO = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

    function startPurchase(ticker) {
      const last = stockQuotes[ticker]?.price;
      purchaseForms[ticker] = {
        quantity: '',
        price: last != null ? String(Math.round(last * 100) / 100) : '', // the last price
        date: todayISO(),
        payFrom: null, // null → the first cash holding (see payFromFor); '' → outside the portfolio
        error: null,
      };
      delete saleForms[ticker];
      // Cash holdings are found by asset type, which needs each holding's quote.
      const missing = Object.keys(pfFor(ticker).portfolio ?? {}).filter(sym => !stockQuotes[sym]);
      if (missing.length) fetchStockQuotes(missing);
    }

    // ── Paying for a purchase from a cash holding ──
    // Holdings whose asset type is Cash (money-market funds like SPAXX, or set
    // to Cash by hand), other than the stock being bought, with what's
    // available at the current price ($1 NAV when there's no quote yet).
    // ── The account's cash (config.accountCash): deposits from your bank
    // accounts land here; purchases can pay from it and sales deposit to it,
    // like a cash holding. Shown in cash pickers as "Account cash" (key CASH).
    const ACCOUNT_CASH = 'CASH';
    const CASH_DELTA = '__accountCash'; // in a save's `updates`: change to the balance
    const accountCash = computed(() => props.config.accountCash ?? { balance: 0, deposits: [] });
    const cashName = sym => (sym === ACCOUNT_CASH ? 'Account cash' : sym);
    // Change a cash balance in a save: a holding in `pf`, or the account's cash.
    function cashAdjust(updates, pf, sym, shares) {
      if (sym === ACCOUNT_CASH) {
        updates[CASH_DELTA] = (updates[CASH_DELTA] ?? 0) + shares;
        return;
      }
      const cur = sym in updates ? updates[sym] : pf.portfolio?.[sym] ?? null;
      if (!cur) {
        // Gone since: money coming back re-creates it; money going out is lost.
        if (shares > 0) updates[sym] = { quantity: shares, avgCost: 1, category: 'cash' };
        return;
      }
      const left = cur.quantity + shares;
      updates[sym] = left > 1e-9 ? { ...cur, quantity: left } : null;
    }
    // A save's payload with the account-cash change pulled out of `updates`.
    function withCash(payload) {
      const u = payload.updates;
      if (!u || !(CASH_DELTA in u)) return payload;
      const { [CASH_DELTA]: cashDelta, ...updates } = u;
      return { ...payload, updates, cashDelta };
    }

    // Where money can come from / go to for `ticker`: cash holdings in its
    // portfolio, then the account's cash (signed in). `available` is what's
    // not reserved for cash-secured puts (see cashReserved).
    function cashSources(ticker) {
      const pf = pfFor(ticker);
      const holdings = Object.entries(pf.portfolio ?? {})
        .filter(([sym, p]) => sym !== ticker && p?.quantity > 0 && (p.category || autoCategoryFor(sym)) === 'cash')
        .map(([sym, p]) => {
          const price = stockQuotes[sym]?.price || 1;
          const balance = p.quantity * price;
          const reserved = cashReserved(sym, pf);
          return { symbol: sym, label: sym, price, balance, reserved, available: balance - reserved };
        });
      if (!props.user) return holdings;
      const balance = accountCash.value.balance ?? 0;
      const reserved = cashReserved(ACCOUNT_CASH);
      return [...holdings, { symbol: ACCOUNT_CASH, label: 'Account cash', price: 1, balance, reserved, available: balance - reserved }];
    }
    // Paying: the first source with money in it, else "Outside the portfolio".
    const fundedSource = ticker => cashSources(ticker).find(c => c.available > 0.005)?.symbol ?? '';
    function payFromFor(ticker) {
      const f = purchaseForms[ticker];
      if (!f) return '';
      return f.payFrom ?? fundedSource(ticker);
    }
    function cancelPurchase(ticker) {
      delete purchaseForms[ticker];
    }

    // What the position becomes with this purchase — shown before saving.
    function purchasePreview(ticker) {
      const f = purchaseForms[ticker];
      const qty = Number(f?.quantity);
      const price = Number(f?.price);
      if (!(qty > 0) || !(price > 0)) return null;
      const p = positionFor(ticker);
      const quantity = (p?.quantity ?? 0) + qty;
      const avgCost = p ? (p.quantity * p.avgCost + qty * price) / quantity : price;
      const from = cashSources(ticker).find(c => c.symbol === payFromFor(ticker)) ?? null;
      return {
        quantity, avgCost, cost: qty * price, was: p ? { quantity: p.quantity, avgCost: p.avgCost } : null,
        from: from && { symbol: from.symbol, available: from.available, after: from.available - qty * price },
      };
    }

    function savePurchase(ticker) {
      const f = purchaseForms[ticker];
      const qty = Number(f.quantity);
      const price = Number(f.price);
      if (!(qty > 0) || !Number.isFinite(qty)) { f.error = 'Enter how many shares you bought.'; return; }
      if (!(price > 0) || !Number.isFinite(price)) { f.error = 'Enter the price per share.'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { f.error = 'Enter the purchase date.'; return; }
      if (f.date > todayISO()) { f.error = "The purchase date can't be in the future."; return; }
      const pfErr = newPortfolioNameError(ticker);
      if (pfErr) { f.error = pfErr; return; }
      const p = positionFor(ticker);
      const next = purchasePreview(ticker);
      const tx = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: f.date, quantity: qty, price };
      const updates = {};
      // Deduct the cost from the chosen cash holding (its average cost stays).
      const src = cashSources(ticker).find(c => c.symbol === payFromFor(ticker));
      if (src) {
        if (next.cost > src.available + 0.005) {
          f.error = `Only ${formatUSD(src.available)} available in ${src.label}${src.reserved > 0 ? ` (${formatUSD(src.reserved)} is reserved for cash-secured puts)` : ''} — pay from another holding, or choose "Outside the portfolio".`;
          return;
        }
        const shares = next.cost / src.price;
        cashAdjust(updates, pfFor(ticker), src.symbol, -shares);
        Object.assign(tx, { paidFrom: src.symbol, paidShares: shares });
      }
      const position = { quantity: next.quantity, avgCost: next.avgCost, transactions: [...(p?.transactions ?? []), tx] };
      if (p?.category) position.category = p.category;
      updates[ticker] = position;
      emitPosition(ticker, { updates });
      delete purchaseForms[ticker];
      delete positionForms[ticker];
    }

    // ── Selling (Portfolio page only) ──
    // A sale lowers the share count at the same average cost and realizes
    // (price − avg cost) × shares. Selling everything moves the position to
    // config.closedPositions. Proceeds can go into a cash holding.
    const saleForms = reactive({}); // ticker → { quantity, price, date, depositTo, error }
    const closedPositions = computed(() => viewPf.value.closedPositions ?? []);
    const closedIn = ticker => pfFor(ticker).closedPositions ?? [];

    function startSale(ticker) {
      const last = stockQuotes[ticker]?.price;
      saleForms[ticker] = {
        quantity: '',
        price: last != null ? String(Math.round(last * 100) / 100) : '',
        date: todayISO(),
        depositTo: null, // null → the first cash holding; '' → outside the portfolio
        error: null,
      };
      delete purchaseForms[ticker];
      delete positionForms[ticker];
    }
    function cancelSale(ticker) {
      delete saleForms[ticker];
    }
    function depositToFor(ticker) {
      const f = saleForms[ticker];
      if (!f) return '';
      return f.depositTo ?? cashSources(ticker)[0]?.symbol ?? '';
    }

    function salePreview(ticker) {
      const f = saleForms[ticker];
      const p = positionFor(ticker);
      const qty = Number(f?.quantity);
      const price = Number(f?.price);
      if (!p || !(qty > 0) || !(price > 0)) return null;
      const proceeds = qty * price;
      const realized = (price - p.avgCost) * qty;
      const dest = cashSources(ticker).find(c => c.symbol === depositToFor(ticker)) ?? null;
      return {
        proceeds, realized, realizedPct: p.avgCost > 0 ? ((price - p.avgCost) / p.avgCost) * 100 : null,
        remaining: p.quantity - qty, tooMany: qty > p.quantity + 1e-9, closes: Math.abs(p.quantity - qty) <= 1e-9,
        to: dest && { symbol: dest.symbol, before: dest.available, after: dest.available + proceeds },
      };
    }

    // Everything sold over a position's life → its Closed positions record.
    function closedRecord(ticker, p, transactions, closedDate) {
      const sells = transactions.filter(t => t.type === 'sell');
      const sharesSold = sells.reduce((sum, t) => sum + t.quantity, 0);
      const costBasis = sells.reduce((sum, t) => sum + t.quantity * t.avgCost, 0);
      const proceeds = sells.reduce((sum, t) => sum + t.quantity * t.price, 0);
      const buyDates = transactions.filter(t => t.type !== 'sell').map(t => t.date).sort();
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        symbol: ticker,
        name: stockQuotes[ticker]?.shortName ?? '',
        ...(p.category ? { category: p.category } : {}),
        sharesSold, costBasis, proceeds, realized: proceeds - costBasis,
        openedDate: buyDates[0] ?? null,
        closedDate,
        transactions,
      };
    }

    function saveSale(ticker) {
      const f = saleForms[ticker];
      const p = positionFor(ticker);
      const qty = Number(f.quantity);
      const price = Number(f.price);
      if (!p) return;
      if (!(qty > 0) || !Number.isFinite(qty)) { f.error = 'Enter how many shares you sold.'; return; }
      if (qty > p.quantity + 1e-9) { f.error = `You hold ${formatShares(p.quantity)} shares — you can't sell more.`; return; }
      const covering = sharesCovering(ticker);
      if (p.quantity - qty < covering - 1e-9) {
        f.error = `${formatShares(covering)} of your ${ticker} shares cover open calls — you can sell at most ${formatShares(Math.max(0, p.quantity - covering))}. Buy back (close) those calls first.`;
        return;
      }
      if (!(price > 0) || !Number.isFinite(price)) { f.error = 'Enter the sale price per share.'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { f.error = 'Enter the sale date.'; return; }
      if (f.date > todayISO()) { f.error = "The sale date can't be in the future."; return; }

      const tx = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'sell', date: f.date, quantity: qty, price,
        avgCost: p.avgCost, realized: (price - p.avgCost) * qty,
      };
      const updates = {};
      const dest = cashSources(ticker).find(c => c.symbol === depositToFor(ticker));
      if (dest) {
        const shares = (qty * price) / dest.price;
        cashAdjust(updates, pfFor(ticker), dest.symbol, shares);
        Object.assign(tx, { depositTo: dest.symbol, depositShares: shares });
      }
      const transactions = [...(p.transactions ?? []), tx];
      const remaining = p.quantity - qty;
      let closed;
      if (remaining <= 1e-9) {
        updates[ticker] = null;
        closed = [closedRecord(ticker, p, transactions, f.date), ...closedIn(ticker)];
        delete details[ticker]; // its card leaves Holdings
      } else {
        updates[ticker] = { ...p, quantity: remaining, transactions };
      }
      emitPosition(ticker, closed ? { updates, closed } : { updates });
      delete saleForms[ticker];
    }

    // Undo a sale on an open position: shares back, proceeds out of cash.
    function reverseDeposit(updates, tx, pf) {
      if (!tx.depositTo || !(tx.depositShares > 0)) return;
      cashAdjust(updates, pf, tx.depositTo, -tx.depositShares); // a holding that's gone has nothing to take back
    }
    function deleteSale(ticker, tx) {
      const back = tx.depositTo ? `\n${formatUSD(tx.quantity * tx.price)} comes back out of ${cashName(tx.depositTo)}.` : '';
      if (!confirm(`Delete this sale?\n\n${formatShares(tx.quantity)} ${ticker} at ${formatPrice(tx.price)} on ${tx.date}\n\nThe shares go back into your position.${back}`)) return;
      const p = positionFor(ticker);
      if (!p) return;
      const updates = {};
      reverseDeposit(updates, tx, pfFor(ticker));
      const rest = (p.transactions ?? []).filter(t => t.id !== tx.id);
      updates[ticker] = { ...p, quantity: p.quantity + tx.quantity, transactions: rest };
      emitPosition(ticker, { updates });
    }

    // Closed positions: undo the final sale (back to Holdings), or delete the record.
    function reopenClosed(rec) {
      if (rec.kind === 'option') return reopenClosedOption(rec);
      if (positionFor(rec.symbol)) {
        alert(`You hold ${rec.symbol} again — record further sales or purchases on its open position instead.`);
        return;
      }
      const last = [...rec.transactions].reverse().find(t => t.type === 'sell');
      if (!last) return;
      if (!confirm(`Undo the ${rec.symbol} sale of ${formatShares(last.quantity)} shares on ${last.date}?\n\nIt goes back to your Holdings.` + (last.depositTo ? `\n${formatUSD(last.quantity * last.price)} comes back out of ${last.depositTo}.` : ''))) return;
      const updates = {};
      reverseDeposit(updates, last, viewPf.value);
      const position = {
        quantity: last.quantity, avgCost: last.avgCost,
        transactions: rec.transactions.filter(t => t.id !== last.id),
      };
      if (rec.category) position.category = rec.category;
      updates[rec.symbol] = position;
      emit('set-position', withCash({ portfolioId: viewPf.value.id, updates, closed: closedPositions.value.filter(c => c.id !== rec.id) }));
    }
    function reopenClosedOption(rec) {
      if (optionPositionFor(rec.symbol)) {
        alert(`You hold ${rec.name} again — close or add to that position instead.`);
        return;
      }
      const last = [...rec.transactions].reverse().find(t => t.type === 'close');
      if (!last) return;
      if (!confirm(`Undo closing ${last.quantity} × ${rec.name} on ${last.date}?\n\nIt goes back to your open options.`)) return;
      const updates = {};
      reverseCash(updates, last, viewPf.value);
      const position = {
        ...rec.option, quantity: last.quantity, avgCost: last.avgCost,
        transactions: rec.transactions.filter(t => t.id !== last.id),
      };
      emit('set-position', withCash({ portfolioId: viewPf.value.id, updates, options: { [rec.symbol]: position }, closed: closedPositions.value.filter(c => c.id !== rec.id) }));
    }
    function deleteClosed(rec) {
      if (!confirm(`Delete the closed ${rec.kind === 'option' ? rec.name : rec.symbol} position from your history?\n\nThis doesn't change any cash holding.`)) return;
      emit('set-position', { portfolioId: viewPf.value.id, closed: closedPositions.value.filter(c => c.id !== rec.id) });
    }

    const closedTotals = computed(() => {
      const list = closedPositions.value;
      if (!list.length) return null;
      const costBasis = list.reduce((sum, c) => sum + c.costBasis, 0);
      const proceeds = list.reduce((sum, c) => sum + c.proceeds, 0);
      const realized = proceeds - costBasis;
      return { costBasis, proceeds, realized, realizedPct: costBasis > 0 ? (realized / costBasis) * 100 : null };
    });

    // Realized G/L from partial sales of a position you still hold.
    function realizedFor(ticker) {
      const sells = (positionFor(ticker)?.transactions ?? []).filter(t => t.type === 'sell');
      return sells.length ? sells.reduce((sum, t) => sum + t.realized, 0) : null;
    }

    // Closed positions section open? (remembered per browser)
    const CLOSED_KEY = 'oilgas_closed_open';
    const closedOpen = ref((() => {
      try { return localStorage.getItem(CLOSED_KEY) !== '0'; } catch { return true; }
    })());
    watch(closedOpen, open => { try { localStorage.setItem(CLOSED_KEY, open ? '1' : '0'); } catch { /* per-browser only */ } });

    // ── Move a position to another portfolio (an opened portfolio's Portfolio tab) ──
    // All of it: the position moves with its trades (merging into one already
    // there: quantities add, averages weight, trades combine). Part of it: N
    // shares leave at the average cost ("Transfer out") and arrive at that
    // cost ("Transfer in"); the source's average doesn't change. Nothing is
    // sold — no realized G/L, no cash. Option contracts on the stock can go
    // too; shares covering calls only move with those calls. Each move is
    // logged in config.transfers (Account → Transactions) and can be undone.
    const moveForms = reactive({}); // ticker → { to, newName, shares, withOptions, error }
    const isTransfer = tx => tx.type === 'transfer-in' || tx.type === 'transfer-out';
    function startMove(ticker) {
      const p = positionFor(ticker);
      if (!p) return;
      const other = portfolios.value.find(x => x.id !== openPf.value?.id);
      moveForms[ticker] = { to: other?.id ?? '__new', newName: '', shares: String(p.quantity), withOptions: false, error: null };
      delete saleForms[ticker];
      delete purchaseForms[ticker];
      delete positionForms[ticker];
    }
    function cancelMove(ticker) { delete moveForms[ticker]; }
    // Contracts on the stock that can move — not a put secured by a cash holding the target doesn't have.
    function movableOptions(ticker) {
      const f = moveForms[ticker];
      const src = openPf.value;
      const dest = f && f.to !== '__new' ? portfolioById(f.to) : null;
      return optionsFor(ticker).map(occ => {
        const o = src.optionPositions[occ];
        const cashSym = o.side === 'short' && o.covered?.by === 'cash' ? o.covered.symbol : null;
        const blocked = cashSym && cashSym !== ACCOUNT_CASH && !(dest?.portfolio?.[cashSym]?.quantity > 0);
        return { occ, o, blocked, reason: blocked ? `secured by ${cashSym}, which ${dest?.name ?? 'the new portfolio'} doesn't hold` : null };
      });
    }
    function movePreview(ticker) {
      const f = moveForms[ticker];
      const p = positionFor(ticker);
      if (!f || !p) return null;
      const qty = Number(f.shares);
      const covering = sharesCovering(ticker, openPf.value);
      const calls = coveredCalls(ticker, openPf.value);
      const opts = f.withOptions ? movableOptions(ticker).filter(x => !x.blocked) : [];
      const movingCalls = opts.filter(x => calls.includes(x.occ));
      const callShares = movingCalls.reduce((sum, x) => sum + sharesOf(x.o), 0);
      const dest = f.to === '__new' ? null : portfolioById(f.to);
      const had = dest?.portfolio?.[ticker]?.quantity > 0 ? dest.portfolio[ticker] : null;
      const destCovering = dest ? sharesCovering(ticker, dest) : 0;
      let error = null;
      if (!(qty > 0) || !Number.isFinite(qty)) error = 'Enter how many shares to move.';
      else if (qty > p.quantity + 1e-9) error = `You hold ${formatShares(p.quantity)} shares.`;
      // Shares covering calls left behind must stay; calls moving need their shares in the target.
      else if (p.quantity - qty < covering - callShares - 1e-9) error = `${formatShares(covering - callShares)} shares cover calls staying in ${openPf.value.name} — move at most ${formatShares(Math.max(0, p.quantity - covering + callShares))}${calls.length && !f.withOptions ? ', or move the options too' : ''}.`;
      else if ((had?.quantity ?? 0) + qty < destCovering + callShares - 1e-9) error = `The covered calls need ${formatShares(destCovering + callShares)} shares in ${dest?.name ?? 'the new portfolio'} — move at least ${formatShares(destCovering + callShares - (had?.quantity ?? 0))}.`;
      const whole = Math.abs(qty - p.quantity) < 1e-9;
      const merged = had ? { quantity: had.quantity + qty, avgCost: (had.quantity * had.avgCost + qty * p.avgCost) / (had.quantity + qty) } : { quantity: qty, avgCost: p.avgCost };
      return { qty, whole, had, merged, dest, opts, blockedOpts: f.withOptions ? movableOptions(ticker).filter(x => x.blocked) : [], left: p.quantity - qty, error };
    }
    async function saveMove(ticker) {
      const f = moveForms[ticker];
      const src = openPf.value;
      const p = positionFor(ticker);
      const pv = movePreview(ticker);
      if (!pv || !src || !p) return;
      if (pv.error) { f.error = pv.error; return; }
      let destId = f.to;
      let newPortfolio = null;
      if (f.to === '__new') {
        const name = f.newName.trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!name) { f.error = 'Name the new portfolio.'; return; }
        if (portfolios.value.some(x => x.name.toLowerCase() === name.toLowerCase())) { f.error = `You already have a portfolio named "${name}".`; return; }
        try {
          destId = await claimPortfolioId(name);
        } catch (e) {
          f.error = `Couldn't create the portfolio: ${e.message}`;
          return;
        }
        newPortfolio = { id: destId, name };
      }
      const dest = pv.dest ?? { id: destId, name: newPortfolio.name, portfolio: {}, optionPositions: {} };
      const date = todayISO();
      const transfer = {
        id: newId(), date, symbol: ticker, quantity: pv.qty, avgCost: p.avgCost, whole: pv.whole,
        fromId: src.id, fromName: src.name, toId: destId, toName: dest.name,
        options: pv.opts.map(x => `${x.o.quantity} × ${optionLabel(baseOcc(x.occ), { withUnderlying: false })}`),
      };
      // The position in each portfolio afterwards.
      const meta = p.category ? { category: p.category } : {};
      let srcPos, moved;
      if (pv.whole) {
        srcPos = null;
        moved = { quantity: p.quantity, avgCost: p.avgCost, ...meta, transactions: [...(p.transactions ?? [])] };
      } else {
        srcPos = { ...p, quantity: pv.left, transactions: [...(p.transactions ?? []), { id: newId(), type: 'transfer-out', date, quantity: pv.qty, price: p.avgCost, to: dest.name, transferId: transfer.id }] };
        moved = { quantity: pv.qty, avgCost: p.avgCost, ...meta, transactions: [{ id: newId(), type: 'transfer-in', date, quantity: pv.qty, price: p.avgCost, from: src.name, transferId: transfer.id }] };
      }
      const destPos = pv.had
        ? { ...pv.had, quantity: pv.merged.quantity, avgCost: pv.merged.avgCost, transactions: [...(pv.had.transactions ?? []), ...moved.transactions] }
        : moved;
      const srcOptions = {};
      const destOptions = {};
      for (const { occ, o } of pv.opts) {
        srcOptions[occ] = null;
        const cur = dest.optionPositions?.[occ];
        destOptions[occ] = cur && cur.side === o.side && cur.quantity > 0
          ? { ...cur, quantity: cur.quantity + o.quantity, avgCost: (cur.quantity * cur.avgCost + o.quantity * o.avgCost) / (cur.quantity + o.quantity), transactions: [...(cur.transactions ?? []), ...(o.transactions ?? [])] }
          : o;
      }
      // Undo puts both portfolios back as they were (and drops a portfolio this move created).
      const before = {
        src: { updates: { [ticker]: p }, options: Object.fromEntries(pv.opts.map(x => [x.occ, x.o])) },
        dest: { updates: { [ticker]: pv.had ?? null }, options: Object.fromEntries(pv.opts.map(x => [x.occ, dest.optionPositions?.[x.occ] ?? null])) },
      };
      emit('move-position', {
        changes: [
          { portfolioId: src.id, updates: { [ticker]: srcPos }, options: srcOptions },
          { portfolioId: destId, newPortfolio, updates: { [ticker]: destPos }, options: destOptions },
        ],
        transfer,
      });
      delete moveForms[ticker];
      if (srcPos === null) delete details[ticker]; // its card leaves this portfolio's Holdings
      const what = `${formatShares(pv.qty)} ${ticker}${transfer.options.length ? ` and ${transfer.options.length} option position${transfer.options.length === 1 ? '' : 's'}` : ''}`;
      showTransferToast(`Moved ${what} to ${dest.name}`, async () => {
        emit('move-position', {
          changes: [
            { portfolioId: src.id, ...before.src },
            ...(newPortfolio ? [] : [{ portfolioId: destId, ...before.dest }]),
          ],
          removeTransferId: transfer.id,
          removePortfolioId: newPortfolio ? destId : null,
        });
      });
    }

    function transactionsFor(ticker) {
      return [...(positionFor(ticker)?.transactions ?? [])]
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    }

    function deleteTransaction(ticker, tx) {
      if (isTransfer(tx)) return; // undone from the move itself, not trade by trade
      if (tx.type === 'sell') return deleteSale(ticker, tx);
      const refund = tx.paidFrom ? `\n${formatUSD(tx.quantity * tx.price)} goes back to ${cashName(tx.paidFrom)}.` : '';
      if (!confirm(`Delete this purchase?\n\n${formatShares(tx.quantity)} ${ticker} at ${formatPrice(tx.price)} on ${tx.date}\n\nYour position will be reduced accordingly.${refund}`)) return;
      const p = positionFor(ticker);
      if (!p) return;
      // Money it took from a cash holding goes back there (re-created if that
      // holding has since been removed).
      const updates = {};
      if (tx.paidFrom && tx.paidShares > 0) {
        cashAdjust(updates, pfFor(ticker), tx.paidFrom, tx.paidShares);
      }
      const rest = (p.transactions ?? []).filter(t => t.id !== tx.id);
      const quantity = p.quantity - tx.quantity;
      if (quantity <= 1e-9) {
        // That purchase was the whole position — back to "add a purchase".
        emitPosition(ticker, { updates: { ...updates, [ticker]: null } });
        startPurchase(ticker);
        return;
      }
      // Reverse the weighted average; if the totals were edited by hand since,
      // that can come out non-positive — then keep the current average.
      const reversed = (p.quantity * p.avgCost - tx.quantity * tx.price) / quantity;
      const position = { quantity, avgCost: reversed > 0 ? reversed : p.avgCost };
      if (p.category) position.category = p.category;
      if (rest.length) position.transactions = rest;
      emitPosition(ticker, { updates: { ...updates, [ticker]: position } });
    }

    function removePosition(ticker) {
      if (sharesCovering(ticker) > 0) {
        alert(`Your ${ticker} shares cover open calls — close those calls before removing the position.`);
        return;
      }
      if (cashReserved(ticker) > 0) {
        alert(`${ticker} secures open puts — close those puts before removing it.`);
        return;
      }
      const n = positionFor(ticker)?.transactions?.length ?? 0;
      if (!confirm(`Remove your ${ticker} position${n ? ` and its ${n} purchase${n === 1 ? '' : 's'}` : ''}?`)) return;
      emitPosition(ticker, { symbol: ticker, position: null });
      // Back to "add a purchase" for this stock.
      delete positionForms[ticker];
      startPurchase(ticker);
    }

    // ── Options (v1): calls and puts on a stock, bought (long) or sold (short) to open ──
    // Saved in config.optionPositions, keyed by the contract's OCC symbol:
    // { underlying, type, strike, expiry, side, multiplier, quantity (contracts),
    //   avgCost (premium per share), transactions }. Yahoo has no option chain
    // without auth, so the form builds the symbol from expiration + strike and
    // checks the contract exists by fetching its quote. A long option is an
    // asset (value = contracts × 100 × premium); a short one is a liability —
    // its value counts negative and it gains as the premium falls.
    // Contracts live in a portfolio (see pfFor). In the merged view a contract
    // held long in one portfolio and short in another is keyed "OCC#portfolio".
    const baseOcc = key => key.split('#')[0];
    const underlyingOf = key => parseOcc(baseOcc(key))?.underlying ?? null;
    // A contract's position, in the portfolio its stock is shown in.
    function optPos(occ) {
      return pfFor(underlyingOf(occ))?.optionPositions?.[occ] ?? null;
    }
    function optionPositionFor(occ) {
      const p = optPos(occ);
      return p && p.quantity > 0 ? p : null;
    }
    const openOptionsIn = pf => Object.keys(pf?.optionPositions ?? {}).filter(k => pf.optionPositions[k]?.quantity > 0);
    // The Account page's portfolio (or all of them): its open contracts.
    const openOptionSymbols = computed(() => openOptionsIn(viewPf.value));
    // A stock's open contracts (in its portfolio), nearest expiration first.
    function optionsFor(underlying) {
      const pf = pfFor(underlying);
      return openOptionsIn(pf)
        .filter(occ => pf.optionPositions[occ].underlying === underlying)
        .sort((a, b) => pf.optionPositions[a].expiry.localeCompare(pf.optionPositions[b].expiry) || a.localeCompare(b));
    }

    // ── Covered options: reservations derived from open short contracts ──
    // A cash-secured put reserves strike × 100 × contracts of a cash holding
    // in the same portfolio; a covered call reserves 100 shares per contract
    // of its stock. Nothing moves — closing, expiring or deleting the
    // contract releases it.
    const reserveOf = p => p.strike * (p.multiplier ?? MULTIPLIER) * p.quantity;
    const sharesOf = p => (p.multiplier ?? MULTIPLIER) * p.quantity;
    function cashSecuring(cashSymbol, pf = cashSymbol === ACCOUNT_CASH ? allPf.value : pfFor(cashSymbol)) {
      return openOptionsIn(pf).filter(occ => {
        const p = pf.optionPositions[occ];
        return p.side === 'short' && p.covered?.by === 'cash' && p.covered.symbol === cashSymbol;
      });
    }
    function cashReserved(cashSymbol, pf = cashSymbol === ACCOUNT_CASH ? allPf.value : pfFor(cashSymbol)) {
      if (cashSymbol === ACCOUNT_CASH) pf = allPf.value; // the account's cash secures puts in any portfolio
      return cashSecuring(cashSymbol, pf).reduce((sum, occ) => sum + reserveOf(pf.optionPositions[occ]), 0);
    }
    function coveredCalls(underlying, pf = pfFor(underlying)) {
      return openOptionsIn(pf).filter(occ => {
        const p = pf.optionPositions[occ];
        return p.underlying === underlying && p.side === 'short' && p.type === 'call' && p.covered?.by === 'shares';
      });
    }
    function sharesCovering(underlying, pf = pfFor(underlying)) {
      return coveredCalls(underlying, pf).reduce((sum, occ) => sum + sharesOf(pf.optionPositions[occ]), 0);
    }
    const totalReserved = computed(() => openOptionSymbols.value.reduce((sum, occ) => {
      const p = viewPf.value.optionPositions[occ];
      return sum + (p.side === 'short' && p.covered?.by === 'cash' ? reserveOf(p) : 0);
    }, 0));
    // How a short contract is covered, for badges and its detail line.
    function coverInfo(p) {
      if (p.side !== 'short') return null;
      if (p.covered?.by === 'cash') return { kind: 'cash', badge: 'Cash-secured', text: `Reserves ${formatUSD(reserveOf(p))} of ${cashName(p.covered.symbol)}` };
      if (p.covered?.by === 'shares') return { kind: 'shares', badge: 'Covered', text: `Covers ${formatShares(sharesOf(p))} ${p.underlying} shares · called away at ${formatUSD(reserveOf(p))}` };
      return { kind: 'naked', badge: 'Naked', text: 'Uncovered — usually needs margin approval' };
    }

    // Quotes for every contract in every portfolio (cards show each portfolio's value).
    const allOptionSymbols = computed(() => [...new Set(openOptionsIn(allPf.value).map(baseOcc))]);
    const optionQuotes = reactive({}); // OCC symbol → quote (+ error)
    async function fetchOptionQuotes(symbols = allOptionSymbols.value) {
      await Promise.all(symbols.map(async occ => {
        try {
          optionQuotes[occ] = { ...(await fetchQuote(occ)), error: null };
        } catch (e) {
          // Keep the last good price; expired contracts eventually stop quoting.
          optionQuotes[occ] = { ...(optionQuotes[occ] ?? {}), error: e.message };
        }
      }));
    }
    watch(allOptionSymbols, syms => {
      const missing = syms.filter(s => !optionQuotes[s]);
      if (missing.length) fetchOptionQuotes(missing);
    });
    const optionUnderlyings = computed(() => [...new Set(allOptionSymbols.value.map(occ => parseOcc(occ).underlying))]);
    watch(optionUnderlyings, syms => {
      const missing = syms.filter(s => !stockQuotes[s]);
      if (missing.length) fetchStockQuotes(missing);
    }, { immediate: true });

    // Value, G/L, days left, moneyness and breakeven at the current quotes.
    function optionSummary(occ) {
      const p = optionPositionFor(occ);
      if (!p) return null;
      const q = optionQuotes[baseOcc(occ)];
      const m = p.multiplier ?? MULTIPLIER;
      const sign = p.side === 'short' ? -1 : 1;
      const units = p.quantity * m;
      const days = daysToExpiry(p.expiry);
      const under = stockQuotes[p.underlying]?.price ?? null;
      // Once expired, a contract's last trade means nothing — it's worth its
      // intrinsic value (0 out of the money) until you record the expiry.
      let price = q?.price ?? null;
      if (days < 0 && under != null) price = Math.max(0, p.type === 'call' ? under - p.strike : p.strike - under);
      const basis = units * p.avgCost;     // paid (long) or received (short)
      const totalCost = sign * basis;      // a short's premium is a credit
      const value = price != null ? sign * units * price : null;
      const gain = value != null ? value - totalCost : null;
      return {
        ...p, symbol: occ, label: optionLabel(p, { withUnderlying: false }), price, basis, totalCost, value, gain,
        gainPct: gain != null && basis > 0 ? (gain / basis) * 100 : null,
        dayGain: q?.change != null ? sign * units * q.change : null,
        days, expired: days < 0, money: moneyness(p, under), breakeven: breakeven(p, p.avgCost),
        marketTime: q?.marketTime ?? null, loading: !q, quoteError: price == null && q?.error ? q.error : null,
        category: 'options', categoryLabel: 'Options',
      };
    }
    const optionTitle = o => `${optionLabel(o)} · ${o.side === 'short' ? 'sold' : 'bought'} at ${formatPrice(o.avgCost)} · breakeven ${formatPrice(o.breakeven)} at expiration`
      + (o.marketTime ? ` · last trade ${formatRelativeTime(o.marketTime)}` : '');

    // Cash holdings: take money out ('out') or put it in ('in'); undo with reverseCash.
    function moveCash(updates, src, amount, dir, pf) {
      const shares = amount / src.price;
      cashAdjust(updates, pf, src.symbol, dir === 'in' ? shares : -shares);
      return { cash: src.symbol, cashShares: shares, cashDir: dir };
    }
    function reverseCash(updates, tx, pf) {
      if (!tx.cash || !(tx.cashShares > 0)) return;
      // Money it took goes back (re-creating a holding that's gone); money it put in comes out.
      cashAdjust(updates, pf, tx.cash, tx.cashDir === 'out' ? tx.cashShares : -tx.cashShares);
    }
    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // ── Add an option (any list; signed in) ──
    const optionForms = reactive({}); // underlying → { side, type, expiry, strike, contracts, premium, date, cash, check, error }
    const checkTimers = {};
    function startOption(underlying) {
      optionForms[underlying] = {
        side: 'long', type: 'call', expiry: nextMonthlyExpiry() ?? '', strike: nearStrike(stockQuotes[underlying]?.price),
        contracts: '1', premium: '', premiumTouched: false, date: todayISO(), cash: null, check: null, error: null,
        covered: true, reserveFrom: null, // selling to open: covered by shares (call) or cash (put)
      };
      checkContract(underlying);
      const missing = Object.keys(pfFor(ticker).portfolio ?? {}).filter(sym => !stockQuotes[sym]);
      if (missing.length) fetchStockQuotes(missing);
    }
    function cancelOption(underlying) {
      delete optionForms[underlying];
    }
    // Expiration, strike or call/put changed: look the contract up shortly after typing stops.
    function onContractChange(underlying) {
      const f = optionForms[underlying];
      f.error = null;
      f.check = null;
      clearTimeout(checkTimers[underlying]);
      checkTimers[underlying] = setTimeout(() => checkContract(underlying), 400);
    }
    async function checkContract(underlying) {
      const f = optionForms[underlying];
      if (!f) return;
      const strike = Number(f.strike);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.expiry) || !(strike > 0)) { f.check = null; return; }
      const occ = occSymbol({ underlying, expiry: f.expiry, type: f.type, strike });
      f.check = { state: 'checking', symbol: occ };
      const current = () => optionForms[underlying]?.check?.symbol === occ;
      try {
        const q = await fetchQuote(occ);
        if (!current()) return;
        if (q.instrumentType && q.instrumentType !== 'OPTION') throw new Error('Not an option');
        optionQuotes[occ] = { ...q, error: null };
        f.check = { state: 'ok', symbol: occ, quote: q };
        if (!f.premiumTouched && q.price != null) f.premium = String(q.price); // the last price
      } catch {
        if (current()) f.check = { state: 'missing', symbol: occ };
      }
    }
    function optionCashFor(underlying) {
      const f = optionForms[underlying];
      if (!f) return '';
      // Buying pays (first funded source); selling to open deposits (first source).
      return f.cash ?? (f.side === 'long' ? fundedSource(underlying) : cashSources(underlying)[0]?.symbol ?? '');
    }
    function reserveFromFor(underlying) {
      const f = optionForms[underlying];
      if (!f) return '';
      return f.reserveFrom ?? cashSources(underlying)[0]?.symbol ?? '';
    }
    // What covering this sale needs and whether there's enough — null when not selling to open.
    function coverPreview(underlying) {
      const f = optionForms[underlying];
      if (f?.side !== 'short') return null;
      const n = Number(f.contracts);
      const strike = Number(f.strike);
      const prem = Number(f.premium) || 0;
      const occ = f.check?.state === 'ok' ? f.check.symbol : null;
      const existing = occ ? optionPositionFor(occ) : null;
      // Adding to a contract you're already short keeps how it's covered.
      const covered = existing?.side === 'short' ? !!existing.covered : f.covered;
      const ok = n > 0 && strike > 0;
      if (f.type === 'call') {
        const held = positionFor(underlying)?.quantity ?? 0;
        const free = held - sharesCovering(underlying);
        const need = ok ? n * MULTIPLIER : 0;
        return { kind: 'shares', covered, locked: !!existing, held, free, need, enough: free >= need - 1e-9, receive: ok ? need * strike : 0 };
      }
      const obligation = ok ? n * MULTIPLIER * strike : 0;
      const symbol = existing?.covered?.symbol ?? reserveFromFor(underlying);
      const src = cashSources(underlying).find(c => c.symbol === symbol) ?? null;
      // The premium lands in the same holding first when it's deposited there.
      const extra = src && optionCashFor(underlying) === src.symbol ? n * MULTIPLIER * prem : 0;
      const available = src ? src.available + extra : 0;
      return {
        kind: 'cash', covered, locked: !!existing, obligation, premium: ok ? n * MULTIPLIER * prem : 0,
        netCost: ok ? obligation - n * MULTIPLIER * prem : 0, src, available, after: available - obligation, withPremium: extra > 0,
        enough: !!src && available >= obligation - 0.005,
      };
    }
    function optionPreview(underlying) {
      const f = optionForms[underlying];
      const n = Number(f?.contracts);
      const prem = Number(f?.premium);
      if (f?.check?.state !== 'ok' || !(n > 0) || !(prem > 0)) return null;
      const occ = f.check.symbol;
      const amount = n * MULTIPLIER * prem;
      const p = optionPositionFor(occ);
      const conflict = p && p.side !== f.side ? p : null;
      const same = p && !conflict ? p : null;
      const quantity = (same?.quantity ?? 0) + n;
      const avg = same ? (same.quantity * same.avgCost + n * prem) / quantity : prem;
      const debit = f.side === 'long'; // buying costs money; selling to open brings it in
      const c = cashSources(underlying).find(x => x.symbol === optionCashFor(underlying)) ?? null;
      return {
        occ, amount, debit, quantity, avg, was: same, conflict,
        breakeven: breakeven({ type: f.type, strike: Number(f.strike) }, avg),
        cash: c && { symbol: c.symbol, available: c.available, after: c.available + (debit ? -amount : amount) },
      };
    }
    function saveOption(underlying) {
      const f = optionForms[underlying];
      if (f.check?.state === 'checking') { f.error = 'Still checking the contract — one moment.'; return; }
      if (f.check?.state !== 'ok') { f.error = 'Choose an expiration and strike that exist — the contract check has to pass.'; return; }
      const n = Number(f.contracts);
      if (!(Number.isInteger(n) && n > 0)) { f.error = 'Enter a whole number of contracts.'; return; }
      if (!(Number(f.premium) > 0)) { f.error = 'Enter the premium per share (e.g. 5.90).'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { f.error = 'Enter the trade date.'; return; }
      if (f.date > todayISO()) { f.error = "The trade date can't be in the future."; return; }
      const pfErr = newPortfolioNameError(underlying);
      if (pfErr) { f.error = pfErr; return; }
      const pv = optionPreview(underlying);
      if (pv.conflict) {
        f.error = `You're ${pv.conflict.side} this contract — close it on the Portfolio page rather than opening the other side.`;
        return;
      }
      const cv = coverPreview(underlying);
      if (cv?.covered && !cv.enough) {
        f.error = cv.kind === 'shares'
          ? `Covering ${f.contracts} call${n === 1 ? '' : 's'} takes ${formatShares(cv.need)} ${underlying} shares — you have ${formatShares(Math.max(0, cv.free))} not already covering calls. Sell fewer, or uncheck Covered.`
          : cv.src
            ? `Securing this put takes ${formatUSD(cv.obligation)} — ${cv.src.label} has ${formatUSD(Math.max(0, cv.available))} available. Sell fewer, pick another holding, or uncheck Covered.`
            : 'Securing a put needs a Cash holding (e.g. a money-market fund) in your portfolio — or uncheck Covered.';
        return;
      }
      const tx = { id: newId(), type: 'open', date: f.date, quantity: n, price: Number(f.premium) };
      const updates = {};
      const c = cashSources(underlying).find(x => x.symbol === optionCashFor(underlying));
      if (c) {
        if (pv.debit && pv.amount > c.available + 0.005) {
          f.error = `Only ${formatUSD(c.available)} in ${c.symbol} — pay from another holding, or choose "Outside the portfolio".`;
          return;
        }
        Object.assign(tx, moveCash(updates, c, pv.amount, pv.debit ? 'out' : 'in', pfFor(underlying)));
      }
      const o = parseOcc(pv.occ);
      const position = {
        underlying, type: o.type, strike: o.strike, expiry: o.expiry, side: f.side, multiplier: MULTIPLIER,
        quantity: pv.quantity, avgCost: pv.avg, transactions: [...(pv.was?.transactions ?? []), tx],
      };
      if (pv.was?.covered) position.covered = pv.was.covered;
      else if (cv?.covered) position.covered = cv.kind === 'shares' ? { by: 'shares' } : { by: 'cash', symbol: cv.src.symbol };
      emitPosition(underlying, { updates, options: { [pv.occ]: position } });
      delete optionForms[underlying];
    }

    // ── Close an option (Portfolio page): sell to close (long) or buy to close (short) ──
    const closeForms = reactive({}); // OCC → { contracts, price, date, cash, expire, error }
    function intrinsicFor(p) {
      const u = stockQuotes[p.underlying]?.price;
      return u == null ? null : Math.max(0, p.type === 'call' ? u - p.strike : p.strike - u);
    }
    function startClose(occ, { expire = false } = {}) {
      const p = optionPositionFor(occ);
      if (!p) return;
      const last = optionQuotes[occ]?.price;
      // Expiring: out of the money it's worth 0; in the money, about its intrinsic value.
      const price = expire ? (intrinsicFor(p) ?? 0) : last;
      closeForms[occ] = {
        contracts: String(p.quantity),
        price: price != null ? String(Math.round(price * 100) / 100) : '',
        date: expire && p.expiry < todayISO() ? p.expiry : todayISO(),
        cash: null, expire, error: null,
      };
      optionPanels[occ] = null;
    }
    function cancelClose(occ) {
      delete closeForms[occ];
    }
    function closeCashFor(occ) {
      const f = closeForms[occ];
      const p = optionPositionFor(occ);
      if (!f || !p) return '';
      // Buying back a short pays (first funded source); selling a long deposits.
      return f.cash ?? (p.side === 'short' ? fundedSource(p.underlying) : cashSources(p.underlying)[0]?.symbol ?? '');
    }
    function closePreview(occ) {
      const f = closeForms[occ];
      const p = optionPositionFor(occ);
      const n = Number(f?.contracts);
      const price = Number(f?.price);
      if (!p || !(n > 0) || !(price >= 0) || String(f.price).trim() === '') return null;
      const m = p.multiplier ?? MULTIPLIER;
      const amount = n * m * price;
      const credit = p.side === 'long'; // selling a long brings money in; buying back a short costs it
      const realized = (p.side === 'long' ? price - p.avgCost : p.avgCost - price) * n * m;
      let c = amount > 0 ? cashSources(p.underlying).find(x => x.symbol === closeCashFor(occ)) ?? null : null;
      // Buying back a cash-secured put frees its reserve — that cash can pay for it.
      if (c && p.covered?.by === 'cash' && p.covered.symbol === c.symbol) c = { ...c, available: c.available + n * m * p.strike };
      return {
        amount, credit, realized, realizedPct: p.avgCost > 0 ? (realized / (n * m * p.avgCost)) * 100 : null,
        remaining: p.quantity - n, tooMany: n > p.quantity, closes: n === p.quantity,
        cash: c && { symbol: c.symbol, available: c.available, after: c.available + (credit ? amount : -amount) },
      };
    }
    // Everything closed over a contract's life → its Closed positions record.
    function optionClosedRecord(occ, p, transactions, closedDate) {
      const m = p.multiplier ?? MULTIPLIER;
      const closes = transactions.filter(t => t.type === 'close');
      const n = closes.reduce((sum, t) => sum + t.quantity, 0);
      const opened = closes.reduce((sum, t) => sum + t.quantity * m * t.avgCost, 0);
      const closedAt = closes.reduce((sum, t) => sum + t.quantity * m * t.price, 0);
      const long = p.side === 'long';
      const opens = transactions.filter(t => t.type === 'open').map(t => t.date).sort();
      return {
        id: newId(), kind: 'option', symbol: occ, name: optionLabel(p),
        option: { underlying: p.underlying, type: p.type, strike: p.strike, expiry: p.expiry, side: p.side, multiplier: m, ...(p.covered ? { covered: p.covered } : {}) },
        sharesSold: n, avgOpen: n ? opened / (n * m) : 0, avgClose: n ? closedAt / (n * m) : 0,
        // Paid vs. received, so Realized = proceeds − cost basis for both sides.
        costBasis: long ? opened : closedAt, proceeds: long ? closedAt : opened, realized: long ? closedAt - opened : opened - closedAt,
        openedDate: opens[0] ?? null, closedDate, transactions,
      };
    }
    function saveClose(occ) {
      const f = closeForms[occ];
      const p = optionPositionFor(occ);
      if (!p) return;
      const n = Number(f.contracts);
      const price = Number(f.price);
      if (!(Number.isInteger(n) && n > 0)) { f.error = 'Enter a whole number of contracts.'; return; }
      if (n > p.quantity) { f.error = `You have ${p.quantity} contract${p.quantity === 1 ? '' : 's'} — you can't close more.`; return; }
      if (!(price >= 0) || String(f.price).trim() === '') { f.error = 'Enter the closing premium per share (0 if it expired worthless).'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { f.error = 'Enter the closing date.'; return; }
      if (f.date > todayISO()) { f.error = "The closing date can't be in the future."; return; }
      const pv = closePreview(occ);
      const tx = { id: newId(), type: 'close', date: f.date, quantity: n, price, avgCost: p.avgCost, realized: pv.realized };
      if (f.expire) tx.expired = true;
      const updates = {};
      const c = pv.cash && cashSources(p.underlying).find(x => x.symbol === pv.cash.symbol);
      if (c) {
        if (!pv.credit && pv.amount > pv.cash.available + 0.005) {
          f.error = `Only ${formatUSD(pv.cash.available)} available in ${c.symbol} — pay from another holding, or choose "Outside the portfolio".`;
          return;
        }
        Object.assign(tx, moveCash(updates, c, pv.amount, pv.credit ? 'in' : 'out', pfFor(p.underlying)));
      }
      const transactions = [...(p.transactions ?? []), tx];
      let closed;
      const options = {};
      if (pv.closes) {
        options[occ] = null;
        closed = [optionClosedRecord(occ, p, transactions, f.date), ...closedIn(p.underlying)];
      } else {
        options[occ] = { ...p, quantity: p.quantity - n, transactions };
      }
      emitPosition(underlyingOf(occ), closed ? { updates, options, closed } : { updates, options });
      delete closeForms[occ];
    }

    // An option row's open panel: 'history' (its transactions) | 'alerts' | null.
    const optionPanels = reactive({});
    function toggleOptionPanel(occ, panel) {
      optionPanels[occ] = optionPanels[occ] === panel ? null : panel;
      if (optionPanels[occ]) delete closeForms[occ];
    }
    function optionTransactions(occ) {
      return [...(optionPositionFor(occ)?.transactions ?? [])]
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    }
    function deleteOptionTransaction(occ, tx) {
      const p = optionPositionFor(occ);
      if (!p) return;
      const m = p.multiplier ?? MULTIPLIER;
      const amount = tx.quantity * m * tx.price;
      const cashNote = tx.cash ? `\n${formatUSD(amount)} ${tx.cashDir === 'out' ? 'goes back to' : 'comes back out of'} ${cashName(tx.cash)}.` : '';
      const what = tx.type === 'close' ? 'closing trade' : 'opening trade';
      if (!confirm(`Delete this ${what}?\n\n${tx.quantity} × ${optionLabel(p)} at ${formatPrice(tx.price)} on ${tx.date}${cashNote}`)) return;
      const updates = {};
      reverseCash(updates, tx, pfFor(underlyingOf(occ)));
      const rest = (p.transactions ?? []).filter(t => t.id !== tx.id);
      let position;
      if (tx.type === 'close') {
        position = { ...p, quantity: p.quantity + tx.quantity, transactions: rest };
      } else {
        const quantity = p.quantity - tx.quantity;
        const reversed = quantity > 0 ? (p.quantity * p.avgCost - tx.quantity * tx.price) / quantity : 0;
        position = quantity > 0 ? { ...p, quantity, avgCost: reversed > 0 ? reversed : p.avgCost, transactions: rest } : null;
      }
      emitPosition(underlyingOf(occ), { updates, options: { [occ]: position } });
    }
    function removeOption(occ) {
      const p = optionPositionFor(occ);
      if (!p || !confirm(`Remove ${optionLabel(p)} from your portfolio?\n\nThis deletes the position and its trades without changing any cash holding — to record a sale or expiry, use Close instead.`)) return;
      emitPosition(underlyingOf(occ), { options: { [occ]: null } });
    }
    // Options card: "Open XOM" — the stock's card in Holdings, on its Portfolio tab.
    function openOptionsOf(underlying) {
      holdingsOpen.value = true;
      ensureDetail(underlying);
      if (!details[underlying].open) toggleDetail(underlying);
      else setDetailTab(underlying, 'portfolio');
      nextTick(() => watchlistEl.value?.querySelector(`[data-ticker="${CSS.escape(underlying)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }

    // Category: the one chosen on the position, else automatic from Yahoo's
    // instrument type (null until the quote has loaded).
    function autoCategoryFor(ticker) {
      const type = stockQuotes[ticker]?.instrumentType;
      return type ? autoCategory(type) : null;
    }
    function categoryFor(ticker) {
      return positionFor(ticker)?.category || autoCategoryFor(ticker);
    }

    // ── Sectors (equities only), for the Portfolio page's sector chart ──
    const sectors = reactive({}); // ticker → sector string | null (none) — absent while loading
    function loadSector(ticker) {
      if (ticker in sectors) return;
      fetchSector(ticker)
        .then(info => { sectors[ticker] = info?.sector ?? null; })
        .catch(() => { sectors[ticker] = null; });
    }
    watch(() => (props.portfolioOnly ? portfolioTickers.value : []), syms => syms.forEach(loadSector), { immediate: true });

    // Totals across the Portfolio list. Value and G/L wait until every
    // position has a price, so they're never a misleading partial sum.
    const holdingRows = () => [
      ...portfolioTickers.value.map(positionSummary).filter(Boolean),
      ...openOptionSymbols.value.map(optionSummary),
    ];
    function totalsOf(rows) {
      if (!rows.length) return null;
      const totalCost = rows.reduce((sum, r) => sum + r.totalCost, 0);
      const priced = rows.every(r => r.value != null);
      const value = priced ? rows.reduce((sum, r) => sum + r.value, 0) : null;
      const gain = value != null ? value - totalCost : null;
      const gainPct = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
      // Holdings with no daily change (e.g. a $1 money-market fund) add nothing.
      const changed = rows.filter(r => r.dayGain != null);
      const dayGain = changed.length ? changed.reduce((sum, r) => sum + r.dayGain, 0) : null;
      // Today's % is relative to yesterday's value (today's value − today's G/L).
      const dayPct = dayGain != null && value != null && value - dayGain > 0 ? (dayGain / (value - dayGain)) * 100 : null;
      return { count: rows.length, totalCost, value, gain, gainPct, dayGain, dayPct };
    }
    // Holdings card: stocks, funds, cash…
    const portfolioTotals = computed(() => totalsOf(portfolioTickers.value.map(positionSummary).filter(Boolean)));
    // Options card: value nets long (+) and short (−) contracts; G/L % is vs. premium paid + received.
    const optionsTotals = computed(() => {
      const rows = openOptionSymbols.value.map(optionSummary);
      const t = totalsOf(rows);
      if (!t) return null;
      const basis = rows.reduce((sum, r) => sum + r.basis, 0);
      return { ...t, gainPct: t.gain != null && basis > 0 ? (t.gain / basis) * 100 : null, dayPct: null };
    });
    // Whole portfolio: holdings + options.
    // Whole account (Summary): holdings + options + the account's cash.
    const netValue = computed(() => {
      if (portfolioTotals.value && portfolioTotals.value.value == null) return null;
      if (optionsTotals.value && optionsTotals.value.value == null) return null;
      const h = portfolioTotals.value?.value ?? 0;
      const o = optionsTotals.value?.value ?? 0;
      const cash = openPf.value ? 0 : (accountCash.value.balance ?? 0);
      return { holdings: h, options: o, cash, total: h + o + cash };
    });

    // The account card (Summary): every portfolio plus the account's cash.
    // 1D % is against yesterday's total; all-time % is over the money
    // invested (cash, which doesn't gain, isn't in that base).
    const accountMetrics = computed(() => {
      const m = summarizePortfolio(allPf.value, quoteOf, (sym, p) => (p.category || autoCategoryFor(sym)) === 'cash');
      const cash = accountCash.value.balance ?? 0;
      const value = m.value != null ? m.value + cash : null;
      const options = optionsTotals.value?.value ?? 0;
      const prev = value != null && m.dayGain != null ? value - m.dayGain : null;
      return {
        ...m, value, cash, options, holdings: value != null ? value - cash - options : null,
        dayPct: m.dayGain != null && prev > 0 ? (m.dayGain / prev) * 100 : null,
      };
    });

    // ── Summary → Cash: deposits from your bank accounts (Profile → Bank accounts) ──
    // No balance or bank check yet: a deposit just adds to the account's cash.
    const bankAccounts = ref(null); // loaded when the deposit form opens
    const depositForm = ref(null);  // { amount, date, bankId, busy, error }
    const showAllDeposits = ref(false);
    async function startDeposit() {
      depositForm.value = { amount: '', date: todayISO(), bankId: null, error: null, loading: true };
      try {
        bankAccounts.value = await fetchBankAccounts();
      } catch (e) {
        if (depositForm.value) depositForm.value.error = `Couldn't load your bank accounts: ${e.message}`;
      }
      if (depositForm.value) depositForm.value.loading = false;
    }
    const connectedBanks = computed(() => (bankAccounts.value ?? []).filter(a => a.status === 'connected'));
    const depositBankFor = f => f.bankId ?? connectedBanks.value[0]?.id ?? null;
    function saveDeposit() {
      const f = depositForm.value;
      const amount = Math.round(Number(f.amount) * 100) / 100;
      if (!(amount > 0)) { f.error = 'Enter the amount to deposit.'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { f.error = 'Enter the deposit date.'; return; }
      if (f.date > todayISO()) { f.error = "The deposit date can't be in the future."; return; }
      const bank = connectedBanks.value.find(a => a.id === Number(depositBankFor(f)));
      if (!bank) { f.error = 'Pick a connected bank account to deposit from.'; return; }
      const cur = accountCash.value;
      const deposit = {
        id: newId(), date: f.date, amount,
        bankAccountId: bank.id, bank: bank.bank, last4: bank.last4, type: bank.type, // kept if the account is later removed
      };
      emit('set-account-cash', {
        ...cur,
        balance: Math.round(((cur.balance ?? 0) + amount) * 100) / 100,
        deposits: [deposit, ...(cur.deposits ?? [])],
      });
      depositForm.value = null;
    }
    function deleteDeposit(d) {
      if (!confirm(`Delete this deposit?\n\n${formatUSD(d.amount)} from ${d.bank} ••${d.last4} on ${d.date}\n\nIt comes back out of your account's cash.`)) return;
      const cur = accountCash.value;
      emit('set-account-cash', {
        ...cur,
        balance: Math.round(((cur.balance ?? 0) - d.amount) * 100) / 100,
        deposits: (cur.deposits ?? []).filter(x => x.id !== d.id),
      });
    }
    const depositsShown = computed(() => {
      const list = [...(accountCash.value.deposits ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      return showAllDeposits.value ? list : list.slice(0, 5);
    });
    // Under the allocation charts: what short options (left out of them) amount to.
    const shortSummary = computed(() => {
      const shorts = openOptionSymbols.value.map(optionSummary).filter(o => o.side === 'short');
      if (!shorts.length) return null;
      const priced = shorts.every(o => o.value != null);
      return {
        count: shorts.length,
        value: priced ? shorts.reduce((sum, o) => sum + o.value, 0) : null,
        reserved: totalReserved.value,
        shares: optionUnderlyings.value.reduce((sum, u) => sum + sharesCovering(u), 0),
      };
    });

    // ── Options card (Portfolio page): every open contract, grouped by expiration ──
    // ── Sorting the Portfolio page's Holdings and Options (remembered per browser) ──
    // A sort is { key, dir }; clicking the active key flips the direction.
    // Numbers start largest-first, text A→Z; missing values always go last.
    const HOLDING_SORTS = [
      { id: 'added',   label: 'Added', text: true },
      { id: 'symbol',  label: 'Stock', text: true },
      { id: 'last',    label: 'Last' },
      { id: 'chg',     label: 'Chg' },
      { id: 'chgPct',  label: 'Chg %' },
      { id: 'volume',  label: 'Vol' },
      { id: 'value',   label: 'Weight' }, // = market value
      { id: 'gain',    label: 'G/L' },
      { id: 'gainPct', label: 'G/L %' },
    ];
    const OPTION_SORTS = [
      { id: 'expiry',    label: 'Expiration', text: true },
      { id: 'symbol',    label: 'Stock', text: true },
      { id: 'strike',    label: 'Strike' },
      { id: 'contracts', label: 'Contracts' },
      { id: 'last',      label: 'Last' },
      { id: 'value',     label: 'Value' },
      { id: 'gain',      label: 'G/L' },
      { id: 'gainPct',   label: 'G/L %' },
    ];
    function savedSort(key, list, fallback) {
      try {
        const v = JSON.parse(localStorage.getItem(key));
        if (list.some(o => o.id === v?.key) && (v.dir === 'asc' || v.dir === 'desc')) return v;
      } catch { /* none saved */ }
      return fallback;
    }
    const holdingSort = ref(savedSort('oilgas_holdings_sort', HOLDING_SORTS, { key: 'added', dir: 'asc' }));
    const optionSort = ref(savedSort('oilgas_options_sort', OPTION_SORTS, { key: 'expiry', dir: 'asc' }));
    watch(holdingSort, v => { try { localStorage.setItem('oilgas_holdings_sort', JSON.stringify(v)); } catch { /* per-browser only */ } });
    watch(optionSort, v => { try { localStorage.setItem('oilgas_options_sort', JSON.stringify(v)); } catch { /* per-browser only */ } });
    // which: 'holdings' | 'options' (templates unwrap refs, so pass a name).
    function setSort(name, key) {
      const which = name === 'options' ? optionSort : holdingSort;
      const list = name === 'options' ? OPTION_SORTS : HOLDING_SORTS;
      const cur = which.value;
      if (cur.key === key) which.value = { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      else which.value = { key, dir: list.find(o => o.id === key)?.text ? 'asc' : 'desc' };
    }
    // Compare two values in a direction; null/undefined last either way.
    function cmp(a, b, dir) {
      const na = a == null || (typeof a === 'number' && !Number.isFinite(a));
      const nb = b == null || (typeof b === 'number' && !Number.isFinite(b));
      if (na || nb) return na === nb ? 0 : na ? 1 : -1;
      const c = typeof a === 'string' ? a.localeCompare(b) : a - b;
      return dir === 'asc' ? c : -c;
    }
    const sortedHoldings = computed(() => {
      const { key, dir } = holdingSort.value;
      const base = portfolioTickers.value;
      if (key === 'added') return dir === 'asc' ? base : [...base].reverse();
      const val = sym => {
        const q = stockQuotes[sym];
        switch (key) {
          case 'symbol': return sym;
          case 'last': return q?.price;
          case 'chg': return q?.change;
          case 'chgPct': return q?.pctChange;
          case 'volume': return q?.volume;
          default: return positionSummary(sym)?.[key];
        }
      };
      return [...base].sort((a, b) => cmp(val(a), val(b), dir) || a.localeCompare(b));
    });
    holdingsOrder.value = sortedHoldings;
    // An opened portfolio's holdings by value, for its Holdings view (null until every price is in).
    // On the Summary (all portfolios combined) the account's cash is a holding too.
    const overviewHoldings = computed(() => {
      const rows = portfolioTickers.value.map(positionSummary).filter(Boolean);
      if (rows.some(r => r.value == null)) return null;
      const out = rows.map(r => ({ symbol: r.symbol, name: stockQuotes[r.symbol]?.shortName ?? '', value: r.value }));
      const cash = openPf.value ? 0 : (accountCash.value.balance ?? 0);
      if (cash > 0) out.push({ symbol: 'Cash', name: 'Account cash', value: cash });
      return out;
    });
    // Each holding's share of the Holdings' total market value (options have
    // their own card). Waits for every price, like the totals.
    function holdingWeight(sym) {
      const total = portfolioTotals.value?.value;
      const value = positionSummary(sym)?.value;
      if (!(total > 0) || value == null) return null;
      return { pct: (value / total) * 100, value, total };
    }
    // Options: by expiration they're grouped by date; any other sort is one flat list.
    const sortedOptions = computed(() => {
      const { key, dir } = optionSort.value;
      const val = occ => {
        const o = optionSummary(occ);
        switch (key) {
          case 'symbol': return o.underlying;
          case 'expiry': return o.expiry;
          case 'contracts': return o.quantity;
          case 'last': return o.price;
          default: return o[key];
        }
      };
      return [...openOptionSymbols.value].sort((a, b) => cmp(val(a), val(b), dir)
        || viewPf.value.optionPositions[a].expiry.localeCompare(viewPf.value.optionPositions[b].expiry)
        || a.localeCompare(b));
    });

    const optionGroups = computed(() => {
      const groups = new Map();
      for (const occ of openOptionSymbols.value) {
        const p = viewPf.value.optionPositions[occ];
        if (!groups.has(p.expiry)) groups.set(p.expiry, []);
        groups.get(p.expiry).push(occ);
      }
      const desc = optionSort.value.key === 'expiry' && optionSort.value.dir === 'desc';
      return [...groups.entries()]
        .sort(([a], [b]) => (desc ? b.localeCompare(a) : a.localeCompare(b)))
        .map(([expiry, items]) => ({
          expiry, days: daysToExpiry(expiry),
          items: items.sort((a, b) => viewPf.value.optionPositions[a].underlying.localeCompare(viewPf.value.optionPositions[b].underlying)
            || viewPf.value.optionPositions[a].strike - viewPf.value.optionPositions[b].strike),
        }));
    });

    const OPTIONS_KEY = 'oilgas_options_open';
    const optionsOpen = ref((() => {
      try { return localStorage.getItem(OPTIONS_KEY) !== '0'; } catch { return true; }
    })());
    watch(optionsOpen, open => { try { localStorage.setItem(OPTIONS_KEY, open ? '1' : '0'); } catch { /* per-browser only */ } });
    // ＋ Add option from the card: type a ticker, then the usual option form.
    const optionAdd = reactive({ input: '', ticker: '', busy: false, error: null });
    async function startOptionAdd() {
      const t = optionAdd.input.trim().toUpperCase();
      optionAdd.error = null;
      if (!optionable(t)) { optionAdd.error = 'Enter a US stock ticker, like XOM.'; return; }
      optionAdd.busy = true;
      if (stockQuotes[t]?.price == null) await fetchStockQuotes([t]);
      optionAdd.busy = false;
      if (stockQuotes[t]?.price == null) { optionAdd.error = `Couldn't find a quote for ${t}.`; return; }
      optionAdd.ticker = t;
      optionAdd.input = '';
      startOption(t);
    }

    // ── Allocation charts (Portfolio page), shown side by side ──
    // Slices wait for every price and category (and, by sector, every
    // stock's sector) so a chart never shows a partial picture.
    const categoryOrder = CATEGORIES.map(c => c.id);
    // Short options are liabilities (negative value), so the charts leave them out.
    function allocationRows() {
      const rows = holdingRows();
      if (rows.some(r => r.value == null || !r.category)) return null;
      // The account's cash counts as Cash on the Summary (it isn't in any one portfolio).
      const cash = openPf.value ? 0 : (accountCash.value.balance ?? 0);
      if (cash > 0) rows.push({ symbol: 'Account cash', category: 'cash', categoryLabel: CATEGORY_LABELS.cash, value: cash });
      return rows.filter(r => r.value > 0);
    }
    const allocationByType = computed(() => {
      const rows = allocationRows();
      if (!rows) return null;
      return assignSlots(buildSlices([
        ...rows.map(r => ({ key: r.category, label: r.categoryLabel, short: CATEGORY_SHORT[r.category], value: r.value, symbol: r.symbol })),
      ], categoryOrder));
    });
    const allocationBySector = computed(() => {
      const rows = allocationRows();
      if (!rows) return null;

      // By sector: stocks by their sector; everything else by its category
      // (fund sector breakdowns aren't available without Yahoo auth).
      if (rows.some(r => r.category === 'stocks' && !(r.symbol in sectors))) return null;
      const items = rows.map(r => {
        if (r.category !== 'stocks') return { key: r.category, label: r.categoryLabel, short: CATEGORY_SHORT[r.category], value: r.value, symbol: r.symbol };
        const sector = sectors[r.symbol];
        return sector
          ? { key: 'sector:' + sector, label: sector, short: shortSector(sector), value: r.value, symbol: r.symbol }
          : { key: 'sector:?', label: 'Unclassified stocks', short: 'Unclassified', value: r.value, symbol: r.symbol };
      });
      const sectorKeys = [...new Set(items.filter(i => i.key.startsWith('sector:') && i.key !== 'sector:?').map(i => i.key))].sort();
      return assignSlots(buildSlices(items, [...sectorKeys, 'sector:?', ...categoryOrder]));
    });
    const hasNonStockHoldings = computed(() =>
      portfolioTickers.value.some(t => categoryFor(t) && categoryFor(t) !== 'stocks') || openOptionSymbols.value.length > 0
    );
    const hasShortOptions = computed(() => openOptionSymbols.value.some(occ => viewPf.value.optionPositions[occ].side === 'short'));

    // ── 52-week range bar on every card ──
    // Positions (0–100%) along a scale spanning the 52-week low→high. On the
    // Portfolio page (withAvg) it also marks your average cost — the scale
    // widens to include it when it falls outside the range — and colors
    // price vs. cost; watchlists show just the range and today's price.
    // null when there's no real range (e.g. a $1 money-market fund).
    function rangeFor(ticker, withAvg = false) {
      const q = stockQuotes[ticker];
      const lo = q?.fiftyTwoWeekLow;
      const hi = q?.fiftyTwoWeekHigh;
      const price = q?.price;
      if (![lo, hi, price].every(Number.isFinite) || !(hi > lo)) return null;
      const avg = withAvg ? positionFor(ticker)?.avgCost ?? null : null;
      if (withAvg && avg == null) return null;
      const min = Math.min(lo, price, avg ?? lo);
      const max = Math.max(hi, price, avg ?? hi);
      const at = v => ((v - min) / (max - min)) * 100;
      const pctOfRange = ((price - lo) / (hi - lo)) * 100;
      const tip = `52-week range ${formatPrice(lo)} – ${formatPrice(hi)} · price ${formatPrice(price)} (${Math.round(pctOfRange)}% of range)`
        + (avg != null ? ` · avg cost ${formatPrice(avg)}` : '');
      return {
        lo, hi, price, avg, tip,
        gain: avg != null ? price >= avg : null,
        loAt: at(lo), hiAt: at(hi), priceAt: at(price), avgAt: avg != null ? at(avg) : null,
      };
    }

    // Range-bar labels: exact under 10K, compact above (57.7K) so a
    // bitcoin-sized price doesn't crowd the bar. Tooltips keep exact values.
    function rangeLabel(v) {
      return Math.abs(v) >= 10000 ? formatCompactNumber(v, 1) : formatPrice(v);
    }

    // Whole or fractional shares, without trailing zeros (100, 12.5, 0.0035).
    const sharesFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
    function formatShares(n) { return sharesFormat.format(n); }
    function signedUSD(v) { return (v > 0 ? '+' : '') + formatUSD(v); }

    // Total cost, market value and gain/loss at the current quote. Value
    // and G/L are null until a price has loaded.
    function positionSummary(ticker) {
      const p = positionFor(ticker);
      if (!p) return null;
      const q = stockQuotes[ticker];
      const price = q?.price ?? null;
      const totalCost = p.quantity * p.avgCost;
      const value = price != null ? p.quantity * price : null;
      const gain = value != null ? value - totalCost : null;
      const gainPct = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
      const dayGain = q?.change != null ? p.quantity * q.change : null;
      const category = categoryFor(ticker);
      return {
        ...p, symbol: ticker, price, totalCost, value, gain, gainPct, dayGain, dayPct: q?.pctChange ?? null,
        category, categoryLabel: category ? CATEGORY_LABELS[category] : null, categoryIsAuto: !p.category,
      };
    }

    function toggleDetail(ticker) {
      if (suppressHeaderClick || editMode.value) return;
      ensureDetail(ticker);
      // In the Portfolio list, cards open straight to the position.
      if (!details[ticker].open && isPortfolioList.value) details[ticker].tab = 'portfolio';
      details[ticker].open = !details[ticker].open;
      if (details[ticker].open) loadActiveTab(ticker);
    }

    function setDetailTab(ticker, tab) {
      if (!details[ticker] || details[ticker].tab === tab) return;
      details[ticker].tab = tab;
      loadActiveTab(ticker);
    }

    function setDocsTab(ticker, tab) {
      if (details[ticker]) details[ticker].docs.activeTab = tab;
    }

    function filingsForTab(ticker, tab) {
      return (details[ticker]?.docs.filings ?? []).filter(f => f.form === tab);
    }

    // Chart series is fetched ascending already, but sort defensively —
    // same belt-and-suspenders as the Oil & Gas Markets spread history,
    // since a future change to the fetch order shouldn't silently corrupt
    // the chart's left-to-right ordering.
    function filteredChartData(ticker) {
      const d = details[ticker]?.chart;
      if (!d) return [];
      if (d.range === '1D') return intraday[ticker]?.series ?? [];
      const cutoff = cutoffDateFor(d.range);
      return d.series
        .filter(r => new Date(r.period) >= cutoff)
        .slice()
        .sort((a, b) => a.period.localeCompare(b.period));
    }

    return {
      tickers, stockQuotes, sparklines, lastUpdated,
      customLists, listsLoading, listsError, activeListId, activeList, selectList,
      listForm, listNameInput, openListForm, submitListForm, deleteActiveList,
      editMode, removeTicker, MAX_LIST_TICKERS, listFull,
      selected, isSelected, toggleSelected, allSelected, selectAll, clearSelected, removeSelected,
      transfer, openTransfer, closeTransfer, transferTargets, doTransfer, createAndTransfer, transferToast, undoTransfer,
      searchQuery, searchResults, searchLoading, searchError, searchOpen, searchIndex,
      justAdded, inActiveList, addTicker, onSearchKeydown, onSearchBlur,
      wlMenuOpen, wlMenuRoot, wlMenuButton, wlMenu, onWlMenuButtonKeydown, onWlMenuKeydown, menuAction,
      searchShown, searchInput, openSearch, closeSearch,
      watchlistEl, draggingTicker,
      onHandlePointerDown, onHandleKeydown, onCardPointerDown, onCardContextMenu,
      indexSymbols, indexes, INDEX_LABELS,
      details, toggleDetail, setDetailTab, setDocsTab, filingsForTab, filteredChartData, keyStats, onNewsImageError,
      intraday, FORM_TABS, STOCK_RANGE_OPTIONS,
      positionForms, positionFor, positionSummary, formatShares, signedUSD,
      purchaseForms, startPurchase, cancelPurchase, purchasePreview, savePurchase, transactionsFor, deleteTransaction,
      cashSources, payFromFor,
      moveForms, startMove, cancelMove, movePreview, saveMove, movableOptions, isTransfer,
      saleForms, startSale, cancelSale, depositToFor, salePreview, saveSale, closedPositions, closedTotals,
      reopenClosed, deleteClosed, realizedFor, closedOpen,
      optionable, optionsFor, optionSummary, optionTitle, optionQuotes, optionForms, startOption, cancelOption, onContractChange,
      optionCashFor, optionPreview, saveOption, closeForms, startClose, cancelClose, closeCashFor, closePreview, saveClose,
      optionPanels, toggleOptionPanel, optionTransactions, deleteOptionTransaction, removeOption, openOptionsOf,
      optionPositionFor, optionAlertPresets, hasShortOptions, optionLabel, MULTIPLIER,
      categoryFor, reserveFromFor, coverPreview, coverInfo, cashReserved, cashSecuring, sharesCovering, coveredCalls, totalReserved,
      isPortfolioList, portfolioTotals, optionsTotals, netValue, shortSummary, optionGroups, optionsOpen, optionAdd, startOptionAdd,
      openOptionSymbols, tickers, PORTFOLIO_TABS, pfTab, onPositions,
      portfolios, openPf, openPfId, pfFor, pfChoice, choosePortfolio, holdsIn, DEFAULT_PORTFOLIO_NAME,
      pfForm, openPfForm, submitPfForm, onPfFormInput, deletePortfolio, pfMetrics, pfError, accountMetrics,
      pfImageBusy, pfImageError, changePortfolioImage, clearPortfolioImage, pfInitials,
      accountCash, cashName, ACCOUNT_CASH, cashReserved, depositForm, startDeposit, connectedBanks, depositBankFor, saveDeposit, deleteDeposit,
      depositsShown, showAllDeposits, bankAccounts, BANK_TYPES,
      overviewHoldings, viewPf,
      HOLDING_SORTS, OPTION_SORTS, holdingSort, optionSort, setSort, sortedOptions, holdingWeight,
      CATEGORIES, CATEGORY_LABELS, autoCategoryFor, rangeFor, rangeLabel,
      moverSources, moverSelected, openMover, holdingsOpen,
      notesStore, findNote, noteForms, noteKey, openNoteForm, closeNoteForm, saveNewNote,
      alertsStore, alertsFor, activeAlertCount, alertForms, openAlertForm, closeAlertForm, submitAlert,
      toggleAlert, deleteAlertConfirm, alertStatus, describeAlert, alertPresets,
      allocationByType, allocationBySector, hasNonStockHoldings, startPositionEdit, cancelPositionEdit, savePosition, removePosition,
      buildFilingUrl, buildIndexUrl, getTranscriptLinks,
      formatUSD, formatPrice, formatNumber, formatPct, formatVolume, formatDate, formatRelativeTime, changeClass,
      PERIODS, perfDiff, lastCloseDate, earnings, earningsSoon, earningsTitle, upcomingEvents,
      safeArticleUrl, onArticleClick,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16" v-if="portfolioOnly">
        <div class="section-header" style="margin-bottom:0">Account</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
      </div>
      <div class="subtab-bar account-tabs" role="tablist" aria-label="Account sections" v-if="portfolioOnly">
        <button v-for="t in PORTFOLIO_TABS" :key="t.id" type="button" role="tab" class="subtab-btn"
                :class="{ active: pfTab === t.id }" :aria-selected="pfTab === t.id" :aria-label="t.label" @click="pfTab = t.id"><span class="label-full">{{ t.label }}</span><span class="label-short" aria-hidden="true">{{ t.short ?? t.label }}</span></button>
      </div>

      <!-- Portfolio → Summary: the whole portfolio, when there are options too -->
      <!-- Account → Summary: the whole account, like a portfolio card — total value,
           1D and all-time — with its cash and deposits at the bottom -->
      <div class="card cash-card account-card-summary" v-if="portfolioOnly && pfTab === 'summary' && user">
        <template v-for="m in [accountMetrics]" :key="'acct'">
          <div class="acct-head">
            <span class="pf-card-name">Account <span class="text-muted acct-sub">· {{ portfolios.length }} portfolio{{ portfolios.length === 1 ? '' : 's' }}</span></span>
          </div>
          <div class="acct-main">
            <div>
              <span class="pf-card-label">Total value</span>
              <div class="pf-card-value">{{ m.value != null ? formatUSD(m.value) : '…' }}</div>
            </div>
            <span class="pf-card-stats">
              <span><span class="pf-card-label">1D</span> <strong :class="changeClass(m.dayPct)">{{ m.dayPct != null ? formatPct(m.dayPct) : '—' }}</strong></span>
              <span><span class="pf-card-label">All-time</span> <strong :class="changeClass(m.allTimePct)">{{ m.allTimePct != null ? formatPct(m.allTimePct) : '—' }}</strong></span>
            </span>
          </div>
          <p class="text-muted text-sm acct-breakdown" v-if="m.value != null">
            {{ 'Holdings ' + formatUSD(m.holdings)
              + (openOptionSymbols.length ? (m.options < 0 ? ' − ' : ' + ') + 'options ' + formatUSD(Math.abs(m.options)) : '')
              + ((m.cash ?? 0) !== 0 ? (m.cash < 0 ? ' − ' : ' + ') + 'cash ' + formatUSD(Math.abs(m.cash)) : '') }}
            · {{ m.positions }} position{{ m.positions === 1 ? '' : 's' }}
          </p>
        </template>

        <div class="cash-head acct-cash">
          <div>
            <div class="pf-card-label">Cash</div>
            <div class="cash-balance" :class="{ negative: (accountCash.balance ?? 0) < 0 }">{{ formatUSD(accountCash.balance ?? 0) }}</div>
            <div class="text-muted text-sm" v-if="cashReserved(ACCOUNT_CASH) > 0">
              {{ formatUSD(cashReserved(ACCOUNT_CASH)) }} reserved for cash-secured puts · {{ formatUSD((accountCash.balance ?? 0) - cashReserved(ACCOUNT_CASH)) }} available
            </div>
          </div>
          <button type="button" class="primary" v-if="!depositForm" @click="startDeposit">＋ Deposit</button>
        </div>

        <form class="portfolio-form deposit-form" v-if="depositForm" @submit.prevent="saveDeposit" novalidate @input="depositForm.error = null">
          <div class="skeleton" style="height:60px" v-if="depositForm.loading"></div>
          <template v-else-if="!connectedBanks.length">
            <p class="text-muted text-sm" style="margin:0">
              {{ (bankAccounts ?? []).length ? 'None of your bank accounts is connected.' : 'Add a bank account to deposit from.' }}
              <a href="#" @click.prevent="$emit('go-bank-accounts')">Profile → Bank accounts</a>
            </p>
            <div class="portfolio-actions"><button type="button" @click="depositForm = null">Close</button></div>
          </template>
          <template v-else>
            <div class="portfolio-fields">
              <label>
                <span>Amount</span>
                <input type="number" inputmode="decimal" min="0" step="0.01" v-model="depositForm.amount" placeholder="e.g. 5000" />
              </label>
              <label>
                <span>Date</span>
                <input type="date" :max="new Date().toLocaleDateString('en-CA')" v-model="depositForm.date" />
              </label>
              <label>
                <span>From</span>
                <select :value="depositBankFor(depositForm)" @change="depositForm.bankId = Number($event.target.value)">
                  <option v-for="a in connectedBanks" :key="a.id" :value="a.id">{{ a.bank }} {{ (BANK_TYPES.find(t => t.id === a.type)?.label ?? a.type).toLowerCase() }} ••{{ a.last4 }}</option>
                </select>
              </label>
            </div>
            <p class="purchase-preview" v-if="Number(depositForm.amount) > 0">
              Cash: {{ formatUSD(accountCash.balance ?? 0) }} → {{ formatUSD((accountCash.balance ?? 0) + Math.round(Number(depositForm.amount) * 100) / 100) }}
            </p>
            <div class="notice error portfolio-error" v-if="depositForm.error">{{ depositForm.error }}</div>
            <div class="portfolio-actions">
              <button type="submit" class="primary">Deposit</button>
              <button type="button" @click="depositForm = null">Cancel</button>
            </div>
          </template>
        </form>

        <ul class="deposit-list" v-if="depositsShown.length">
          <li v-for="d in depositsShown" :key="d.id" class="deposit-row">
            <span class="deposit-date">{{ formatDate(d.date + 'T12:00:00') }}</span>
            <span class="deposit-what">Deposit from {{ d.bank }} {{ (BANK_TYPES.find(t => t.id === d.type)?.label ?? d.type).toLowerCase() }} ••{{ d.last4 }}</span>
            <span class="deposit-amount positive">+{{ formatUSD(d.amount) }}</span>
            <button type="button" class="link-button danger-link" :aria-label="'Delete deposit of ' + formatUSD(d.amount)" title="Delete this deposit" @click="deleteDeposit(d)">✕</button>
          </li>
        </ul>
        <button type="button" class="link-button deposit-more" v-if="(accountCash.deposits ?? []).length > 5"
                @click="showAllDeposits = !showAllDeposits">{{ showAllDeposits ? 'Show fewer' : 'Show all ' + accountCash.deposits.length + ' deposits' }}</button>
        <p class="text-muted text-sm cash-note" v-else-if="!(accountCash.deposits ?? []).length && !depositForm">
          Deposit from a bank account to fund purchases — pick <strong>Account cash</strong> under "Pay from" on a stock's Portfolio tab.
        </p>
      </div>

      <template v-if="!portfolioOnly">
      <!-- Major Market Indexes -->
      <div class="card-title" style="margin-bottom:10px">Major Market Indexes</div>
      <div class="price-grid mb-24">
        <div class="price-card" v-for="sym in indexSymbols" :key="sym">
          <div class="label">{{ INDEX_LABELS[sym] ?? sym }}</div>
          <template v-if="indexes[sym]?.loading && indexes[sym]?.price == null">
            <div class="skeleton" style="width:80%;height:28px;margin-top:4px"></div>
            <div class="skeleton" style="width:50%;height:14px;margin-top:6px"></div>
          </template>
          <template v-else-if="indexes[sym]?.error">
            <div class="text-muted text-sm">Unavailable</div>
          </template>
          <template v-else>
            <div class="price">{{ formatNumber(indexes[sym]?.price) }}</div>
            <div class="change" :class="changeClass(indexes[sym]?.change)">
              {{ formatNumber(indexes[sym]?.change, { signed: true }) }} ({{ formatPct(indexes[sym]?.pctChange) }})
            </div>
          </template>
        </div>
      </div>
      </template>

      <!-- Top movers (Markets → Stocks: under the indexes) -->
      <TopMovers v-if="!portfolioOnly" :sources="moverSources" v-model:selected-ids="moverSelected"
                 :quotes="stockQuotes" @select="openMover" />

      <!-- Watchlist picker + list actions -->
      <div class="watchlist-toolbar" v-if="!portfolioOnly">
        <div class="watchlist-picker">
          <span class="card-title" style="margin-bottom:0">Watchlist</span>
          <select v-if="user && customLists.length" :value="activeListId"
                  aria-label="Choose watchlist" @change="selectList($event.target.value)">
            <option value="default">Default</option>
            <option v-for="l in customLists" :key="l.id" :value="String(l.id)">{{ l.name }}</option>
          </select>
          <span v-else class="watchlist-name">Default</span>
        </div>
        <div class="watchlist-actions">
          <button type="button" v-if="editMode" class="primary" @click="editMode = false">Done</button>
          <button type="button" class="wl-icon-button" v-if="!isPortfolioList" :class="{ active: searchShown }"
                  :disabled="listFull && !searchShown"
                  :aria-label="listFull ? 'This watchlist is full (' + MAX_LIST_TICKERS + ' stocks)' : 'Search stocks to add'"
                  :title="listFull ? 'This watchlist is full (' + MAX_LIST_TICKERS + ' stocks)' : 'Search stocks to add'"
                  :aria-expanded="searchShown" aria-controls="watchlist-search"
                  @click="searchShown && tickers.length ? closeSearch() : openSearch()">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>
              <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <div class="wl-menu" ref="wlMenuRoot">
            <button ref="wlMenuButton" type="button" class="wl-icon-button"
                    aria-haspopup="menu" :aria-expanded="wlMenuOpen" aria-label="Watchlist options"
                    title="Watchlist options" @click="wlMenuOpen = !wlMenuOpen" @keydown="onWlMenuButtonKeydown">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <div class="user-menu-panel wl-menu-panel" v-if="wlMenuOpen" ref="wlMenu" role="menu"
                 aria-label="Watchlist options" @keydown="onWlMenuKeydown">
              <button type="button" role="menuitem" class="user-menu-item" v-if="tickers.length && !isPortfolioList" @click="menuAction('edit')">
                ✎ {{ editMode ? 'Stop editing' : 'Edit / remove stocks' }}
              </button>
              <div class="user-menu-sep" v-if="tickers.length && !isPortfolioList"></div>
              <template v-if="user">
                <button type="button" role="menuitem" class="user-menu-item" @click="menuAction('new')">＋ New list</button>
                <button type="button" role="menuitem" class="user-menu-item" v-if="activeList" @click="menuAction('rename')">Rename list</button>
                <button type="button" role="menuitem" class="user-menu-item danger-item" v-if="activeList" @click="menuAction('delete')">Delete list</button>
              </template>
              <button type="button" role="menuitem" class="user-menu-item" v-else @click="menuAction('signin')">
                Sign in to create more lists
              </button>
            </div>
          </div>
        </div>
      </div>

      <form class="watchlist-form" v-if="listForm" @submit.prevent="submitListForm">
        <input ref="listNameInput" v-model="listForm.name" maxlength="40" required
               :placeholder="listForm.mode === 'create' ? 'New watchlist name' : 'Watchlist name'"
               :aria-label="listForm.mode === 'create' ? 'New watchlist name' : 'Watchlist name'"
               @keydown.esc="listForm = null" />
        <button type="submit" class="primary" :disabled="listForm.busy || !listForm.name.trim()">
          {{ listForm.mode === 'create' ? 'Create' : 'Save' }}
        </button>
        <button type="button" @click="listForm = null">Cancel</button>
        <div class="notice error watchlist-form-error" v-if="listForm.error">{{ listForm.error }}</div>
      </form>

      <!-- Edit mode (signed in): act on several stocks at once -->
      <div class="wl-bulk-bar" v-if="editMode && user && !isPortfolioList && tickers.length">
        <label class="wl-bulk-all">
          <input type="checkbox" :checked="allSelected" :indeterminate.prop="selected.length > 0 && !allSelected"
                 @change="$event.target.checked ? selectAll() : clearSelected()" aria-label="Select all stocks" />
          <span>{{ selected.length ? selected.length + ' selected' : 'Select stocks' }}</span>
        </label>
        <div class="wl-bulk-actions">
          <button type="button" :disabled="!selected.length" @click="openTransfer(selected, 'copy', 'bulk')">Copy to ▾</button>
          <button type="button" :disabled="!selected.length" @click="openTransfer(selected, 'move', 'bulk')">Move to ▾</button>
          <button type="button" class="danger" :disabled="!selected.length" @click="removeSelected">Remove</button>
        </div>
        <template v-if="transfer && transfer.anchor === 'bulk'">${TRANSFER_PICKER}</template>
      </div>

      <!-- Search stocks to add to the list that's showing (opened with the
           search icon; always shown for an empty list) -->
      <div class="watchlist-search" id="watchlist-search" v-if="searchShown">
        <input ref="searchInput" type="search" v-model="searchQuery" autocomplete="off" spellcheck="false"
               :placeholder="listFull ? 'This watchlist is full (' + MAX_LIST_TICKERS + ' stocks)' : 'Search ticker or company to add…'"
               :disabled="listFull"
               aria-label="Search stocks to add" role="combobox" aria-autocomplete="list"
               :aria-expanded="searchOpen && !!searchQuery.trim()" aria-controls="watchlist-search-results"
               :aria-activedescendant="searchIndex >= 0 && searchOpen ? 'wl-result-' + searchIndex : null"
               @focus="searchOpen = true" @blur="onSearchBlur" @keydown="onSearchKeydown" />
        <ul class="watchlist-search-results" id="watchlist-search-results" role="listbox"
            v-if="searchOpen && searchQuery.trim()">
          <li class="watchlist-search-status" v-if="searchLoading && !searchResults.length">Searching…</li>
          <li class="watchlist-search-status" v-else-if="searchError">Search failed: {{ searchError }}</li>
          <li class="watchlist-search-status" v-else-if="!searchLoading && !searchResults.length">No matches.</li>
          <li v-for="(r, i) in searchResults" :key="r.symbol" :id="'wl-result-' + i" role="option"
              :aria-selected="i === searchIndex" :aria-disabled="inActiveList(r.symbol)"
              class="watchlist-search-result" :class="{ active: i === searchIndex, added: inActiveList(r.symbol) }"
              @mousedown.prevent @mouseenter="searchIndex = i" @click="addTicker(r.symbol)">
            <span class="watchlist-search-symbol">{{ r.symbol }}</span>
            <span class="watchlist-search-name">{{ r.name }}</span>
            <span class="watchlist-search-meta">{{ r.exchange }}<template v-if="r.exchange && r.type"> · </template>{{ r.type }}</span>
            <span class="watchlist-search-add">{{ inActiveList(r.symbol) ? '✓ In list' : '+ Add' }}</span>
          </li>
        </ul>
        <button type="button" class="watchlist-search-close" v-if="tickers.length"
                aria-label="Close search" title="Close search" @click="closeSearch">✕</button>
      </div>

      <div class="notice error" style="margin-bottom:10px" v-if="listsError">{{ listsError }}</div>

      <!-- Account → Summary: every portfolio combined — Performance · Holdings · By sector · By asset type -->
      <PortfolioOverview v-if="isPortfolioList && pfTab === 'summary' && user && (portfolioTotals || openOptionSymbols.length || (accountCash.balance ?? 0) > 0)"
                         :portfolio="viewPf" :intraday="intraday" :quotes="stockQuotes" :is-cash="sym => categoryFor(sym) === 'cash'"
                         :holdings="overviewHoldings" :sectors="allocationBySector" :types="allocationByType"
                         storage-key="oilgas_summary_overview" performance-title="All-time gain · all portfolios">
        <p class="text-muted text-sm hlist-note" v-if="shortSummary">
          <strong>Short options</strong> are liabilities, so they're not in the charts:
          {{ shortSummary.value != null ? formatUSD(shortSummary.value) + ' value' : 'value pending' }}<template v-if="shortSummary.reserved > 0"> · {{ formatUSD(shortSummary.reserved) }} cash reserved</template><template v-if="shortSummary.shares > 0"> · {{ formatShares(shortSummary.shares) }} shares covering calls</template>.
        </p>
      </PortfolioOverview>

      <!-- Account → Portfolios: a card per portfolio -->
      <section class="pf-cards" v-if="portfolioOnly && pfTab === 'portfolios' && !openPf" aria-label="Portfolios">
        <button v-for="p in portfolios" :key="p.id" type="button" class="card pf-card" @click="openPfId = p.id">
          <template v-for="m in [pfMetrics(p)]" :key="p.id + '-m'">
            <span class="pf-thumb" aria-hidden="true"><img v-if="p.image" :src="p.image" alt="" /><template v-else>{{ pfInitials(p.name) }}</template></span>
            <span class="pf-card-name">{{ p.name }} <span class="pf-card-id">{{ p.id }}</span> <span class="pf-vis-badge" :class="p.visibility === 'public' ? 'public' : ''" :title="p.visibility === 'public' ? 'Public — on the Leaderboard' : 'Private'">{{ p.visibility === 'public' ? '🌐' : '🔒' }}</span></span>
            <span class="pf-card-label">Position</span>
            <span class="pf-card-value">{{ m.value != null ? formatUSD(m.value) : (m.positions ? '…' : formatUSD(0)) }}</span>
            <span class="pf-card-stats">
              <span><span class="pf-card-label">1D</span> <strong :class="changeClass(m.dayPct)">{{ m.dayPct != null ? formatPct(m.dayPct) : '—' }}</strong></span>
              <span><span class="pf-card-label">All-time</span> <strong :class="changeClass(m.allTimePct)">{{ m.allTimePct != null ? formatPct(m.allTimePct) : '—' }}</strong></span>
            </span>
            <span class="text-muted text-sm">{{ m.positions }} position{{ m.positions === 1 ? '' : 's' }}</span>
          </template>
        </button>
        <div class="card pf-card pf-card-new">
          <form v-if="pfForm?.mode === 'create'" @submit.prevent="submitPfForm" novalidate>
            <input v-model="pfForm.name" maxlength="40" placeholder="Portfolio name, e.g. IRA" aria-label="New portfolio name" @input="onPfFormInput('name')" />
            <label class="pf-id-field">
              <span>ID</span>
              <input v-model="pfForm.id" maxlength="40" placeholder="from the name" aria-label="Portfolio ID" spellcheck="false" autocapitalize="off" @input="onPfFormInput('id')" />
            </label>
            <div class="pf-visibility" role="radiogroup" aria-label="Visibility">
              <label><input type="radio" value="private" v-model="pfForm.visibility" /> 🔒 Private</label>
              <label><input type="radio" value="public" v-model="pfForm.visibility" /> 🌐 Public</label>
            </div>
            <span class="pf-id-hint text-sm" :class="pfForm.idState === 'ok' ? 'positive' : (pfForm.idState === 'invalid' || pfForm.idState?.taken) ? 'negative' : 'text-muted'">
              <template v-if="pfForm.idState === 'checking'">Checking…</template>
              <template v-else-if="pfForm.idState === 'ok'">✓ Available — unique across all accounts</template>
              <template v-else-if="pfForm.idState === 'invalid'">Lowercase letters, digits and hyphens</template>
              <template v-else-if="pfForm.idState?.taken">Taken — pick another</template>
              <template v-else>Derived from the name; unique across all accounts</template>
            </span>
            <div class="pf-image-field pf-image-new">
              <span class="pf-thumb pf-thumb-lg" aria-hidden="true"><img v-if="pfForm.image" :src="pfForm.image" alt="" /><template v-else>{{ pfInitials(pfForm.name) }}</template></span>
              <div>
                <div class="pf-card-label">Picture <span class="text-muted" style="text-transform:none;letter-spacing:0;font-weight:500">(optional)</span></div>
                <ImagePicker :busy="pfForm.busy" :has-image="!!pfForm.image" remove-label="Remove"
                             @picked="pfForm.image = $event" @remove="pfForm.image = null" />
              </div>
            </div>
            <div class="pf-card-new-actions">
              <button type="submit" class="primary" :disabled="pfForm.busy">{{ pfForm.busy ? 'Creating…' : 'Create' }}</button>
              <button type="button" @click="pfForm = null">Cancel</button>
            </div>
            <div class="notice error" v-if="pfForm.error" style="margin:8px 0 0">{{ pfForm.error }}</div>
          </form>
          <button v-else type="button" class="pf-card-new-btn" @click="openPfForm('create')">＋ New portfolio</button>
        </div>
        <div class="notice error pf-cards-note" v-if="pfImageError && !openPf">{{ pfImageError }}</div>
        <p class="text-muted text-sm pf-cards-note" v-if="!portfolios.length">
          No portfolios yet. Create one here, or add a purchase from any stock's Portfolio tab on Markets → Stocks.
        </p>
      </section>
      <DiscoverPortfolios v-if="portfolioOnly && pfTab === 'portfolios' && !openPf && user" :initial-query="discoverQuery ?? ''"
                          @go-activity="$emit('go-activity', 'following')" />

      <!-- An opened portfolio: its header, the all-time gain chart, then what used to be Positions -->
      <template v-if="openPf">
        <div class="pf-detail-head">
          <button type="button" class="link-button" @click="openPfId = null">← All portfolios</button>
          <form class="pf-rename" v-if="pfForm?.mode === 'edit'" @submit.prevent="submitPfForm" novalidate>
            <input v-model="pfForm.name" maxlength="40" aria-label="Portfolio name" @input="pfForm.error = null" />
            <div class="pf-visibility" role="radiogroup" aria-label="Visibility">
              <label><input type="radio" value="private" v-model="pfForm.visibility" /> 🔒 Private</label>
              <label><input type="radio" value="public" v-model="pfForm.visibility" /> 🌐 Public</label>
            </div>
            <button type="submit" class="primary">Save</button>
            <button type="button" @click="pfForm = null">Cancel</button>
            <span class="negative text-sm" v-if="pfForm.error">{{ pfForm.error }}</span>
            <div class="pf-image-field">
              <span class="pf-thumb pf-thumb-lg" aria-hidden="true"><img v-if="openPf.image" :src="openPf.image" alt="" /><template v-else>{{ pfInitials(pfForm.name || openPf.name) }}</template></span>
              <div>
                <div class="pf-card-label">Picture</div>
                <ImagePicker :busy="pfImageBusy" :has-image="!!openPf.image" remove-label="Remove picture"
                             @picked="changePortfolioImage" @remove="clearPortfolioImage" />
                <div class="notice error" v-if="pfImageError" style="margin:6px 0 0">{{ pfImageError }}</div>
              </div>
            </div>
            <span class="text-muted text-sm pf-visibility-note">Public portfolios appear on the Leaderboard with their name, your display name and their return % — never amounts or holdings.</span>
          </form>
          <template v-else>
            <span class="pf-thumb pf-thumb-lg" aria-hidden="true"><img v-if="openPf.image" :src="openPf.image" alt="" /><template v-else>{{ pfInitials(openPf.name) }}</template></span>
            <h3 class="pf-detail-name">{{ openPf.name }} <span class="pf-vis-badge" :class="openPf.visibility === 'public' ? 'public' : ''">{{ openPf.visibility === 'public' ? '🌐 Public' : '🔒 Private' }}</span> <span class="pf-card-id" title="Portfolio ID — unique across accounts; stays the same if you rename it">{{ openPf.id }}</span></h3>
            <span class="pf-detail-actions">
              <button type="button" class="link-button" @click="openPfForm('edit')">Edit</button>
              <button type="button" class="link-button danger-link" @click="deletePortfolio">Delete</button>
            </span>
          </template>
        </div>
        <PortfolioOverview :portfolio="openPf" :intraday="intraday" :quotes="stockQuotes" :is-cash="sym => categoryFor(sym) === 'cash'"
                           :holdings="overviewHoldings" :sectors="allocationBySector" />
      </template>

      <!-- Top movers (an opened portfolio, above Holdings) -->
      <TopMovers v-if="portfolioOnly && openPf" :sources="moverSources" v-model:selected-ids="moverSelected"
                 :quotes="stockQuotes" @select="openMover" />

      <div class="notice" v-if="listsLoading && !tickers.length">Loading your watchlists…</div>
      <div class="notice" v-else-if="isPortfolioList && (pfTab === 'summary' ? portfolios.length : openPf) && !tickers.length && !openOptionSymbols.length">
        <template v-if="closedPositions.length">No open positions — sold ones are under Closed positions.</template>
        <template v-else>No positions yet. Open a stock on Markets → Stocks and use its Portfolio tab to add a purchase{{ openPf ? ' to ' + openPf.name : '' }}.</template>
      </div>
      <div class="notice" v-else-if="!isPortfolioList && tickers.length === 0">
        This watchlist is empty — search above to add stocks.
      </div>

      <!-- Watchlist as accordions — expand a ticker to see its SEC filings; -->
      <!-- drag a card by its handle to reorder (saved to settings). -->
      <!-- Portfolio page: holdings as one collapsible card — header row, then a
           row per stock (on Markets → Stocks this wrapper adds nothing) -->
      <div :class="{ 'holdings-card': portfolioOnly && tickers.length, collapsed: portfolioOnly && !holdingsOpen }" v-show="onPositions">
      <button type="button" class="holdings-toggle" v-if="portfolioOnly && tickers.length"
              :aria-expanded="holdingsOpen" aria-controls="portfolio-holdings" @click="holdingsOpen = !holdingsOpen">
        <span class="holdings-heading">
          <span class="holdings-chevron" aria-hidden="true">▶</span>
          <span class="holdings-title">Holdings</span>
          <span class="holdings-count">{{ tickers.length }}</span>
        </span>
        <!-- Totals across every position — shown even when collapsed -->
        <span class="holdings-stats" v-if="portfolioTotals">
          <span class="holdings-stat">
            <span class="holdings-stat-label">Market value</span>
            <span class="holdings-stat-value">{{ portfolioTotals.value != null ? formatUSD(portfolioTotals.value) : '—' }}</span>
          </span>
          <span class="holdings-stat">
            <span class="holdings-stat-label">Total cost</span>
            <span class="holdings-stat-value">{{ formatUSD(portfolioTotals.totalCost) }}</span>
          </span>
          <span class="holdings-stat">
            <span class="holdings-stat-label">Total G/L</span>
            <span class="holdings-stat-value" :class="changeClass(portfolioTotals.gain)">
              {{ portfolioTotals.gain != null ? signedUSD(portfolioTotals.gain) + ' (' + formatPct(portfolioTotals.gainPct) + ')' : '—' }}
            </span>
          </span>
          <span class="holdings-stat">
            <span class="holdings-stat-label">Today's G/L</span>
            <span class="holdings-stat-value" :class="changeClass(portfolioTotals.dayGain)">
              {{ portfolioTotals.dayGain != null ? signedUSD(portfolioTotals.dayGain) + (portfolioTotals.dayPct != null ? ' (' + formatPct(portfolioTotals.dayPct) + ')' : '') : '—' }}
            </span>
          </span>
        </span>
      </button>
      <div class="sort-bar" v-if="portfolioOnly && holdingsOpen && tickers.length > 1" role="group" aria-label="Sort holdings">
        <span class="sort-bar-label">Sort</span>
        <button v-for="o in HOLDING_SORTS" :key="o.id" type="button" class="sort-chip" :class="{ active: holdingSort.key === o.id }"
                :aria-pressed="holdingSort.key === o.id" @click="setSort('holdings', o.id)">
          {{ o.label }}<span class="sort-dir" v-if="holdingSort.key === o.id" :aria-label="holdingSort.dir === 'asc' ? 'ascending' : 'descending'">{{ holdingSort.dir === 'asc' ? '↑' : '↓' }}</span>
        </button>
      </div>
      <div ref="watchlistEl" id="portfolio-holdings" class="watchlist" :class="{ 'is-dragging': draggingTicker, editing: editMode }"
           v-show="!portfolioOnly || holdingsOpen">
      <div class="accordion-item watchlist-item" v-for="sym in tickers" :key="sym" :data-ticker="sym"
           :class="{ dragging: draggingTicker === sym, 'just-added': justAdded === sym, 'transfer-open': transfer?.anchor === 'card:' + sym }">
        <div class="accordion-header stock-row-header" :class="{ open: details[sym]?.open, selected: editMode && isSelected(sym) }" @click="toggleDetail(sym)"
             @pointerdown="onCardPointerDown($event, sym)" @contextmenu="onCardContextMenu">
          <input type="checkbox" class="wl-select" v-if="editMode && user && !isPortfolioList" :checked="isSelected(sym)"
                 :aria-label="'Select ' + sym" @click.stop @pointerdown.stop @change="toggleSelected(sym)" />
          <button
            v-if="tickers.length > 1 && !isPortfolioList"
            type="button"
            class="drag-handle"
            :aria-label="'Reorder ' + sym + ' — drag, or use the up/down arrow keys'"
            title="Drag to reorder (or focus and press ↑/↓)"
            @click.stop
            @pointerdown="onHandlePointerDown($event, sym)"
            @keydown="onHandleKeydown($event, sym)"
          >⠿</button>
          <div class="stock-row-main">
            <div class="stock-row-id" :class="{ 'has-weight': portfolioOnly && holdingWeight(sym) }">
              <span class="stock-row-ticker">{{ sym }}</span>
              <span class="earnings-badge" v-if="earningsSoon(sym)" :class="{ estimated: !earningsSoon(sym).confirmed }" :title="earningsTitle(sym)">
                {{ earningsSoon(sym).days === 0 ? 'Earnings today' : 'Earnings in ' + earningsSoon(sym).days + 'd' }}
              </span>
              <span class="text-muted text-sm">{{ stockQuotes[sym]?.shortName }}</span>
              <!-- Portfolio page: this holding's share of the Holdings' market value -->
              <template v-if="portfolioOnly && holdingWeight(sym)">
              <span class="holding-weight" v-for="w in [holdingWeight(sym)]" :key="'w-' + sym"
                    :title="sym + ' is ' + w.pct.toFixed(1) + '% of your holdings (' + formatUSD(w.value) + ' of ' + formatUSD(w.total) + ')'">
                <span class="holding-weight-bar" aria-hidden="true"><span :style="{ width: Math.max(2, w.pct) + '%' }"></span></span>
                <span class="holding-weight-pct">{{ w.pct < 0.1 ? '<0.1' : w.pct.toFixed(1) }}%</span>
                <span class="holding-weight-value">{{ formatUSD(w.value) }}</span>
              </span>
              </template>
            </div>
            <!-- 52-week range: today's price (●); on the Portfolio page also your average cost (│) -->
            <template v-for="r in [rangeFor(sym, portfolioOnly && !!positionFor(sym))]" :key="'r52-' + sym">
            <div class="range52" v-if="r" :title="r.tip" role="img" :aria-label="r.tip">
              <!-- top: avg (Portfolio) or "52W" (left), and the 52-week high right-aligned over the high end -->
              <span class="range52-row">
                <span class="range52-caption" v-if="r.avg != null">avg {{ rangeLabel(r.avg) }}</span>
                <span class="range52-caption range52-tag" v-else>52W</span>
                <span class="range52-hi" :style="{ right: 'max(0px, ' + (100 - r.hiAt) + '%)' }">{{ rangeLabel(r.hi) }}</span>
              </span>
              <span class="range52-track">
                <!-- dashed: the part of the scale outside the 52-week range -->
                <span class="range52-outside" v-if="r.loAt > 0" :style="{ left: 0, width: r.loAt + '%' }"></span>
                <span class="range52-outside" v-if="r.hiAt < 100" :style="{ left: r.hiAt + '%', right: 0 }"></span>
                <span class="range52-line" :style="{ left: r.loAt + '%', width: (r.hiAt - r.loAt) + '%' }"></span>
                <template v-if="r.avg != null">
                  <span class="range52-band" :class="r.gain ? 'gain' : 'loss'"
                        :style="{ left: Math.min(r.avgAt, r.priceAt) + '%', width: Math.abs(r.priceAt - r.avgAt) + '%' }"></span>
                  <span class="range52-avg" :style="{ left: r.avgAt + '%' }"></span>
                </template>
                <span class="range52-price" :class="r.gain == null ? 'neutral' : (r.gain ? 'gain' : 'loss')" :style="{ left: r.priceAt + '%' }"></span>
              </span>
              <!-- bottom: the 52-week low, left-aligned under the low end -->
              <span class="range52-row">
                <span class="range52-lo" :style="{ left: 'min(' + r.loAt + '%, calc(100% - 64px))' }">{{ rangeLabel(r.lo) }}</span>
              </span>
            </div>
            </template>
            <div class="stock-row-metrics">
              <template v-if="stockQuotes[sym]?.loading && stockQuotes[sym]?.price == null">
                <span class="skeleton" style="width:100%;height:14px;grid-column:1 / -2"></span>
              </template>
              <template v-else-if="stockQuotes[sym]?.error">
                <span class="text-muted text-sm" style="grid-column:1 / -2">Unavailable</span>
              </template>
              <template v-else>
                <span class="stock-row-num">
                  <span class="stock-row-label">Last</span>
                  <span>{{ formatPrice(stockQuotes[sym]?.price) }}</span>
                </span>
                <span class="stock-row-num">
                  <span class="stock-row-label">Chg</span>
                  <span :class="changeClass(stockQuotes[sym]?.change)">{{ formatPrice(stockQuotes[sym]?.change, { signed: true }) }}</span>
                </span>
                <span class="stock-row-num">
                  <span class="stock-row-label">Chg %</span>
                  <span :class="changeClass(stockQuotes[sym]?.pctChange)">{{ formatPct(stockQuotes[sym]?.pctChange) }}</span>
                </span>
                <span class="stock-row-num stock-row-vol">
                  <span class="stock-row-label">Vol</span>
                  <span class="text-muted">{{ formatVolume(stockQuotes[sym]?.volume) }}</span>
                </span>
              </template>
              <span class="stock-row-sparkline" v-if="sparklines[sym]" v-html="sparklines[sym]"
                    :title="stockQuotes[sym]?.previousClose != null ? 'Today · dashed line: previous close ' + formatPrice(stockQuotes[sym].previousClose) : null"></span>
              <span class="stock-row-sparkline" v-else></span>
            </div>
          </div>
          <button v-if="editMode && user && !isPortfolioList" type="button" class="watchlist-transfer"
                  :aria-label="'Copy or move ' + sym + ' to another watchlist'" :title="'Copy or move ' + sym"
                  :aria-expanded="transfer?.anchor === 'card:' + sym" @pointerdown.stop
                  @click.stop="transfer?.anchor === 'card:' + sym ? closeTransfer() : openTransfer([sym], null, 'card:' + sym)">⇄</button>
          <button v-if="editMode" type="button" class="watchlist-remove"
                  :aria-label="'Remove ' + sym + ' from this watchlist'" :title="'Remove ' + sym"
                  @click.stop="removeTicker(sym)">✕</button>
          <span v-else class="chevron">▶</span>
          <template v-if="transfer && transfer.anchor === 'card:' + sym">${TRANSFER_PICKER}</template>
        </div>

        <!-- Portfolio page: a cash holding's reserve for cash-secured puts -->
        <p class="cash-reserve-line" v-if="portfolioOnly && user && cashReserved(sym) > 0 && !details[sym]?.open">
          Reserved {{ formatUSD(cashReserved(sym)) }} for {{ cashSecuring(sym).length }} put{{ cashSecuring(sym).length === 1 ? '' : 's' }}
          <template v-if="positionSummary(sym)?.value != null"> · {{ formatUSD(positionSummary(sym).value - cashReserved(sym)) }} available</template>
        </p>


        <!-- Charts + Documents (SEC filings) — same content that -->
        <!-- used to live on the standalone Documents tab, now nested here. -->
        <div class="accordion-body" v-if="details[sym]?.open">
          <div class="filing-tabs">
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'summary' }" @click.stop="setDetailTab(sym, 'summary')">Summary</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'chart' }" @click.stop="setDetailTab(sym, 'chart')">Charts</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'news' }" @click.stop="setDetailTab(sym, 'news')">News</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'documents' }" @click.stop="setDetailTab(sym, 'documents')"><span class="label-full">Documents</span><span class="label-short" aria-hidden="true">Docs</span></button>
            <!-- Portfolio on every list; entering a position needs an account (signed out: a sign-in message) -->
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'portfolio' }" @click.stop="setDetailTab(sym, 'portfolio')">Portfolio</button>
            <button class="filing-tab alerts-tab" :class="{ active: details[sym]?.tab === 'alerts' }" @click.stop="setDetailTab(sym, 'alerts')"
                    :aria-label="'Alerts' + (activeAlertCount(sym) ? ', ' + activeAlertCount(sym) + ' active' : '')" title="Alerts">
              <svg class="icon-bell" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
              </svg>
              <span class="alerts-tab-text">Alerts</span>
              <span class="alerts-tab-count" v-if="activeAlertCount(sym)" aria-hidden="true">{{ activeAlertCount(sym) }}</span>
            </button>
          </div>

          <!-- Summary: company profile (Wikipedia + SEC + Yahoo) and performance vs. the S&P 500 -->
          <div class="summary-panel" v-if="details[sym]?.tab === 'summary'">
            <template v-for="d in [details[sym].summary]" :key="sym + '-summary'">
              <template v-if="d.loading || !d.loaded">
                <div class="skeleton" style="height:70px;margin-bottom:12px"></div>
                <div class="skeleton" style="height:180px"></div>
              </template>
              <template v-else>
                <section class="company-profile" aria-label="Company summary">
                  <template v-if="d.profile">
                    <h4 class="company-name">{{ d.profile.summary?.title || d.profile.facts.name || stockQuotes[sym]?.shortName || sym }}</h4>
                    <p class="company-summary" v-if="d.profile.summary">{{ d.profile.summary.text }}</p>
                    <p class="text-muted text-sm company-summary" v-else>No description available for {{ sym }} — funds and some foreign listings aren't linked to a Wikipedia article.</p>
                    <dl class="company-facts">
                      <div v-if="d.profile.facts.sector"><dt>Sector</dt><dd>{{ d.profile.facts.sector }}</dd></div>
                      <div v-if="d.profile.facts.industry"><dt>Industry</dt><dd>{{ d.profile.facts.industry }}</dd></div>
                      <div v-if="d.profile.facts.headquarters"><dt>Headquarters</dt><dd>{{ d.profile.facts.headquarters }}</dd></div>
                      <div v-if="d.profile.facts.fiscalYearEnd"><dt>Fiscal year end</dt><dd>{{ d.profile.facts.fiscalYearEnd }}</dd></div>
                      <div v-if="d.profile.facts.secIndustry"><dt>SEC industry</dt><dd>{{ d.profile.facts.secIndustry }}</dd></div>
                      <div v-if="d.profile.facts.name"><dt>Registered name</dt><dd>{{ d.profile.facts.name }}</dd></div>
                    </dl>
                    <p class="text-muted text-sm company-sources">
                      <template v-if="d.profile.summary">Description: <a :href="d.profile.summary.url" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA). </template>
                      <template v-if="d.profile.facts.cik">Company facts: SEC EDGAR</template><template v-if="d.profile.facts.cik && d.profile.facts.sector"> · </template><template v-if="d.profile.facts.sector">sector: Yahoo Finance</template>.
                    </p>
                  </template>
                  <div class="notice" v-else>Couldn't load the company profile: {{ d.profileError }}</div>
                </section>

                <section class="events-section" aria-label="Upcoming events">
                  <h4 class="perf-title">Upcoming events</h4>
                  <ul class="events-list" v-if="upcomingEvents(sym).length">
                    <li v-for="ev in upcomingEvents(sym)" :key="ev.key" class="event-row" :class="ev.kind">
                      <span class="event-date">{{ ev.approx ? '~' : '' }}{{ formatDate(ev.date + 'T12:00:00') }}</span>
                      <span class="event-what">
                        <span class="event-title">{{ ev.title }}</span>
                        <span class="event-detail text-muted" v-if="ev.detail">{{ ev.detail }}</span>
                      </span>
                      <span class="event-tag" :class="{ estimated: ev.estimated }">{{ ev.tag }}</span>
                      <span class="event-days" :class="{ soon: ev.days <= 7 }">{{ ev.days === 0 ? 'today' : ev.days === 1 ? 'tomorrow' : ev.days + ' days' }}</span>
                    </li>
                  </ul>
                  <p class="text-muted text-sm" style="margin:0" v-else>
                    {{ sym in earnings ? 'No upcoming events found.' : 'Looking up events…' }}
                  </p>
                  <p class="text-muted text-sm events-note">
                    Earnings dates: Nasdaq / Zacks Investment Research (confirmed when the company has announced it). Dividend dates are estimated from past payments.
                  </p>
                </section>

                <section class="perf-section" aria-label="Performance">
                  <h4 class="perf-title">Performance</h4>
                  <div class="notice error" v-if="d.perfError">Couldn't load price history: {{ d.perfError }}</div>
                  <table class="data-table perf-table" v-else>
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th class="num" title="Change in the closing price">Price</th>
                        <th class="num" title="Price change plus reinvested dividends (Yahoo's adjusted close)"><span class="perf-long">Total return</span><span class="perf-short" aria-hidden="true">Total</span></th>
                        <th class="num" title="S&P 500 price change over the same period">S&P 500</th>
                        <th class="num" title="Price change minus the S&P 500's, in percentage points">vs S&P</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="p in PERIODS" :key="p.id" :title="d.perf?.[p.id] ? 'From the ' + formatDate(d.perf[p.id].from + 'T12:00:00') + ' close' : 'Not enough price history'">
                        <td><span class="perf-long">{{ p.label }}</span><span class="perf-short" aria-hidden="true">{{ p.id }}</span></td>
                        <td class="num" :class="changeClass(d.perf?.[p.id]?.price)">{{ d.perf?.[p.id] ? formatPct(d.perf[p.id].price) : '—' }}</td>
                        <td class="num" :class="changeClass(d.perf?.[p.id]?.total)">{{ d.perf?.[p.id] ? formatPct(d.perf[p.id].total) : '—' }}</td>
                        <td class="num" :class="changeClass(d.spx?.[p.id]?.price)">{{ d.spx?.[p.id] ? formatPct(d.spx[p.id].price) : '—' }}</td>
                        <td class="num" :class="changeClass(perfDiff(d.perf?.[p.id]?.price, d.spx?.[p.id]?.price))">
                          <template v-for="x in [perfDiff(d.perf?.[p.id]?.price, d.spx?.[p.id]?.price)]">{{ x != null ? (x > 0 ? '+' : '') + x.toFixed(2) + ' pp' : '—' }}</template>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p class="text-muted text-sm perf-note" v-if="!d.perfError">
                    To the latest close<template v-if="d.perf?.['5D']"> ({{ formatDate(lastCloseDate(d)) }})</template>. Total return reinvests dividends; the S&P 500 is its price index, so compare it with Price. pp = percentage points.
                  </p>
                </section>
              </template>
            </template>
          </div>

          <!-- Charts (price history) -->
          <template v-else-if="details[sym]?.tab === 'chart'">
            <div class="chart-filters" style="padding:12px 16px 0">
              <div class="range-btn-group">
                <button
                  v-for="r in STOCK_RANGE_OPTIONS" :key="r.id"
                  class="range-btn" :class="{ active: details[sym]?.chart.range === r.id }"
                  @click.stop="details[sym].chart.range = r.id"
                >{{ r.label }}</button>
              </div>
            </div>

            <!-- 1D reads the intraday series the sparkline already fetched -->
            <template v-if="details[sym]?.chart.range === '1D'">
              <div style="padding:12px 16px" v-if="!intraday[sym]">
                <div class="skeleton" style="width:100%;height:220px"></div>
              </div>
              <div class="notice error" style="margin:12px" v-else-if="intraday[sym].error">
                {{ intraday[sym].error }}
              </div>
              <div style="padding:12px 16px" v-else-if="intraday[sym].series.length">
                <HistoryChart :data="intraday[sym].series" intraday :baseline="intraday[sym].previousClose" :format-value="formatPrice" />
              </div>
              <div class="text-muted text-sm" style="padding:16px" v-else>
                No intraday prices yet today.
              </div>
            </template>
            <div style="padding:12px 16px" v-else-if="details[sym]?.chart.loading">
              <div class="skeleton" style="width:100%;height:220px"></div>
            </div>
            <div class="notice error" style="margin:12px" v-else-if="details[sym]?.chart.error">
              {{ details[sym].chart.error }}
            </div>
            <div style="padding:12px 16px" v-else-if="filteredChartData(sym).length">
              <HistoryChart :data="filteredChartData(sym)" :format-value="formatPrice" />
            </div>
            <div class="text-muted text-sm" style="padding:16px" v-else>
              No price history available for this range.
            </div>

            <!-- Key statistics -->
            <div class="key-stats">
              <div class="key-stat" v-for="stat in keyStats(sym)" :key="stat.label">
                <span class="key-stat-label">{{ stat.label }}</span>
                <span class="skeleton key-stat-skeleton" v-if="stat.fromStats && details[sym]?.stats.loading"></span>
                <span class="key-stat-value" v-else>{{ stat.value }}</span>
              </div>
            </div>
          </template>

          <!-- News (Yahoo Finance, tagged to this ticker) -->
          <template v-else-if="details[sym]?.tab === 'news'">
            <div style="padding:12px 16px" v-if="details[sym]?.news.loading">
              <div class="stock-news-item" v-for="i in 4" :key="i">
                <div class="skeleton stock-news-thumb"></div>
                <div style="flex:1">
                  <div class="skeleton" style="width:85%;height:14px;margin-bottom:6px"></div>
                  <div class="skeleton" style="width:35%;height:11px"></div>
                </div>
              </div>
            </div>
            <div class="notice error" style="margin:12px" v-else-if="details[sym]?.news.error">
              {{ details[sym].news.error }}
            </div>
            <div class="text-muted text-sm" style="padding:16px" v-else-if="!details[sym]?.news.items.length">
              No recent news for {{ sym }}.
            </div>
            <div class="stock-news" v-else>
              <div class="stock-news-item" v-for="article in details[sym].news.items" :key="article.link">
                <img v-if="article.image" class="stock-news-thumb" :src="article.image" alt="" loading="lazy" @error="onNewsImageError" />
                <div class="stock-news-text">
                  <a class="stock-news-title" :href="safeArticleUrl(article.link)" target="_blank" rel="noopener"
                     @click.stop="onArticleClick($event, article, config)">{{ article.title }}</a>
                  <div class="stock-news-meta">
                    <span class="text-muted text-sm">{{ article.source }} · {{ formatRelativeTime(article.pubDate) }}</span>
                    <template v-if="user">
                      <button type="button" class="link-button note-saved" v-if="findNote(sym, article.link)"
                              title="Open the Notes tab" @click.stop="$emit('go-notes')">✓ In Notes</button>
                      <button type="button" class="link-button" v-else-if="!noteForms[noteKey(sym, article)]"
                              :disabled="!notesStore.loaded" @click.stop="openNoteForm(sym, article)"><svg class="icon-bookmark" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Save to notes</button>
                    </template>
                  </div>
                  <NoteForm v-if="user && noteForms[noteKey(sym, article)]" :labels="notesStore.labels"
                            submit-label="Save to notes" :busy="noteForms[noteKey(sym, article)].busy"
                            :error="noteForms[noteKey(sym, article)].error"
                            @save="saveNewNote(sym, article, $event)" @cancel="closeNoteForm(sym, article)" />
                </div>
              </div>
            </div>
          </template>

          <!-- Portfolio: your position (quantity × average cost) and G/L -->
          <div class="portfolio" v-else-if="details[sym]?.tab === 'portfolio'">
            <!-- Markets: which portfolio this tab works in — pick one, or name a new one (created on the first save) -->
            <div class="notice error" v-if="pfError && user && !portfolioOnly" style="margin:0 0 10px">{{ pfError }}</div>
            <div class="pf-choice" v-if="user && !portfolioOnly">
              <label class="pf-choice-field">
                <span>Portfolio</span>
                <select :value="pfFor(sym).id ?? '__new'" @change="choosePortfolio(sym, $event.target.value)" aria-label="Portfolio">
                  <option v-for="p in portfolios" :key="p.id" :value="p.id">{{ p.name }}{{ holdsIn(p, sym) ? ' ✓' : '' }}</option>
                  <option value="__new">＋ New portfolio…</option>
                </select>
              </label>
              <label class="pf-choice-field" v-if="pfFor(sym).pending">
                <span>New portfolio name</span>
                <input :value="pfChoice[sym]?.newName ?? ''" maxlength="40" :placeholder="portfolios.length ? 'e.g. IRA' : DEFAULT_PORTFOLIO_NAME"
                       @input="pfChoice[sym] = { id: null, newName: $event.target.value }" />
              </label>
              <span class="text-muted text-sm pf-choice-hint" v-if="pfFor(sym).pending">Created when you save {{ portfolios.length ? '' : '(your first portfolio)' }}</span>
              <span class="text-muted text-sm pf-choice-hint" v-else-if="portfolios.filter(p => holdsIn(p, sym)).length > 1">✓ held in {{ portfolios.filter(p => holdsIn(p, sym)).length }} portfolios</span>
            </div>
            <div class="notice" v-if="!user">
              Track your {{ sym }} position — enter quantity and average cost to see its market value, total and
              today's gain/loss, and add it to your Portfolio page with allocation charts.
              <a href="#" @click.prevent="$emit('go-account')">Sign in</a> to track positions.
            </div>
            <!-- Move to another portfolio (an opened portfolio): all or part, optionally with the stock's options -->
            <form class="portfolio-form move-form" v-else-if="portfolioOnly && openPf && moveForms[sym] && positionFor(sym)"
                  @submit.prevent="saveMove(sym)" novalidate @input="moveForms[sym].error = null" @change="moveForms[sym].error = null">
              <p class="text-muted text-sm" style="margin:0 0 10px">
                Move {{ sym }} out of {{ openPf.name }} — you hold {{ formatShares(positionFor(sym).quantity) }} shares at an average of {{ formatPrice(positionFor(sym).avgCost) }}<template v-if="sharesCovering(sym) > 0"> ({{ formatShares(sharesCovering(sym)) }} cover calls)</template>.
                Nothing is sold: no realized gain or loss, and no cash moves.
              </p>
              <div class="portfolio-fields">
                <label>
                  <span>To</span>
                  <select v-model="moveForms[sym].to">
                    <option v-for="p in portfolios.filter(x => x.id !== openPf.id)" :key="p.id" :value="p.id">{{ p.name }}{{ holdsIn(p, sym) ? ' ✓' : '' }}</option>
                    <option value="__new">＋ New portfolio…</option>
                  </select>
                </label>
                <label v-if="moveForms[sym].to === '__new'">
                  <span>New portfolio name</span>
                  <input v-model="moveForms[sym].newName" maxlength="40" placeholder="e.g. IRA" />
                </label>
                <label>
                  <span>Shares</span>
                  <span class="sale-qty">
                    <input type="number" inputmode="decimal" min="0" step="any" :max="positionFor(sym).quantity" v-model="moveForms[sym].shares" />
                    <button type="button" class="link-button" @click="moveForms[sym].shares = String(positionFor(sym).quantity)">All</button>
                  </span>
                </label>
              </div>
              <label class="option-cover-check move-options" v-if="optionsFor(sym).length">
                <input type="checkbox" v-model="moveForms[sym].withOptions" />
                <span>Move the options on {{ sym }} too ({{ optionsFor(sym).length }} position{{ optionsFor(sym).length === 1 ? '' : 's' }})</span>
              </label>
              <p class="purchase-preview" v-if="movePreview(sym) && !movePreview(sym).error">
                <template v-for="mp in [movePreview(sym)]">
                  {{ moveForms[sym].to === '__new' ? (moveForms[sym].newName.trim() || 'New portfolio') : mp.dest.name }}:
                  <template v-if="mp.had">{{ formatShares(mp.had.quantity) }} at {{ formatPrice(mp.had.avgCost) }} → </template>{{ formatShares(mp.merged.quantity) }} {{ sym }} at {{ formatPrice(mp.merged.avgCost) }}
                  · {{ openPf.name }}: <template v-if="mp.whole">none left</template><template v-else>{{ formatShares(mp.left) }} left at {{ formatPrice(positionFor(sym).avgCost) }}</template>
                  <template v-if="mp.whole && (positionFor(sym).transactions ?? []).length"> · its {{ positionFor(sym).transactions.length }} trade{{ positionFor(sym).transactions.length === 1 ? '' : 's' }} move too</template>
                  <template v-if="mp.opts.length"><br />With {{ mp.opts.map(x => x.o.quantity + ' × ' + optionLabel(x.occ.split('#')[0], { withUnderlying: false })).join(', ') }}</template>
                  <template v-if="mp.blockedOpts.length"><br /><span class="text-muted">Staying: {{ mp.blockedOpts.map(x => optionLabel(x.occ.split('#')[0], { withUnderlying: false }) + ' (' + x.reason + ')').join(', ') }}</span></template>
                </template>
              </p>
              <div class="notice error portfolio-error" v-if="moveForms[sym].error || movePreview(sym)?.error">{{ moveForms[sym].error || movePreview(sym).error }}</div>
              <div class="portfolio-actions">
                <button type="submit" class="primary">Move</button>
                <button type="button" @click="cancelMove(sym)">Cancel</button>
              </div>
            </form>

            <!-- Sell (Portfolio page only): shares at a price on a date; proceeds optionally to a cash holding -->
            <form class="portfolio-form sale-form" v-else-if="portfolioOnly && saleForms[sym] && positionFor(sym)"
                  @submit.prevent="saveSale(sym)" novalidate
                  @input="saleForms[sym].error = null" @change="saleForms[sym].error = null">
              <p class="text-muted text-sm" style="margin:0 0 10px">
                Sell {{ sym }} — you hold {{ formatShares(positionFor(sym).quantity) }} shares at an average of {{ formatPrice(positionFor(sym).avgCost) }}.
              </p>
              <div class="portfolio-fields">
                <label>
                  <span>Shares sold</span>
                  <span class="sale-qty">
                    <input type="number" inputmode="decimal" min="0" step="any" :max="positionFor(sym).quantity"
                           v-model="saleForms[sym].quantity" />
                    <button type="button" class="link-button" @click="saleForms[sym].quantity = String(positionFor(sym).quantity)">All</button>
                  </span>
                </label>
                <label>
                  <span>Price per share</span>
                  <input type="number" inputmode="decimal" min="0" step="any" v-model="saleForms[sym].price" />
                </label>
                <label>
                  <span>Date</span>
                  <input type="date" :max="new Date().toLocaleDateString('en-CA')" v-model="saleForms[sym].date" />
                </label>
                <label>
                  <span>Deposit to</span>
                  <select :value="depositToFor(sym)" @change="saleForms[sym].depositTo = $event.target.value">
                    <option v-for="c in cashSources(sym)" :key="c.symbol" :value="c.symbol">{{ c.label }} — {{ formatUSD(c.available) }}</option>
                    <option value="">Outside the portfolio</option>
                  </select>
                </label>
              </div>
              <p class="purchase-preview" v-if="salePreview(sym)">
                Proceeds {{ formatUSD(salePreview(sym).proceeds) }} ·
                Realized G/L <span :class="changeClass(salePreview(sym).realized)">{{ signedUSD(salePreview(sym).realized) }}<template v-if="salePreview(sym).realizedPct != null"> ({{ formatPct(salePreview(sym).realizedPct) }})</template></span>
                vs. your average cost ·
                <span class="negative" v-if="salePreview(sym).tooMany">more than you hold</span>
                <strong v-else-if="salePreview(sym).closes">closes the position (moves to Closed positions)</strong>
                <template v-else>{{ formatShares(salePreview(sym).remaining) }} shares left</template>
                <br />
                <template v-if="salePreview(sym).to">
                  Deposited to {{ cashName(salePreview(sym).to.symbol) }}: {{ formatUSD(salePreview(sym).to.before) }} → {{ formatUSD(salePreview(sym).to.after) }}
                </template>
                <span class="text-muted" v-else>Not deposited to a cash holding.</span>
              </p>
              <div class="notice error portfolio-error" v-if="saleForms[sym].error">{{ saleForms[sym].error }}</div>
              <div class="portfolio-actions">
                <button type="submit" class="primary">Record sale</button>
                <button type="button" @click="cancelSale(sym)">Cancel</button>
              </div>
            </form>

            <!-- Add a purchase: shares at a price (prefilled: last price) on a date (prefilled: today) -->
            <form class="portfolio-form purchase-form" v-else-if="purchaseForms[sym]" @submit.prevent="savePurchase(sym)" novalidate
                  @input="purchaseForms[sym].error = null" @change="purchaseForms[sym].error = null">
              <p class="text-muted text-sm" style="margin:0 0 10px">
                {{ positionFor(sym) ? 'Add a ' + sym + ' purchase — your position and average cost update.' : 'Add your first ' + sym + ' purchase to start tracking it.' }}
              </p>
              <div class="portfolio-fields">
                <label>
                  <span>Shares bought</span>
                  <input type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 10"
                         v-model="purchaseForms[sym].quantity" />
                </label>
                <label>
                  <span>Price per share</span>
                  <input type="number" inputmode="decimal" min="0" step="any" v-model="purchaseForms[sym].price" />
                </label>
                <label>
                  <span>Date</span>
                  <input type="date" :max="new Date().toLocaleDateString('en-CA')" v-model="purchaseForms[sym].date" />
                </label>
                <label>
                  <span>Pay from</span>
                  <select :value="payFromFor(sym)" @change="purchaseForms[sym].payFrom = $event.target.value">
                    <option v-for="c in cashSources(sym)" :key="c.symbol" :value="c.symbol">
                      {{ c.label }} — {{ formatUSD(c.available) }} available
                    </option>
                    <option value="">Outside the portfolio</option>
                  </select>
                </label>
              </div>
              <p class="text-muted text-sm purchase-cash-hint" v-if="!cashSources(sym).length">
                No cash holdings to pay from — hold a money-market fund (e.g. SPAXX) or set a holding's category to Cash.
              </p>
              <p class="purchase-preview" v-if="purchasePreview(sym)">
                Cost {{ formatUSD(purchasePreview(sym).cost) }} ·
                {{ purchasePreview(sym).was ? 'New position' : 'Position' }}: {{ formatShares(purchasePreview(sym).quantity) }} shares
                at an average of {{ formatPrice(purchasePreview(sym).avgCost) }}
                <span class="text-muted" v-if="purchasePreview(sym).was">
                  (was {{ formatShares(purchasePreview(sym).was.quantity) }} at {{ formatPrice(purchasePreview(sym).was.avgCost) }})
                </span>
                <br />
                <template v-if="purchasePreview(sym).from">
                  Paid from {{ cashName(purchasePreview(sym).from.symbol) }}:
                  {{ formatUSD(purchasePreview(sym).from.available) }} →
                  <span :class="{ negative: purchasePreview(sym).from.after < 0 }">{{ formatUSD(purchasePreview(sym).from.after) }}</span>
                  <span class="negative" v-if="purchasePreview(sym).from.after < 0"> (not enough)</span>
                </template>
                <span class="text-muted" v-else>Not deducted from a cash holding.</span>
              </p>
              <div class="notice error portfolio-error" v-if="purchaseForms[sym].error">{{ purchaseForms[sym].error }}</div>
              <div class="portfolio-actions">
                <button type="submit" class="primary">Add purchase</button>
                <button type="button" v-if="positionFor(sym) || optionsFor(sym).length" @click="cancelPurchase(sym)">Cancel</button>
                <button type="button" class="link-button" v-else @click="cancelPurchase(sym); startPositionEdit(sym)">
                  Enter a total position instead
                </button>
              </div>
            </form>

            <form class="portfolio-form" v-else-if="positionForms[sym]" @submit.prevent="savePosition(sym)" novalidate>
              <p class="text-muted text-sm" v-if="!positionFor(sym)" style="margin:0 0 10px">
                Enter your {{ sym }} holding to track its value and gain/loss.
              </p>
              <div class="portfolio-fields">
                <label>
                  <span>Quantity (shares)</span>
                  <input type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 100"
                         v-model="positionForms[sym].quantity" />
                </label>
                <label>
                  <span>Average cost / share</span>
                  <input type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 152.40"
                         v-model="positionForms[sym].avgCost" />
                </label>
                <label>
                  <span>Category</span>
                  <select v-model="positionForms[sym].category">
                    <option value="">Automatic{{ autoCategoryFor(sym) ? ' (' + CATEGORY_LABELS[autoCategoryFor(sym)] + ')' : '' }}</option>
                    <option v-for="c in CATEGORIES.filter(c => !c.derived)" :key="c.id" :value="c.id">{{ c.label }}</option>
                  </select>
                </label>
              </div>
              <div class="notice error portfolio-error" v-if="positionForms[sym].error">{{ positionForms[sym].error }}</div>
              <div class="portfolio-actions">
                <button type="submit" class="primary">Save position</button>
                <button type="button" v-if="positionFor(sym)" @click="cancelPositionEdit(sym)">Cancel</button>
                <button type="button" class="link-button" v-else @click="cancelPositionEdit(sym); startPurchase(sym)">
                  Add a purchase instead
                </button>
              </div>
            </form>

            <template v-else-if="user && positionSummary(sym)">
              <div class="portfolio-grid">
                <div class="portfolio-stat">
                  <span class="portfolio-label">Category</span>
                  <span class="portfolio-value">
                    {{ positionSummary(sym).categoryLabel ?? '—' }}<span class="text-muted portfolio-auto" v-if="positionSummary(sym).categoryIsAuto && positionSummary(sym).categoryLabel"> (auto)</span>
                  </span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Quantity</span>
                  <span class="portfolio-value">{{ formatShares(positionSummary(sym).quantity) }}</span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Avg cost</span>
                  <span class="portfolio-value">{{ formatPrice(positionSummary(sym).avgCost) }}</span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Total cost</span>
                  <span class="portfolio-value">{{ formatUSD(positionSummary(sym).totalCost) }}</span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Market value</span>
                  <span class="portfolio-value">{{ positionSummary(sym).value != null ? formatUSD(positionSummary(sym).value) : '—' }}</span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Total G/L</span>
                  <span class="portfolio-value" :class="changeClass(positionSummary(sym).gain)">
                    {{ positionSummary(sym).gain != null ? signedUSD(positionSummary(sym).gain) : '—' }}
                  </span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Total G/L %</span>
                  <span class="portfolio-value" :class="changeClass(positionSummary(sym).gainPct)">
                    {{ positionSummary(sym).gainPct != null ? formatPct(positionSummary(sym).gainPct) : '—' }}
                  </span>
                </div>
                <div class="portfolio-stat">
                  <span class="portfolio-label">Today's G/L</span>
                  <span class="portfolio-value" :class="changeClass(positionSummary(sym).dayGain)">
                    {{ positionSummary(sym).dayGain != null ? signedUSD(positionSummary(sym).dayGain) + ' (' + formatPct(positionSummary(sym).dayPct) + ')' : '—' }}
                  </span>
                </div>
                <template v-if="cashReserved(sym) > 0">
                  <div class="portfolio-stat">
                    <span class="portfolio-label">Reserved for puts</span>
                    <span class="portfolio-value">{{ formatUSD(cashReserved(sym)) }}</span>
                  </div>
                  <div class="portfolio-stat">
                    <span class="portfolio-label">Available</span>
                    <span class="portfolio-value" :class="{ negative: positionSummary(sym).value != null && positionSummary(sym).value - cashReserved(sym) < 0 }">
                      {{ positionSummary(sym).value != null ? formatUSD(positionSummary(sym).value - cashReserved(sym)) : '—' }}
                    </span>
                  </div>
                </template>
                <div class="portfolio-stat" v-if="sharesCovering(sym) > 0">
                  <span class="portfolio-label">Covering calls</span>
                  <span class="portfolio-value">{{ formatShares(sharesCovering(sym)) }} shares</span>
                </div>
                <div class="portfolio-stat" v-if="realizedFor(sym) != null">
                  <span class="portfolio-label">Realized G/L</span>
                  <span class="portfolio-value" :class="changeClass(realizedFor(sym))">{{ signedUSD(realizedFor(sym)) }}</span>
                </div>
              </div>
              <p class="text-muted text-sm portfolio-note" v-if="cashSecuring(sym).length">
                Secures {{ cashSecuring(sym).map(occ => optionLabel(occ)).join(', ') }} — reserved cash can't pay for purchases until those puts are closed or expire.
              </p>
              <p class="text-muted text-sm portfolio-note">
                Value at a price of {{ positionSummary(sym).price != null ? formatPrice(positionSummary(sym).price) : 'the latest price' }} (delayed quote).
              </p>
              <div class="portfolio-actions">
                <button type="button" class="primary" @click="startPurchase(sym)">＋ Add purchase</button>
                <button type="button" v-if="portfolioOnly" @click="startSale(sym)">Sell</button>
                <button type="button" v-if="portfolioOnly && openPf" @click="startMove(sym)">Move…</button>
                <button type="button" @click="startPositionEdit(sym)">Edit position</button>
                <button type="button" class="danger" @click="removePosition(sym)">Remove</button>
              </div>
            </template>
            <div class="portfolio-actions" v-else-if="user && optionsFor(sym).length">
              <span class="text-muted text-sm">You hold options on {{ sym }} but no shares.</span>
              <button type="button" @click="startPurchase(sym)">＋ Add purchase</button>
            </div>

            <!-- Transactions: purchases (+) and sales (−), newest first -->
            <div class="transactions" v-if="user && transactionsFor(sym).length && !positionForms[sym]">
              <div class="transactions-title">Transactions</div>
              <table class="data-table transactions-table">
                <thead>
                  <tr><th>Date</th><th class="num">Shares</th><th class="num">Price</th><th class="num tx-amount">Amount</th><th class="num">Realized</th><th><span class="sr-only">Delete</span></th></tr>
                </thead>
                <tbody>
                  <tr v-for="tx in transactionsFor(sym)" :key="tx.id">
                    <td>
                      {{ formatDate(tx.date + 'T12:00:00') }}
                      <div class="tx-from">
                        {{ tx.type === 'sell' ? 'Sell' : tx.type === 'transfer-out' ? 'Moved to ' + tx.to : tx.type === 'transfer-in' ? 'Moved from ' + tx.from : 'Buy' }}<template v-if="tx.paidFrom"> · from {{ cashName(tx.paidFrom) }}</template><template v-if="tx.depositTo"> · to {{ cashName(tx.depositTo) }}</template>
                      </div>
                    </td>
                    <td class="num" :class="tx.type === 'sell' || tx.type === 'transfer-out' ? 'negative' : ''">{{ (tx.type === 'sell' || tx.type === 'transfer-out' ? '−' : '+') + formatShares(tx.quantity) }}</td>
                    <td class="num">{{ formatPrice(tx.price) }}</td>
                    <td class="num tx-amount">{{ formatUSD(tx.quantity * tx.price) }}</td>
                    <td class="num" :class="tx.type === 'sell' ? changeClass(tx.realized) : ''">{{ tx.type === 'sell' ? signedUSD(tx.realized) : '' }}</td>
                    <td class="num">
                      <span class="text-muted" v-if="isTransfer(tx)" title="Part of a move between portfolios">⇄</span>
                      <button type="button" class="link-button danger-link" v-else :aria-label="'Delete ' + (tx.type === 'sell' ? 'sale' : 'purchase') + ' of ' + tx.quantity + ' on ' + tx.date"
                              :title="'Delete this ' + (tx.type === 'sell' ? 'sale' : 'purchase')" @click="deleteTransaction(sym, tx)">✕</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Options on this stock: add (any list), close (Portfolio page), alerts, history -->
            <section class="options-section" v-if="user && optionable(sym) && categoryFor(sym) !== 'cash'" :aria-label="'Options on ' + sym">
              <div class="options-head">
                <span class="transactions-title" style="margin:0">Options on {{ sym }}</span>
                <button type="button" v-if="!optionForms[sym]" @click="startOption(sym)">＋ Add option</button>
              </div>

${OPTION_FORM}
              <ul class="option-list" v-if="optionsFor(sym).length">
                <li class="option-item" v-for="occ in optionsFor(sym)" :key="occ">
                  <template v-for="inList in [false]" :key="occ + '-il'">${OPTION_ITEM}</template>
                </li>
              </ul>
              <p class="text-muted text-sm option-empty" v-else-if="!optionForms[sym]">
                Track calls and puts you've bought or sold on {{ sym }} — value, G/L, days to expiration and alerts.
              </p>
            </section>
          </div>

          <!-- Alerts: this stock's alerts + quick presets (checked by the server on each quote refresh) -->
          <div class="alerts-panel" v-else-if="details[sym]?.tab === 'alerts'">
            <div class="notice" v-if="!user">
              Alerts notify you in your <strong>Inbox</strong> when {{ sym }} crosses a price, moves sharply in a day, hits a
              52-week high or low, or trades on unusual volume.
              <a href="#" @click.prevent="$emit('go-account')">Sign in</a> to create alerts.
            </div>
            <template v-else>
              <AlertForm v-if="alertForms[sym]" :symbol="sym" :quote="stockQuotes[sym]" :avg-cost="positionFor(sym)?.avgCost ?? null" :earnings="earnings[sym] ?? null"
                         :initial="alertForms[sym].initial" :submit-label="alertForms[sym].alertId ? 'Save changes' : 'Create alert'"
                         :busy="alertForms[sym].busy" :error="alertForms[sym].error"
                         @save="submitAlert(sym, $event)" @cancel="closeAlertForm(sym)" />
              <template v-else>
                <div class="alert-presets">
                  <span class="alert-presets-label">Quick add</span>
                  <button type="button" class="note-chip" v-for="pr in alertPresets({ hasPosition: !!positionFor(sym) })" :key="pr.label"
                          @click.stop="openAlertForm(sym, pr)">{{ pr.label }}</button>
                  <button type="button" class="note-chip alert-custom" @click.stop="openAlertForm(sym, undefined)">＋ Custom</button>
                </div>
                <ul class="alert-list" v-if="alertsFor(sym).length">
                  <li v-for="a in alertsFor(sym)" :key="a.id" class="alert-item" :class="{ inactive: !a.active }">
                    <span class="alert-dot" :class="a.active ? 'on' : 'off'" aria-hidden="true"></span>
                    <div class="alert-item-body">
                      <div class="alert-item-title">{{ describeAlert(a) }}</div>
                      <div class="text-muted text-sm">{{ alertStatus(a) }} · {{ a.repeat === 'daily' ? 'every day' : 'once' }}</div>
                      <div class="alert-item-note" v-if="a.note">{{ a.note }}</div>
                      <div class="notice error" v-if="a._error" style="margin:4px 0 0">{{ a._error }}</div>
                    </div>
                    <div class="alert-item-actions">
                      <button type="button" class="link-button" @click.stop="openAlertForm(sym, a, a.id)">Edit</button>
                      <button type="button" class="link-button" @click.stop="toggleAlert(a)">
                        {{ a.active ? 'Pause' : (a.repeat === 'once' && a.lastTriggeredAt ? 'Re-arm' : 'Resume') }}
                      </button>
                      <button type="button" class="link-button danger-link" @click.stop="deleteAlertConfirm(a)">Delete</button>
                    </div>
                  </li>
                </ul>
                <p class="text-muted text-sm alert-empty" v-else>
                  No alerts for {{ sym }} yet — pick a quick alert above or create a custom one.
                  Triggered alerts arrive in <strong>Inbox → Alerts</strong>.
                </p>
              </template>
            </template>
          </div>

          <!-- Documents -->
          <template v-else>
            <template v-if="details[sym]?.docs.loading">
              <div style="padding:16px">
                <div class="skeleton" style="width:60%;height:14px;margin-bottom:8px"></div>
                <div class="skeleton" style="width:40%;height:12px"></div>
              </div>
            </template>

            <div class="notice error" style="margin:12px" v-else-if="details[sym]?.docs.error">
              {{ details[sym].docs.error }}
            </div>

            <template v-else-if="details[sym]?.docs.loaded">
              <div class="filing-tabs nested">
                <button
                  v-for="tab in FORM_TABS"
                  :key="tab.id"
                  class="filing-tab"
                  :class="{ active: details[sym]?.docs.activeTab === tab.id }"
                  @click.stop="setDocsTab(sym, tab.id)"
                >{{ tab.label }}</button>
              </div>

              <div style="padding:12px 16px" v-if="details[sym]?.docs.activeTab === 'transcript'">
                <p class="text-muted text-sm" style="margin-bottom:12px">
                  No free API exists for earnings transcripts. Links below open external search pages.
                </p>
                <div v-for="link in getTranscriptLinks(sym)" :key="link.url" style="margin-bottom:8px">
                  <a :href="link.url" target="_blank" rel="noopener">{{ link.label }}</a>
                </div>
              </div>

              <div v-else style="padding:4px 0">
                <div v-if="filingsForTab(sym, details[sym]?.docs.activeTab).length === 0"
                     class="text-muted text-sm" style="padding:16px">
                  No {{ details[sym]?.docs.activeTab }} filings found in recent history.
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
                    <tr v-for="filing in filingsForTab(sym, details[sym]?.docs.activeTab)" :key="filing.accessionNumber">
                      <td style="font-weight:600">{{ filing.form }}</td>
                      <td>{{ filing.filingDate }}</td>
                      <td class="text-muted">{{ filing.reportDate || '—' }}</td>
                      <td>
                        <a
                          v-if="filing.primaryDocument"
                          :href="buildFilingUrl(details[sym].docs.cik, filing.accessionNumber, filing.primaryDocument)"
                          target="_blank" rel="noopener"
                        >{{ filing.primaryDocument }}</a>
                        <span v-else class="text-muted">—</span>
                      </td>
                      <td>
                        <a
                          :href="buildIndexUrl(details[sym].docs.cik, filing.accessionNumber)"
                          target="_blank" rel="noopener"
                          class="text-muted text-sm"
                        >View index</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </template>
        </div>
      </div>

      </div>
      </div>

      <!-- Portfolio page: Options — every open contract by expiration; collapsible -->
      <div class="holdings-card options-card" :class="{ collapsed: !optionsOpen }"
           v-if="portfolioOnly && openPf && user">
        <button type="button" class="holdings-toggle" :aria-expanded="optionsOpen" aria-controls="portfolio-options"
                @click="optionsOpen = !optionsOpen">
          <span class="holdings-heading">
            <span class="holdings-chevron" aria-hidden="true">▶</span>
            <span class="holdings-title">Options</span>
            <span class="holdings-count">{{ openOptionSymbols.length }}</span>
          </span>
          <span class="holdings-stats" v-if="optionsTotals">
            <span class="holdings-stat" title="Long contracts count positive, short ones negative">
              <span class="holdings-stat-label">Net value</span>
              <span class="holdings-stat-value">{{ optionsTotals.value != null ? formatUSD(optionsTotals.value) : '—' }}</span>
            </span>
            <span class="holdings-stat">
              <span class="holdings-stat-label">Net premium</span>
              <span class="holdings-stat-value">{{ formatUSD(Math.abs(optionsTotals.totalCost)) }} {{ optionsTotals.totalCost < 0 ? 'received' : 'paid' }}</span>
            </span>
            <span class="holdings-stat">
              <span class="holdings-stat-label">G/L</span>
              <span class="holdings-stat-value" :class="changeClass(optionsTotals.gain)">
                {{ optionsTotals.gain != null ? signedUSD(optionsTotals.gain) + (optionsTotals.gainPct != null ? ' (' + formatPct(optionsTotals.gainPct) + ')' : '') : '—' }}
              </span>
            </span>
            <span class="holdings-stat">
              <span class="holdings-stat-label">Today's G/L</span>
              <span class="holdings-stat-value" :class="changeClass(optionsTotals.dayGain)">{{ optionsTotals.dayGain != null ? signedUSD(optionsTotals.dayGain) : '—' }}</span>
            </span>
            <span class="holdings-stat" v-if="totalReserved > 0" title="Cash reserved to secure short puts — still yours, and still counted in Holdings">
              <span class="holdings-stat-label">Reserved cash</span>
              <span class="holdings-stat-value">{{ formatUSD(totalReserved) }}</span>
            </span>
          </span>
        </button>
        <div id="portfolio-options" class="options-body" v-show="optionsOpen">
          <template v-if="optionAdd.ticker && optionForms[optionAdd.ticker]">
            <div class="options-add-title">New option on {{ optionAdd.ticker }}</div>
            <template v-for="sym in [optionAdd.ticker]" :key="'add-' + sym">${OPTION_FORM}</template>
          </template>
          <form class="options-add-bar" v-else @submit.prevent="startOptionAdd" novalidate>
            <input v-model="optionAdd.input" placeholder="Ticker, e.g. XOM" aria-label="Stock ticker for a new option"
                   autocomplete="off" autocapitalize="characters" maxlength="6" @input="optionAdd.error = null" />
            <button type="submit" :disabled="optionAdd.busy">{{ optionAdd.busy ? 'Looking up…' : '＋ Add option' }}</button>
            <span class="negative text-sm" v-if="optionAdd.error">{{ optionAdd.error }}</span>
          </form>

          <div class="sort-bar sort-bar-inset" v-if="openOptionSymbols.length > 1" role="group" aria-label="Sort options">
            <span class="sort-bar-label">Sort</span>
            <button v-for="o in OPTION_SORTS" :key="o.id" type="button" class="sort-chip" :class="{ active: optionSort.key === o.id }"
                    :aria-pressed="optionSort.key === o.id" @click="setSort('options', o.id)">
              {{ o.label }}<span class="sort-dir" v-if="optionSort.key === o.id" :aria-label="optionSort.dir === 'asc' ? 'ascending' : 'descending'">{{ optionSort.dir === 'asc' ? '↑' : '↓' }}</span>
            </button>
          </div>

          <ul class="option-list option-list-flat" v-if="optionSort.key !== 'expiry'">
            <li class="option-item" v-for="occ in sortedOptions" :key="occ">
              <template v-for="sym in [optionPositionFor(occ).underlying]" :key="occ + '-sym'">
                <template v-for="inList in [true]" :key="occ + '-il'">${OPTION_ITEM}</template>
              </template>
            </li>
          </ul>
          <template v-else>
          <section class="option-group" v-for="g in optionGroups" :key="g.expiry" :aria-label="'Expiring ' + g.expiry">
            <h4 class="option-group-head" :class="{ soon: g.days >= 0 && g.days <= 7, expired: g.days < 0 }">
              {{ formatDate(g.expiry + 'T12:00:00') }}
              <span>· {{ g.days < 0 ? 'expired' : g.days === 0 ? 'expires today' : g.days + ' day' + (g.days === 1 ? '' : 's') + ' left' }}</span>
            </h4>
            <ul class="option-list">
              <li class="option-item" v-for="occ in g.items" :key="occ">
                <template v-for="sym in [optionPositionFor(occ).underlying]" :key="occ + '-sym'">
                  <template v-for="inList in [true]" :key="occ + '-il'">${OPTION_ITEM}</template>
                </template>
              </li>
            </ul>
          </section>
          </template>
          <p class="text-muted text-sm option-empty" v-if="!openOptionSymbols.length && !(optionAdd.ticker && optionForms[optionAdd.ticker])">
            No open options. Add one above, or from a stock's Portfolio tab.
          </p>
        </div>
      </div>

      <!-- Portfolio page: Closed positions — collapsible, totals at average cost -->
      <div class="holdings-card closed-card" v-if="portfolioOnly && openPf && closedPositions.length">
        <button type="button" class="holdings-toggle" :aria-expanded="closedOpen" aria-controls="closed-positions"
                @click="closedOpen = !closedOpen">
          <span class="holdings-heading">
            <span class="holdings-chevron" aria-hidden="true">▶</span>
            <span class="holdings-title">Closed positions</span>
            <span class="holdings-count">{{ closedPositions.length }}</span>
          </span>
          <span class="holdings-stats">
            <span class="holdings-stat">
              <span class="holdings-stat-label">Cost basis</span>
              <span class="holdings-stat-value">{{ formatUSD(closedTotals.costBasis) }}</span>
            </span>
            <span class="holdings-stat">
              <span class="holdings-stat-label">Proceeds</span>
              <span class="holdings-stat-value">{{ formatUSD(closedTotals.proceeds) }}</span>
            </span>
            <span class="holdings-stat">
              <span class="holdings-stat-label">Realized G/L</span>
              <span class="holdings-stat-value" :class="changeClass(closedTotals.realized)">
                {{ signedUSD(closedTotals.realized) }}<template v-if="closedTotals.realizedPct != null"> ({{ formatPct(closedTotals.realizedPct) }})</template>
              </span>
            </span>
          </span>
        </button>
        <ul class="closed-list" id="closed-positions" v-show="closedOpen">
          <li class="closed-row" v-for="c in closedPositions" :key="c.id">
            <div class="closed-id">
              <template v-if="c.kind === 'option'">
                <span class="option-side" :class="c.option.side">{{ c.option.side === 'short' ? 'Short' : 'Long' }}</span>
                <span class="stock-row-ticker">{{ c.name }}</span>
              </template>
              <template v-else>
                <span class="stock-row-ticker">{{ c.symbol }}</span>
                <span class="text-muted text-sm closed-name">{{ c.name }}</span>
              </template>
              <div class="text-muted text-sm">
                {{ c.openedDate ? formatDate(c.openedDate + 'T12:00:00') + ' – ' : 'Closed ' }}{{ formatDate(c.closedDate + 'T12:00:00') }}
              </div>
            </div>
            <div class="closed-nums">
              <template v-if="c.kind === 'option'">
                <span class="stock-row-num"><span class="stock-row-label">Contracts</span><span>{{ c.sharesSold }}</span></span>
                <span class="stock-row-num"><span class="stock-row-label">Avg open</span><span>{{ formatPrice(c.avgOpen) }}</span></span>
                <span class="stock-row-num"><span class="stock-row-label">Avg close</span><span>{{ formatPrice(c.avgClose) }}</span></span>
              </template>
              <template v-else>
                <span class="stock-row-num"><span class="stock-row-label">Shares</span><span>{{ formatShares(c.sharesSold) }}</span></span>
                <span class="stock-row-num"><span class="stock-row-label">Avg cost</span><span>{{ formatPrice(c.costBasis / c.sharesSold) }}</span></span>
                <span class="stock-row-num"><span class="stock-row-label">Avg sale</span><span>{{ formatPrice(c.proceeds / c.sharesSold) }}</span></span>
              </template>
              <span class="stock-row-num"><span class="stock-row-label">Cost basis</span><span>{{ formatUSD(c.costBasis) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Proceeds</span><span>{{ formatUSD(c.proceeds) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Realized G/L</span>
                <span :class="changeClass(c.realized)">{{ signedUSD(c.realized) }}<template v-for="base in [c.option?.side === 'short' ? c.proceeds : c.costBasis]"><template v-if="base > 0"> ({{ formatPct((c.realized / base) * 100) }})</template></template></span>
              </span>
            </div>
            <div class="closed-actions">
              <button type="button" class="link-button" @click="reopenClosed(c)" title="Undo the final sale and return it to Holdings">Undo close</button>
              <button type="button" class="link-button danger-link" @click="deleteClosed(c)">Delete</button>
            </div>
          </li>
        </ul>
      </div>

      <!-- Account → Transactions: the trade history -->
      <PortfolioActivity v-if="portfolioOnly && pfTab === 'activity'" :portfolios="portfolios" :account-cash="accountCash" :transfers="config.transfers ?? []"
                         :start-share="startShare" @go-activity="$emit('go-activity', 'you')" />

      <!-- After a copy / move / remove in edit mode: what happened, with Undo -->
      <div class="wl-toast" v-if="transferToast" role="status">
        <span>{{ transferToast.error || transferToast.message }}</span>
        <button type="button" class="link-button" :disabled="transferToast.busy" @click="undoTransfer">{{ transferToast.busy ? 'Undoing…' : 'Undo' }}</button>
        <button type="button" class="link-button" aria-label="Dismiss" @click="transferToast = null">✕</button>
      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="tickers.length && onPositions">
        Quotes/sparklines and historical chart prices from Yahoo Finance (unofficial API), delayed 15–20 minutes.
        Ticker news from Yahoo Finance. SEC filings from SEC EDGAR (data.sec.gov), no API key required. Each tab loads the first time you open it. Use the search icon to add stocks and the ☰ menu to edit (remove stocks) and manage lists; drag a card by its ⠿ handle to reorder.
      </div>
    </div>
  `,
};
