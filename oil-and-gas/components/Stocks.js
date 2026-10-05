const { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } = Vue;
import { fetchQuote, fetchChart, fetchKeyStats, fetchTickerNews, searchSymbols, fetchSector } from '../services/yahooFinance.js';
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
import { alertsStore, alertsFor, saveAlert, setAlertActive, removeAlert } from '../utils/alertsStore.js';
import { describeAlert, alertPresets, alertStatus } from '../utils/alerts.js';
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

export default {
  name: 'Stocks',
  components: { HistoryChart, AllocationChart, NoteForm, AlertForm, TopMovers },
  // portfolioOnly: render as the top-level Portfolio page (app.js) — just
  // the stocks you hold a position in, with totals; no indexes or list picker.
  props: { config: Object, user: Object, portfolioOnly: Boolean },
  // set-tickers: new order/contents for the default watchlist (config.stocks.tickers)
  // set-position: { symbol, position: { quantity, avgCost, category?, transactions? } | null }
  //   or { updates: { SYMBOL: position | null } } to save several together — for config.portfolio
  // go-notes: open the Notes tab (from a news item already saved there)
  emits: ['set-tickers', 'set-position', 'updated', 'go-account', 'go-notes'],
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
    // The Portfolio page (portfolioOnly) is a virtual, read-only list: every
    // ticker with a saved position (config.portfolio), in the order added.
    const portfolioTickers = computed(() =>
      Object.entries(props.config.portfolio ?? {})
        .filter(([, p]) => p?.quantity > 0)
        .map(([sym]) => sym)
    );
    const isPortfolioList = computed(() => props.portfolioOnly);
    // Default has no Portfolio tab; your own lists and the Portfolio list do.

    // While a remembered custom list is still loading, show nothing rather
    // than flashing the default list's cards.
    const activeTickers = computed(() => {
      if (isPortfolioList.value) return portfolioTickers.value;
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

    // Edit mode: a remove button on each card.
    const editMode = ref(false);
    function removeTicker(sym) {
      saveTickers(activeTickers.value.filter(t => t !== sym));
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
      if (props.portfolioOnly) holdingsOpen.value = true;
      ensureDetail(sym);
      if (!details[sym].open) toggleDetail(sym);
      nextTick(() => watchlistEl.value?.querySelector(`[data-ticker="${CSS.escape(sym)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }

    async function refreshAll() {
      // The list shown plus whatever Top movers ranks (they can differ).
      const symbols = [...new Set([...tickers.value, ...moverSymbols.value])];
      await Promise.all([fetchStockQuotes(symbols), props.portfolioOnly ? null : fetchIndexes()]);
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
    const details = reactive({}); // ticker → { open, tab: 'chart'|'documents', chart: {...}, docs: {...} }

    function ensureDetail(ticker) {
      if (!details[ticker]) {
        details[ticker] = {
          open: false,
          tab: 'chart',
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
      if (tab === 'chart') {
        loadChart(ticker);
        loadStats(ticker);
      } else if (tab === 'news') loadNews(ticker);
      else if (tab === 'documents') loadDocs(ticker);
      else if (tab === 'portfolio' && props.user && !positionFor(ticker) && !positionForms[ticker]) startPurchase(ticker);
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
      if (!confirm(`Delete this ${alert.symbol} alert?\n\n${describeAlert(alert)}`)) return;
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
      const p = props.config.portfolio?.[ticker];
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
      const position = { quantity, avgCost };
      if (f.category) position.category = f.category;
      // Editing the totals keeps the purchase history.
      const txs = positionFor(ticker)?.transactions;
      if (txs?.length) position.transactions = txs;
      emit('set-position', { symbol: ticker, position });
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
      const missing = Object.keys(props.config.portfolio ?? {}).filter(sym => !stockQuotes[sym]);
      if (missing.length) fetchStockQuotes(missing);
    }

    // ── Paying for a purchase from a cash holding ──
    // Holdings whose asset type is Cash (money-market funds like SPAXX, or set
    // to Cash by hand), other than the stock being bought, with what's
    // available at the current price ($1 NAV when there's no quote yet).
    function cashSources(ticker) {
      return Object.entries(props.config.portfolio ?? {})
        .filter(([sym, p]) => sym !== ticker && p?.quantity > 0 && categoryFor(sym) === 'cash')
        .map(([sym, p]) => {
          const price = stockQuotes[sym]?.price || 1;
          return { symbol: sym, price, available: p.quantity * price };
        });
    }
    function payFromFor(ticker) {
      const f = purchaseForms[ticker];
      if (!f) return '';
      return f.payFrom ?? cashSources(ticker)[0]?.symbol ?? '';
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
      const p = positionFor(ticker);
      const next = purchasePreview(ticker);
      const tx = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: f.date, quantity: qty, price };
      const updates = {};
      // Deduct the cost from the chosen cash holding (its average cost stays).
      const src = cashSources(ticker).find(c => c.symbol === payFromFor(ticker));
      if (src) {
        if (next.cost > src.available + 0.005) {
          f.error = `Only ${formatUSD(src.available)} in ${src.symbol} — pay from another holding, or choose "Outside the portfolio".`;
          return;
        }
        const cashPos = positionFor(src.symbol);
        const shares = next.cost / src.price;
        const left = cashPos.quantity - shares;
        updates[src.symbol] = left > 1e-9 ? { ...cashPos, quantity: left } : null;
        Object.assign(tx, { paidFrom: src.symbol, paidShares: shares });
      }
      const position = { quantity: next.quantity, avgCost: next.avgCost, transactions: [...(p?.transactions ?? []), tx] };
      if (p?.category) position.category = p.category;
      updates[ticker] = position;
      emit('set-position', { updates });
      delete purchaseForms[ticker];
      delete positionForms[ticker];
    }

    // ── Selling (Portfolio page only) ──
    // A sale lowers the share count at the same average cost and realizes
    // (price − avg cost) × shares. Selling everything moves the position to
    // config.closedPositions. Proceeds can go into a cash holding.
    const saleForms = reactive({}); // ticker → { quantity, price, date, depositTo, error }
    const closedPositions = computed(() => props.config.closedPositions ?? []);

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
        const cashPos = positionFor(dest.symbol);
        const shares = (qty * price) / dest.price;
        updates[dest.symbol] = { ...cashPos, quantity: cashPos.quantity + shares };
        Object.assign(tx, { depositTo: dest.symbol, depositShares: shares });
      }
      const transactions = [...(p.transactions ?? []), tx];
      const remaining = p.quantity - qty;
      let closed;
      if (remaining <= 1e-9) {
        updates[ticker] = null;
        closed = [closedRecord(ticker, p, transactions, f.date), ...closedPositions.value];
        delete details[ticker]; // its card leaves Holdings
      } else {
        updates[ticker] = { ...p, quantity: remaining, transactions };
      }
      emit('set-position', closed ? { updates, closed } : { updates });
      delete saleForms[ticker];
    }

    // Undo a sale on an open position: shares back, proceeds out of cash.
    function reverseDeposit(updates, tx) {
      if (!tx.depositTo || !(tx.depositShares > 0)) return;
      const cashPos = positionFor(tx.depositTo);
      if (!cashPos) return; // that cash holding is gone — nothing to take back
      const left = cashPos.quantity - tx.depositShares;
      updates[tx.depositTo] = left > 1e-9 ? { ...cashPos, quantity: left } : null;
    }
    function deleteSale(ticker, tx) {
      const back = tx.depositTo ? `\n${formatUSD(tx.quantity * tx.price)} comes back out of ${tx.depositTo}.` : '';
      if (!confirm(`Delete this sale?\n\n${formatShares(tx.quantity)} ${ticker} at ${formatPrice(tx.price)} on ${tx.date}\n\nThe shares go back into your position.${back}`)) return;
      const p = positionFor(ticker);
      if (!p) return;
      const updates = {};
      reverseDeposit(updates, tx);
      const rest = (p.transactions ?? []).filter(t => t.id !== tx.id);
      updates[ticker] = { ...p, quantity: p.quantity + tx.quantity, transactions: rest };
      emit('set-position', { updates });
    }

    // Closed positions: undo the final sale (back to Holdings), or delete the record.
    function reopenClosed(rec) {
      if (positionFor(rec.symbol)) {
        alert(`You hold ${rec.symbol} again — record further sales or purchases on its open position instead.`);
        return;
      }
      const last = [...rec.transactions].reverse().find(t => t.type === 'sell');
      if (!last) return;
      if (!confirm(`Undo the ${rec.symbol} sale of ${formatShares(last.quantity)} shares on ${last.date}?\n\nIt goes back to your Holdings.` + (last.depositTo ? `\n${formatUSD(last.quantity * last.price)} comes back out of ${last.depositTo}.` : ''))) return;
      const updates = {};
      reverseDeposit(updates, last);
      const position = {
        quantity: last.quantity, avgCost: last.avgCost,
        transactions: rec.transactions.filter(t => t.id !== last.id),
      };
      if (rec.category) position.category = rec.category;
      updates[rec.symbol] = position;
      emit('set-position', { updates, closed: closedPositions.value.filter(c => c.id !== rec.id) });
    }
    function deleteClosed(rec) {
      if (!confirm(`Delete the closed ${rec.symbol} position from your history?\n\nThis doesn't change any cash holding.`)) return;
      emit('set-position', { closed: closedPositions.value.filter(c => c.id !== rec.id) });
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

    function transactionsFor(ticker) {
      return [...(positionFor(ticker)?.transactions ?? [])]
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    }

    function deleteTransaction(ticker, tx) {
      if (tx.type === 'sell') return deleteSale(ticker, tx);
      const refund = tx.paidFrom ? `\n${formatUSD(tx.quantity * tx.price)} goes back to ${tx.paidFrom}.` : '';
      if (!confirm(`Delete this purchase?\n\n${formatShares(tx.quantity)} ${ticker} at ${formatPrice(tx.price)} on ${tx.date}\n\nYour position will be reduced accordingly.${refund}`)) return;
      const p = positionFor(ticker);
      if (!p) return;
      // Money it took from a cash holding goes back there (re-created if that
      // holding has since been removed).
      const updates = {};
      if (tx.paidFrom && tx.paidShares > 0) {
        const cashPos = positionFor(tx.paidFrom);
        updates[tx.paidFrom] = cashPos
          ? { ...cashPos, quantity: cashPos.quantity + tx.paidShares }
          : { quantity: tx.paidShares, avgCost: 1, category: 'cash' };
      }
      const rest = (p.transactions ?? []).filter(t => t.id !== tx.id);
      const quantity = p.quantity - tx.quantity;
      if (quantity <= 1e-9) {
        // That purchase was the whole position — back to "add a purchase".
        emit('set-position', { updates: { ...updates, [ticker]: null } });
        startPurchase(ticker);
        return;
      }
      // Reverse the weighted average; if the totals were edited by hand since,
      // that can come out non-positive — then keep the current average.
      const reversed = (p.quantity * p.avgCost - tx.quantity * tx.price) / quantity;
      const position = { quantity, avgCost: reversed > 0 ? reversed : p.avgCost };
      if (p.category) position.category = p.category;
      if (rest.length) position.transactions = rest;
      emit('set-position', { updates: { ...updates, [ticker]: position } });
    }

    function removePosition(ticker) {
      const n = positionFor(ticker)?.transactions?.length ?? 0;
      if (!confirm(`Remove your ${ticker} position${n ? ` and its ${n} purchase${n === 1 ? '' : 's'}` : ''}?`)) return;
      emit('set-position', { symbol: ticker, position: null });
      // Back to "add a purchase" for this stock.
      delete positionForms[ticker];
      startPurchase(ticker);
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
    const portfolioTotals = computed(() => {
      const rows = portfolioTickers.value.map(positionSummary).filter(Boolean);
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
    });

    // ── Allocation charts (Portfolio page), shown side by side ──
    // Slices wait for every price and category (and, by sector, every
    // stock's sector) so a chart never shows a partial picture.
    const categoryOrder = CATEGORIES.map(c => c.id);
    function allocationRows() {
      const rows = portfolioTickers.value.map(positionSummary).filter(Boolean);
      return rows.some(r => r.value == null || !r.category) ? null : rows;
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
      portfolioTickers.value.some(t => categoryFor(t) && categoryFor(t) !== 'stocks')
    );

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
      saleForms, startSale, cancelSale, depositToFor, salePreview, saveSale, closedPositions, closedTotals,
      reopenClosed, deleteClosed, realizedFor, closedOpen,
      isPortfolioList, portfolioTotals,
      CATEGORIES, CATEGORY_LABELS, autoCategoryFor, rangeFor, rangeLabel,
      moverSources, moverSelected, openMover, holdingsOpen,
      notesStore, findNote, noteForms, noteKey, openNoteForm, closeNoteForm, saveNewNote,
      alertsStore, alertsFor, activeAlertCount, alertForms, openAlertForm, closeAlertForm, submitAlert,
      toggleAlert, deleteAlertConfirm, alertStatus, describeAlert, alertPresets,
      allocationByType, allocationBySector, hasNonStockHoldings, startPositionEdit, cancelPositionEdit, savePosition, removePosition,
      buildFilingUrl, buildIndexUrl, getTranscriptLinks,
      formatUSD, formatPrice, formatNumber, formatPct, formatVolume, formatDate, formatRelativeTime, changeClass,
      safeArticleUrl, onArticleClick,
    };
  },
  template: `
    <div>
      <div class="flex-between mb-16" v-if="portfolioOnly">
        <div class="section-header" style="margin-bottom:0">Portfolio</div>
        <div class="text-muted text-sm" v-if="lastUpdated">Updated {{ lastUpdated }}</div>
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

      <!-- Allocation: by asset type and by sector, side by side -->
      <div class="card allocation-card" v-if="isPortfolioList && portfolioTotals">
        <div class="card-title allocation-head">Allocation</div>
        <div class="allocation-pair">
          <section class="allocation-panel" aria-label="Allocation by asset type">
            <h3 class="allocation-panel-title">By asset type</h3>
            <AllocationChart v-if="allocationByType && allocationByType.length" :slices="allocationByType" label="Allocation by asset type" />
            <div class="skeleton allocation-skeleton" v-else></div>
          </section>
          <section class="allocation-panel" aria-label="Allocation by sector">
            <h3 class="allocation-panel-title">By sector</h3>
            <AllocationChart v-if="allocationBySector && allocationBySector.length" :slices="allocationBySector" label="Allocation by sector" />
            <div class="skeleton allocation-skeleton" v-else></div>
          </section>
        </div>
        <p class="text-muted text-sm allocation-note">
          By current market value.
          Asset types come from Yahoo Finance — change one on a stock's Portfolio tab (e.g. a bond fund → Bonds).
          <template v-if="hasNonStockHoldings">By sector groups stocks by their sector and other holdings by type (fund sector breakdowns aren't available).</template>
        </p>
      </div>

      <!-- Top movers (Portfolio page: under the allocation charts) -->
      <TopMovers v-if="portfolioOnly" :sources="moverSources" v-model:selected-ids="moverSelected"
                 :quotes="stockQuotes" @select="openMover" />

      <div class="notice" v-if="listsLoading && !tickers.length">Loading your watchlists…</div>
      <div class="notice" v-else-if="isPortfolioList && !tickers.length">
        <template v-if="closedPositions.length">No open positions — your sold positions are under Closed positions below.</template>
        <template v-else>No positions yet. Open a stock in one of your watchlists and use its Portfolio tab to add a purchase.</template>
      </div>
      <div class="notice" v-else-if="tickers.length === 0">
        This watchlist is empty — search above to add stocks.
      </div>

      <!-- Watchlist as accordions — expand a ticker to see its SEC filings; -->
      <!-- drag a card by its handle to reorder (saved to settings). -->
      <!-- Portfolio page: holdings as one collapsible card — header row, then a
           row per stock (on Markets → Stocks this wrapper adds nothing) -->
      <div :class="{ 'holdings-card': portfolioOnly && tickers.length, collapsed: portfolioOnly && !holdingsOpen }">
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
      <div ref="watchlistEl" id="portfolio-holdings" class="watchlist" :class="{ 'is-dragging': draggingTicker }"
           v-show="!portfolioOnly || holdingsOpen">
      <div class="accordion-item watchlist-item" v-for="sym in tickers" :key="sym" :data-ticker="sym"
           :class="{ dragging: draggingTicker === sym, 'just-added': justAdded === sym }">
        <div class="accordion-header stock-row-header" :class="{ open: details[sym]?.open }" @click="toggleDetail(sym)"
             @pointerdown="onCardPointerDown($event, sym)" @contextmenu="onCardContextMenu">
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
            <div class="stock-row-id">
              <span class="stock-row-ticker">{{ sym }}</span>
              <span class="text-muted text-sm">{{ stockQuotes[sym]?.shortName }}</span>
            </div>
            <!-- 52-week range: today's price (●); on the Portfolio page also your average cost (│) -->
            <template v-for="r in [rangeFor(sym, portfolioOnly)]" :key="'r52-' + sym">
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
          <button v-if="editMode" type="button" class="watchlist-remove"
                  :aria-label="'Remove ' + sym + ' from this watchlist'" :title="'Remove ' + sym"
                  @click.stop="removeTicker(sym)">✕</button>
          <span v-else class="chevron">▶</span>
        </div>

        <!-- Charts + Documents (SEC filings) — same content that -->
        <!-- used to live on the standalone Documents tab, now nested here. -->
        <div class="accordion-body" v-if="details[sym]?.open">
          <div class="filing-tabs">
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

          <!-- Charts (price history) -->
          <template v-if="details[sym]?.tab === 'chart'">
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
            <div class="notice" v-if="!user">
              Track your {{ sym }} position — enter quantity and average cost to see its market value, total and
              today's gain/loss, and add it to your Portfolio page with allocation charts.
              <a href="#" @click.prevent="$emit('go-account')">Sign in</a> to track positions.
            </div>
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
                    <option v-for="c in cashSources(sym)" :key="c.symbol" :value="c.symbol">{{ c.symbol }} — {{ formatUSD(c.available) }}</option>
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
                  Deposited to {{ salePreview(sym).to.symbol }}: {{ formatUSD(salePreview(sym).to.before) }} → {{ formatUSD(salePreview(sym).to.after) }}
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
                      {{ c.symbol }} — {{ formatUSD(c.available) }} available
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
                  Paid from {{ purchasePreview(sym).from.symbol }}:
                  {{ formatUSD(purchasePreview(sym).from.available) }} →
                  <span :class="{ negative: purchasePreview(sym).from.after < 0 }">{{ formatUSD(purchasePreview(sym).from.after) }}</span>
                  <span class="negative" v-if="purchasePreview(sym).from.after < 0"> (not enough)</span>
                </template>
                <span class="text-muted" v-else>Not deducted from a cash holding.</span>
              </p>
              <div class="notice error portfolio-error" v-if="purchaseForms[sym].error">{{ purchaseForms[sym].error }}</div>
              <div class="portfolio-actions">
                <button type="submit" class="primary">Add purchase</button>
                <button type="button" v-if="positionFor(sym)" @click="cancelPurchase(sym)">Cancel</button>
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
                    <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
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
                <div class="portfolio-stat" v-if="realizedFor(sym) != null">
                  <span class="portfolio-label">Realized G/L</span>
                  <span class="portfolio-value" :class="changeClass(realizedFor(sym))">{{ signedUSD(realizedFor(sym)) }}</span>
                </div>
              </div>
              <p class="text-muted text-sm portfolio-note">
                Value at a price of {{ positionSummary(sym).price != null ? formatPrice(positionSummary(sym).price) : 'the latest price' }} (delayed quote).
              </p>
              <div class="portfolio-actions">
                <button type="button" class="primary" @click="startPurchase(sym)">＋ Add purchase</button>
                <button type="button" v-if="portfolioOnly" @click="startSale(sym)">Sell</button>
                <button type="button" @click="startPositionEdit(sym)">Edit position</button>
                <button type="button" class="danger" @click="removePosition(sym)">Remove</button>
              </div>
            </template>

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
                        {{ tx.type === 'sell' ? 'Sell' : 'Buy' }}<template v-if="tx.paidFrom"> · from {{ tx.paidFrom }}</template><template v-if="tx.depositTo"> · to {{ tx.depositTo }}</template>
                      </div>
                    </td>
                    <td class="num" :class="tx.type === 'sell' ? 'negative' : ''">{{ (tx.type === 'sell' ? '−' : '+') + formatShares(tx.quantity) }}</td>
                    <td class="num">{{ formatPrice(tx.price) }}</td>
                    <td class="num tx-amount">{{ formatUSD(tx.quantity * tx.price) }}</td>
                    <td class="num" :class="tx.type === 'sell' ? changeClass(tx.realized) : ''">{{ tx.type === 'sell' ? signedUSD(tx.realized) : '' }}</td>
                    <td class="num">
                      <button type="button" class="link-button danger-link" :aria-label="'Delete ' + (tx.type === 'sell' ? 'sale' : 'purchase') + ' of ' + tx.quantity + ' on ' + tx.date"
                              :title="'Delete this ' + (tx.type === 'sell' ? 'sale' : 'purchase')" @click="deleteTransaction(sym, tx)">✕</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Alerts: this stock's alerts + quick presets (checked by the server on each quote refresh) -->
          <div class="alerts-panel" v-else-if="details[sym]?.tab === 'alerts'">
            <div class="notice" v-if="!user">
              Alerts notify you in your <strong>Inbox</strong> when {{ sym }} crosses a price, moves sharply in a day, hits a
              52-week high or low, or trades on unusual volume.
              <a href="#" @click.prevent="$emit('go-account')">Sign in</a> to create alerts.
            </div>
            <template v-else>
              <AlertForm v-if="alertForms[sym]" :symbol="sym" :quote="stockQuotes[sym]" :avg-cost="positionFor(sym)?.avgCost ?? null"
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

      <!-- Portfolio page: Closed positions — collapsible, totals at average cost -->
      <div class="holdings-card closed-card" v-if="portfolioOnly && closedPositions.length">
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
              <span class="stock-row-ticker">{{ c.symbol }}</span>
              <span class="text-muted text-sm closed-name">{{ c.name }}</span>
              <div class="text-muted text-sm">
                {{ c.openedDate ? formatDate(c.openedDate + 'T12:00:00') + ' – ' : 'Closed ' }}{{ formatDate(c.closedDate + 'T12:00:00') }}
              </div>
            </div>
            <div class="closed-nums">
              <span class="stock-row-num"><span class="stock-row-label">Shares</span><span>{{ formatShares(c.sharesSold) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Avg cost</span><span>{{ formatPrice(c.costBasis / c.sharesSold) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Avg sale</span><span>{{ formatPrice(c.proceeds / c.sharesSold) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Cost basis</span><span>{{ formatUSD(c.costBasis) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Proceeds</span><span>{{ formatUSD(c.proceeds) }}</span></span>
              <span class="stock-row-num"><span class="stock-row-label">Realized G/L</span>
                <span :class="changeClass(c.realized)">{{ signedUSD(c.realized) }}<template v-if="c.costBasis > 0"> ({{ formatPct((c.realized / c.costBasis) * 100) }})</template></span>
              </span>
            </div>
            <div class="closed-actions">
              <button type="button" class="link-button" @click="reopenClosed(c)" title="Undo the final sale and return it to Holdings">Undo close</button>
              <button type="button" class="link-button danger-link" @click="deleteClosed(c)">Delete</button>
            </div>
          </li>
        </ul>
      </div>

      <div class="notice text-sm" style="margin-top:12px" v-if="tickers.length">
        Quotes/sparklines and historical chart prices from Yahoo Finance (unofficial API), delayed 15–20 minutes.
        Ticker news from Yahoo Finance. SEC filings from SEC EDGAR (data.sec.gov), no API key required. Each tab loads the first time you open it. Use the search icon to add stocks and the ☰ menu to edit (remove stocks) and manage lists; drag a card by its ⠿ handle to reorder.
      </div>
    </div>
  `,
};
