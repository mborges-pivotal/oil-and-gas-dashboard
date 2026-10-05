const { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } = Vue;
import { fetchQuote, fetchChart, fetchKeyStats, fetchTickerNews, searchSymbols, fetchSector } from '../services/yahooFinance.js';
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_SHORT, autoCategory, buildSlices, assignSlots, shortSector } from '../utils/allocation.js';
import { fetchWatchlists, createWatchlist, updateWatchlist, deleteWatchlist } from '../services/watchlists.js';
import { resolveCIK, fetchFilings, extractFilings, buildFilingUrl, buildIndexUrl, getTranscriptLinks } from '../services/edgar.js';
import { formatUSD, formatNumber, formatPct, formatPercentLevel, formatVolume, formatLargeUSD, formatDate, formatRelativeTime, changeClass } from '../utils/formatters.js';
import { safeArticleUrl, onArticleClick } from '../utils/articleViewer.js';
import { RANGE_OPTIONS, cutoffDateFor } from '../utils/dateRange.js';

// Stock charts also get a 1D (intraday) range; the shared RANGE_OPTIONS
// serve daily/weekly series where a single day doesn't make sense.
const STOCK_RANGE_OPTIONS = [{ id: '1D', label: '1D' }, ...RANGE_OPTIONS];
import HistoryChart from './HistoryChart.js';
import AllocationChart from './AllocationChart.js';
import NoteForm from './NoteForm.js';
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
  components: { HistoryChart, AllocationChart, NoteForm },
  // portfolioOnly: render as the top-level Portfolio page (app.js) — just
  // the stocks you hold a position in, with totals; no indexes or list picker.
  props: { config: Object, user: Object, portfolioOnly: Boolean },
  // set-tickers: new order/contents for the default watchlist (config.stocks.tickers)
  // set-position: { symbol, position: { quantity, avgCost, category? } | null } for config.portfolio
  // set-cash: cash balance (number) for config.portfolioCash
  // go-notes: open the Notes tab (from a news item already saved there)
  emits: ['set-tickers', 'set-position', 'set-cash', 'updated', 'go-account', 'go-notes'],
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
    const hasPortfolioTab = computed(() => !!activeList.value || isPortfolioList.value);

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
    // The Portfolio page doesn't use the watchlists.
    if (!props.portfolioOnly) watch(() => props.user?.id ?? null, loadLists, { immediate: true });

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

    async function refreshAll() {
      await Promise.all([fetchStockQuotes(), props.portfolioOnly ? null : fetchIndexes()]);
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

    // ── Per-ticker detail panel: two tabs, "Historical Chart" and ──
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
        { label: 'Open', value: formatUSD(q.open) },
        { label: 'High', value: formatUSD(q.dayHigh) },
        { label: 'Low', value: formatUSD(q.dayLow) },
        { label: 'Vol', value: formatVolume(q.volume) },
        { label: 'Avg Vol (3M)', fromStats: true, value: formatVolume(s.avgVolume) },
        { label: 'Mkt Cap', fromStats: true, value: formatLargeUSD(marketCap) },
        { label: 'P/E (TTM)', fromStats: true, value: formatNumber(pe) },
        { label: 'EPS (TTM)', fromStats: true, value: formatUSD(s.eps) },
        { label: 'Div Yield (TTM)', fromStats: true, value: formatPercentLevel(divYield) },
        { label: 'Beta (5Y)', fromStats: true, value: formatNumber(s.beta) },
        { label: '52W High', value: formatUSD(q.fiftyTwoWeekHigh) },
        { label: '52W Low', value: formatUSD(q.fiftyTwoWeekLow) },
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
      else if (tab === 'portfolio' && !positionFor(ticker)) startPositionEdit(ticker);
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

    // ── Portfolio: your position in a ticker (quantity × average cost) ──
    // Saved in config.portfolio — with the rest of the settings, so in the
    // profile when signed in, else this browser — keyed by symbol, so the
    // same holding shows in every watchlist that contains the ticker.
    const positionForms = reactive({}); // ticker → { quantity, avgCost, category, error } while editing

    // Only the additional (DB) watchlists get a Portfolio tab, not Default.
    // Switching to Default moves any open Portfolio tab back to the chart
    // (a pre-render watcher, so the hidden tab never flashes).
    watch(hasPortfolioTab, has => {
      if (has) return;
      for (const [ticker, d] of Object.entries(details)) {
        if (d.tab === 'portfolio') {
          d.tab = 'chart';
          if (d.open) loadActiveTab(ticker);
        }
      }
    });

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
      emit('set-position', { symbol: ticker, position });
      delete positionForms[ticker];
    }

    function removePosition(ticker) {
      if (!confirm(`Remove your ${ticker} position?`)) return;
      emit('set-position', { symbol: ticker, position: null });
      // Back to an empty form (the config prop hasn't re-rendered yet, so
      // startPositionEdit would still see the old position).
      positionForms[ticker] = { quantity: '', avgCost: '', category: '', error: null };
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

    // ── Cash balance (Portfolio page) — config.portfolioCash ──
    const cashBalance = computed(() => {
      const n = Number(props.config.portfolioCash);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    const cashForm = ref(null); // { amount, error } while editing
    function editCash() {
      cashForm.value = { amount: cashBalance.value ? String(cashBalance.value) : '', error: null };
    }
    function saveCash() {
      const raw = String(cashForm.value.amount).trim();
      const amount = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(amount) || amount < 0) {
        cashForm.value.error = 'Enter an amount of 0 or more.';
        return;
      }
      emit('set-cash', amount);
      cashForm.value = null;
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
      const cash = cashBalance.value;
      if (!rows.length && !cash) return null;
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
      return {
        count: rows.length, totalCost, value, gain, gainPct, dayGain, dayPct,
        cash, totalWithCash: value != null ? value + cash : null,
      };
    });

    // ── Allocation charts (Portfolio page), shown side by side ──
    // Slices wait for every price and category (and, by sector, every
    // stock's sector) so a chart never shows a partial picture.
    const categoryOrder = CATEGORIES.map(c => c.id);
    function allocationRows() {
      const rows = portfolioTickers.value.map(positionSummary).filter(Boolean);
      return rows.some(r => r.value == null || !r.category) ? null : rows;
    }
    function cashItems() {
      return cashBalance.value ? [{ key: 'cash', label: 'Cash', value: cashBalance.value, symbol: 'Cash' }] : [];
    }
    const allocationByType = computed(() => {
      const rows = allocationRows();
      if (!rows) return null;
      return assignSlots(buildSlices([
        ...rows.map(r => ({ key: r.category, label: r.categoryLabel, short: CATEGORY_SHORT[r.category], value: r.value, symbol: r.symbol })),
        ...cashItems(),
      ], categoryOrder));
    });
    const allocationBySector = computed(() => {
      const rows = allocationRows();
      if (!rows) return null;
      const cash = cashItems();

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
      return assignSlots(buildSlices([...items, ...cash], [...sectorKeys, 'sector:?', ...categoryOrder]));
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
      const tip = `52-week range ${formatUSD(lo)} – ${formatUSD(hi)} · price ${formatUSD(price)} (${Math.round(pctOfRange)}% of range)`
        + (avg != null ? ` · avg cost ${formatUSD(avg)}` : '');
      return {
        lo, hi, price, avg, tip,
        gain: avg != null ? price >= avg : null,
        loAt: at(lo), hiAt: at(hi), priceAt: at(price), avgAt: avg != null ? at(avg) : null,
      };
    }

    // Range-bar labels: exact under $10K, compact above ($57.7K) so a
    // bitcoin-sized price doesn't crowd the bar. Tooltips keep exact values.
    const compactPriceFmt = new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
    });
    function rangeLabel(v) {
      return Math.abs(v) >= 10000 ? compactPriceFmt.format(v) : formatUSD(v);
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
      isPortfolioList, hasPortfolioTab, portfolioTotals,
      CATEGORIES, CATEGORY_LABELS, autoCategoryFor, rangeFor, rangeLabel,
      notesStore, findNote, noteForms, noteKey, openNoteForm, closeNoteForm, saveNewNote, cashBalance, cashForm, editCash, saveCash,
      allocationByType, allocationBySector, hasNonStockHoldings, startPositionEdit, cancelPositionEdit, savePosition, removePosition,
      buildFilingUrl, buildIndexUrl, getTranscriptLinks,
      formatUSD, formatNumber, formatPct, formatVolume, formatDate, formatRelativeTime, changeClass,
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

      <!-- Portfolio list: totals across every position -->
      <div class="portfolio-totals" v-if="isPortfolioList && portfolioTotals">
        <div class="portfolio-stat">
          <span class="portfolio-label">Total cost</span>
          <span class="portfolio-value">{{ formatUSD(portfolioTotals.totalCost) }}</span>
        </div>
        <div class="portfolio-stat">
          <span class="portfolio-label">Market value</span>
          <span class="portfolio-value">{{ portfolioTotals.value != null ? formatUSD(portfolioTotals.value) : '—' }}</span>
        </div>
        <div class="portfolio-stat">
          <span class="portfolio-label">Total G/L</span>
          <span class="portfolio-value" :class="changeClass(portfolioTotals.gain)">
            {{ portfolioTotals.gain != null ? signedUSD(portfolioTotals.gain) + ' (' + formatPct(portfolioTotals.gainPct) + ')' : '—' }}
          </span>
        </div>
        <div class="portfolio-stat">
          <span class="portfolio-label">Today's G/L</span>
          <span class="portfolio-value" :class="changeClass(portfolioTotals.dayGain)">
            {{ portfolioTotals.dayGain != null ? signedUSD(portfolioTotals.dayGain) + (portfolioTotals.dayPct != null ? ' (' + formatPct(portfolioTotals.dayPct) + ')' : '') : '—' }}
          </span>
        </div>
        <div class="portfolio-stat">
          <span class="portfolio-label">
            Cash
            <button type="button" class="link-button" v-if="!cashForm" @click="editCash">Edit</button>
          </span>
          <span class="portfolio-value">{{ formatUSD(portfolioTotals.cash) }}</span>
        </div>
        <div class="portfolio-stat">
          <span class="portfolio-label">Total incl. cash</span>
          <span class="portfolio-value">{{ portfolioTotals.totalWithCash != null ? formatUSD(portfolioTotals.totalWithCash) : '—' }}</span>
        </div>
      </div>

      <form class="watchlist-form cash-form" v-if="isPortfolioList && cashForm" @submit.prevent="saveCash" novalidate>
        <input type="number" inputmode="decimal" min="0" step="any" placeholder="Cash balance ($)"
               aria-label="Cash balance in dollars" v-model="cashForm.amount" @keydown.esc="cashForm = null" />
        <button type="submit" class="primary">Save cash</button>
        <button type="button" @click="cashForm = null">Cancel</button>
        <div class="notice error watchlist-form-error" v-if="cashForm.error">{{ cashForm.error }}</div>
      </form>

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
          By current market value{{ cashBalance ? ', including cash' : '' }}.
          Asset types come from Yahoo Finance — change one on a stock's Portfolio tab (e.g. a bond fund → Bonds).
          <template v-if="hasNonStockHoldings || cashBalance">By sector groups stocks by their sector and other holdings by type (fund sector breakdowns aren't available).</template>
        </p>
      </div>

      <div class="notice" v-if="listsLoading && !tickers.length">Loading your watchlists…</div>
      <div class="notice" v-else-if="isPortfolioList && !tickers.length && !cashBalance">
        No positions yet. Open a stock in one of your watchlists and use its Portfolio tab to enter quantity and average cost.
      </div>
      <div class="notice" v-else-if="tickers.length === 0">
        This watchlist is empty — search above to add stocks.
      </div>

      <!-- Watchlist as accordions — expand a ticker to see its SEC filings; -->
      <!-- drag a card by its handle to reorder (saved to settings). -->
      <div ref="watchlistEl" class="watchlist" :class="{ 'is-dragging': draggingTicker }">
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
                  <span>{{ formatUSD(stockQuotes[sym]?.price) }}</span>
                </span>
                <span class="stock-row-num">
                  <span class="stock-row-label">Chg</span>
                  <span :class="changeClass(stockQuotes[sym]?.change)">{{ formatUSD(stockQuotes[sym]?.change) }}</span>
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
                    :title="stockQuotes[sym]?.previousClose != null ? 'Today · dashed line: previous close ' + formatUSD(stockQuotes[sym].previousClose) : null"></span>
              <span class="stock-row-sparkline" v-else></span>
            </div>
          </div>
          <button v-if="editMode" type="button" class="watchlist-remove"
                  :aria-label="'Remove ' + sym + ' from this watchlist'" :title="'Remove ' + sym"
                  @click.stop="removeTicker(sym)">✕</button>
          <span v-else class="chevron">▶</span>
        </div>

        <!-- Historical Chart + Documents (SEC filings) — same content that -->
        <!-- used to live on the standalone Documents tab, now nested here. -->
        <div class="accordion-body" v-if="details[sym]?.open">
          <div class="filing-tabs">
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'chart' }" @click.stop="setDetailTab(sym, 'chart')">Historical Chart</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'news' }" @click.stop="setDetailTab(sym, 'news')">News</button>
            <button class="filing-tab" :class="{ active: details[sym]?.tab === 'documents' }" @click.stop="setDetailTab(sym, 'documents')">Documents</button>
            <button class="filing-tab" v-if="hasPortfolioTab" :class="{ active: details[sym]?.tab === 'portfolio' }" @click.stop="setDetailTab(sym, 'portfolio')">Portfolio</button>
          </div>

          <!-- Historical Chart -->
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
                <HistoryChart :data="intraday[sym].series" intraday :baseline="intraday[sym].previousClose" />
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
              <HistoryChart :data="filteredChartData(sym)" />
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
            <form class="portfolio-form" v-if="positionForms[sym]" @submit.prevent="savePosition(sym)" novalidate>
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
                  <span>Average cost / share ($)</span>
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
              </div>
            </form>

            <template v-else-if="positionSummary(sym)">
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
                  <span class="portfolio-value">{{ formatUSD(positionSummary(sym).avgCost) }}</span>
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
              </div>
              <p class="text-muted text-sm portfolio-note">
                Value at {{ positionSummary(sym).price != null ? formatUSD(positionSummary(sym).price) : 'the latest price' }} (delayed quote).
              </p>
              <div class="portfolio-actions">
                <button type="button" @click="startPositionEdit(sym)">Edit position</button>
                <button type="button" class="danger" @click="removePosition(sym)">Remove</button>
              </div>
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

      <div class="notice text-sm" style="margin-top:12px" v-if="tickers.length">
        Quotes/sparklines and historical chart prices from Yahoo Finance (unofficial API), delayed 15–20 minutes.
        Ticker news from Yahoo Finance. SEC filings from SEC EDGAR (data.sec.gov), no API key required. Each tab loads the first time you open it. Use the search icon to add stocks and the ☰ menu to edit (remove stocks) and manage lists; drag a card by its ⠿ handle to reorder.
      </div>
    </div>
  `,
};
