# Oil & Gas Market Dashboard — Plan

## Top-Level Overview

Build a single-page web application (SPA) that runs entirely in the browser (no backend) providing five feature areas: oil price indexes with spread calculator, US national gas prices with crack spread, O&G stock watchlist, news aggregator, and a document collector for SEC filings/earnings. All data comes from free/public APIs. The tech stack is **Vue 3 via CDN** (no build step required) with plain CSS. Configuration (tickers, RSS feeds, companies) is stored in `localStorage` and seeded from a bundled `config.json`.

**Project root:** `/Users/marceloborges/Products/tiger-team-org/Bob/oil-and-gas`

**EIA API key:** Entered at runtime via the Settings UI. EIA-dependent features (Gas Prices tab, Crack Spread) must render a clear prompt — "Enter your free EIA API key in Settings to enable this feature" — and be otherwise disabled until a key is present. The key is stored in config/localStorage like all other config fields.

---

## Recommended Tech Stack

**Vue 3 (CDN, no build step)**

Rationale:
- Vanilla JS + HTML becomes unmanageable across 5 feature areas with reactive data (prices updating, tab switching, config editing).
- Vue 3 CDN (`unpkg.com/vue@3/dist/vue.esm-browser.js`) requires zero tooling — open `index.html` in a browser or serve with `npx serve`.
- Vue's reactivity system handles live price polling, spread recalculation, and conditional rendering cleanly.
- Lighter than React/Vite for a no-build project; no JSX, no transpilation.
- Single `index.html` entry point with ES module `<script type="module">` blocks — fully self-contained.

**No build step.** The entire app ships as static files.

---

## File / Directory Structure

```
oil-gas-dashboard/
├── index.html                  # Shell: loads Vue CDN, mounts app
├── config.json                 # Default config (tickers, feeds, companies)
├── app.js                      # Root Vue app: tab state, config load/save
├── styles.css                  # Global styles, CSS variables, dark theme
│
├── components/
│   ├── OilPrices.js            # Feature 1: oil indexes + spread calculator
│   ├── GasPrices.js            # Feature 2: EIA gas prices + crack spread
│   ├── Stocks.js               # Feature 3: stock watchlist
│   ├── News.js                 # Feature 4: RSS news aggregator
│   └── Documents.js            # Feature 5: SEC filings + earnings links
│
├── services/
│   ├── yahooFinance.js         # Fetch quotes/chart data from Yahoo Finance
│   ├── eia.js                  # Fetch EIA gas price series
│   ├── rss.js                  # Fetch + parse RSS via CORS proxy
│   └── edgar.js                # Fetch SEC EDGAR submissions + search
│
└── utils/
    ├── config.js               # Load/save config from localStorage
    ├── formatters.js           # Currency, percent, date formatters
    └── spread.js               # Crack spread + index spread calculations
```

---

## Data Sources & Exact API Endpoints

### 1. Oil Price Indexes (Yahoo Finance unofficial)

No API key required. No official rate limit documented; unofficial — treat as best-effort.

**Quote endpoint** (current price + change):
```
GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
  ?interval=1d&range=5d
```
Response: `chart.result[0].meta.regularMarketPrice`, `.previousClose`

**Symbols to use:**
| Index | Symbol |
|---|---|
| Brent Crude | `BZ=F` |
| WTI Crude | `CL=F` |
| Natural Gas | `NG=F` |
| Heating Oil (ULSD proxy) | `HO=F` |
| RBOB Gasoline | `RB=F` |
| Mars Blend (no free source) | N/A — show note |

**CORS:** Yahoo Finance CORS headers allow browser requests from `localhost` and file:// in practice. If blocked, fallback to allorigins proxy:
```
GET https://api.allorigins.win/raw?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FCL%3DF%3Finterval%3D1d%26range%3D5d
```

**Spread calculation:** `spread = priceA - priceB` (both in USD/barrel). Brent and WTI futures are already in USD/bbl.

---

### 2. US National Gas Prices — EIA API

**Requires free API key** from https://www.eia.gov/opendata/ (instant registration, no credit card).

Base URL: `https://api.eia.gov/v2/`

**Retail gasoline prices by grade:**
```
GET https://api.eia.gov/v2/petroleum/pri/gnd/data/
  ?api_key={EIA_KEY}
  &frequency=weekly
  &data[]=value
  &facets[product][]=EPM0       # All grades, all formulations
  &facets[product][]=EPMR       # Regular
  &facets[product][]=EPMM       # Midgrade
  &facets[product][]=EPMP       # Premium
  &facets[duoarea][]=NUS        # National average
  &sort[0][column]=period
  &sort[0][direction]=desc
  &length=12
```

**Retail diesel (ULSD):**
```
GET https://api.eia.gov/v2/petroleum/pri/gnd/data/
  ?api_key={EIA_KEY}
  &facets[product][]=EPD2D      # No. 2 diesel, all areas
  &facets[duoarea][]=NUS
  &sort[0][column]=period&sort[0][direction]=desc&length=12
```

**CORS:** EIA API returns `Access-Control-Allow-Origin: *` — no proxy needed.

**Crack Spread (3-2-1 formula):**
```
3-2-1 crack spread = (2 × gasoline_price + 1 × diesel_price - 3 × crude_price) / 3
```
- Gasoline/diesel from EIA (USD/gallon) → convert to USD/barrel × 42
- Crude from Yahoo Finance `CL=F` or `BZ=F`

---

### 3. Stock Watchlist — Yahoo Finance

Same endpoint as oil prices, just different symbols (e.g., `XOM`, `CVX`, `COP`, `SLB`, `HAL`).

**Batch quote (up to ~10 symbols):**
```
GET https://query1.finance.yahoo.com/v7/finance/quote
  ?symbols=XOM,CVX,COP,SLB,HAL
  &fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,shortName
```
Response: `quoteResponse.result[]`

**Sparkline/chart (per symbol, last 30 days):**
```
GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
  ?interval=1d&range=1mo
```
Response: `chart.result[0].indicators.quote[0].close[]` — use as sparkline data points.

**CORS:** Same as above — works from localhost; use allorigins proxy as fallback.

---

### 4. RSS News Aggregator

**RSS → JSON proxy options:**

Option A — rss2json.com (recommended, cleaner response):
```
GET https://api.rss2json.com/v1/api.json
  ?rss_url={encoded_feed_url}
  &api_key=         # blank = free tier, 10 req/hour per IP
  &count=20
```
Response: `{ items: [{ title, link, pubDate, description, enclosure }] }`

Option B — allorigins.win (no rate limit stated, but raw XML):
```
GET https://api.allorigins.win/raw?url={encoded_feed_url}
```
Returns raw RSS XML → parse with browser `DOMParser` + `getElementsByTagName('item')`.

**Default feed list (seeded in config.json):**
| Source | URL |
|---|---|
| Reuters Energy | `https://feeds.reuters.com/reuters/businessNews` |
| EIA News | `https://www.eia.gov/rss/news.xml` |
| OilPrice.com | `https://oilprice.com/rss/main` |
| Rigzone | `https://www.rigzone.com/news/rss/rigzone_latest.aspx` |
| Platts (S&P) | `https://www.spglobal.com/commodityinsights/en/rss-feed/oil` |

**CORS:** All RSS endpoints block direct browser fetch — proxy is mandatory.

**Rate limit gotcha:** rss2json free tier = 10 requests/hour/IP without key. With 5 feeds that means the news tab can only refresh ~2× per hour. Stagger requests and cache results in memory.

---

### 5. Document Collector — SEC EDGAR

All EDGAR APIs are free, no key required, CORS-open.

**Step A — Resolve CIK from ticker:**
```
GET https://efts.sec.gov/LATEST/search-index?q=%22{ticker}%22&dateRange=custom&startdt=2020-01-01&forms=10-K
```
Or use the static CIK lookup file:
```
GET https://www.sec.gov/files/company_tickers.json
```
Response: `{ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc" }, ... }`
→ Build a ticker→CIK map client-side on first load, cache in memory.

**Step B — Get filings list:**
```
GET https://data.sec.gov/submissions/{paddedCIK}.json
  # paddedCIK = CIK zero-padded to 10 digits, e.g. CIK0000101778.json
```
Response: `submissions.filings.recent` — arrays of `form[]`, `filingDate[]`, `accessionNumber[]`, `primaryDocument[]`

Filter `form` for:
- `10-K` — annual report
- `10-Q` — quarterly report
- `8-K` — current report (earnings calls often filed here)
- `DEF 14A` — proxy statement

**Step C — Build filing link:**
```
https://www.sec.gov/Archives/edgar/data/{cik}/{accessionNumber_no_dashes}/{primaryDocument}
```

**Step D — Earnings transcript fallback links (no free API):**
Generate search URL templates:
- Seeking Alpha: `https://seekingalpha.com/symbol/{ticker}/earnings/transcripts`
- Motley Fool: `https://www.fool.com/earnings-call-transcripts/?ticker={ticker}`
- SEC 8-K search: `https://efts.sec.gov/LATEST/search-index?q=%22earnings+call%22&entity={ticker}&forms=8-K`

**CORS:** `data.sec.gov` and `efts.sec.gov` return `Access-Control-Allow-Origin: *` — no proxy needed.
**Rate limit:** SEC EDGAR enforces a **10 requests/second** limit per IP. Add a 150ms minimum delay between requests.

---

## Component / View Breakdown

### Root App (`app.js`)
- Owns: `activeTab` (string), `config` (object loaded from localStorage)
- On mount: load config, inject EIA key from config
- Renders: `<TabBar>` + active component

### TabBar (inline in index.html)
- Tabs: Oil Prices | Gas Prices | Stocks | News | Documents | ⚙ Settings

### OilPrices.js
- State: `prices{}` (symbol → { price, change, pctChange }), `spreadA`, `spreadB`, `spreadValue`
- On mount: fetch all 5 symbols via `yahooFinance.js`; poll every 60s
- UI: price cards grid + spread selector (two dropdowns) + computed spread display
- Data flow: `yahooFinance.fetchQuote(symbol)` → reactive `prices` map

### GasPrices.js
- State: `gasSeries[]` (weekly EIA data, last 12 weeks), `crackSpread`
- On mount: fetch EIA regular/premium/diesel national average; fetch WTI/Brent from Yahoo
- UI: table of grades + line chart (SVG or Chart.js CDN) + crack spread card
- Data flow: `eia.fetchGasPrices(apiKey)` + `yahooFinance.fetchQuote('CL=F')` → `spread.calcCrackSpread()`

### Stocks.js
- State: `quotes[]`, `sparklines{}`
- On mount: batch fetch quotes for configured tickers; fetch sparklines per ticker
- UI: watchlist table (ticker, name, price, Δ%, volume) + mini sparkline SVG per row
- Config interaction: "+ Add Ticker" input → saves to config → re-fetches

### News.js
- State: `articles[]` (merged + sorted by date), `loading`, `feedErrors{}`
- On mount: fetch all configured RSS feeds via rss proxy, merge, dedupe by link, sort by pubDate
- UI: article list with source badge, title link, date, snippet
- Config interaction: feed URL list editable in Settings tab

### Documents.js
- State: `companies[]` each with `{ ticker, name, cik, filings[], transcriptLinks[] }`
- On mount: load company_tickers.json once; for each configured company: fetch submissions
- UI: accordion per company → tabs for 10-K / 10-Q / 8-K / Transcripts → filing rows with date + link
- Data flow: `edgar.resolveCIK(ticker)` → `edgar.fetchFilings(cik)` → render links

### Settings (inline panel or modal)
- Edit: EIA API key, ticker list, RSS feed URLs, company list
- Save → `config.js.save(config)` → triggers re-fetch in relevant components

---

## Config Schema (`config.json` / localStorage key: `oilgas_config`)

```json
{
  "eiaApiKey": "",
  "stocks": {
    "tickers": ["XOM", "CVX", "COP", "SLB", "HAL", "PSX", "VLO", "MPC", "OXY", "EOG"]
  },
  "oilIndexes": {
    "symbols": ["BZ=F", "CL=F", "NG=F", "HO=F", "RB=F"],
    "defaultSpreadA": "BZ=F",
    "defaultSpreadB": "CL=F"
  },
  "news": {
    "feeds": [
      { "name": "Reuters Energy", "url": "https://feeds.reuters.com/reuters/businessNews" },
      { "name": "EIA News", "url": "https://www.eia.gov/rss/news.xml" },
      { "name": "OilPrice.com", "url": "https://oilprice.com/rss/main" },
      { "name": "Rigzone", "url": "https://www.rigzone.com/news/rss/rigzone_latest.aspx" }
    ],
    "rssProxy": "rss2json"
  },
  "documents": {
    "companies": [
      { "ticker": "XOM", "name": "ExxonMobil" },
      { "ticker": "CVX", "name": "Chevron" },
      { "ticker": "COP", "name": "ConocoPhillips" },
      { "ticker": "SLB", "name": "SLB (Schlumberger)" },
      { "ticker": "OXY", "name": "Occidental Petroleum" }
    ]
  },
  "ui": {
    "theme": "dark",
    "refreshIntervalSeconds": 60
  }
}
```

---

## CORS & Rate-Limit Gotchas

| Service | CORS | Rate Limit | Mitigation |
|---|---|---|---|
| Yahoo Finance (query1) | Usually open from localhost; may block non-localhost origins | Undocumented; ~2000 req/day practical limit | allorigins.win proxy as fallback; cache results 60s |
| EIA API | `*` open | 5000 req/day per key | Cache weekly data in sessionStorage; only refetch on tab activate |
| rss2json.com | `*` open | 10 req/hour (free, no key) | Cache feed results in memory 30min; stagger requests 500ms apart |
| allorigins.win | `*` open | No stated limit; shared infra | Use as fallback only; do not hammer |
| SEC EDGAR data.sec.gov | `*` open | 10 req/sec | 150ms delay between company fetches; cache submissions in sessionStorage |
| SEC company_tickers.json | `*` open | Same as above | Load once, cache entire map in memory for session |

**Additional gotchas:**
- Yahoo Finance `v7/finance/quote` with multiple symbols works well but may silently drop symbols that have been delisted. Always check `result` array length vs requested symbols.
- EIA API key must be embedded in the client URL. This is expected per EIA's model — it's a free, public-use key, not a secret. Warn the user in Settings that the key is visible in browser DevTools.
- rss2json.com may return 200 with `status: "error"` in the JSON body if the feed URL is unreachable or returns non-RSS content. Always check `response.status === "ok"`.
- SEC EDGAR `submissions/{CIK}.json` only includes the most recent ~1000 filings inline. Older filings are paginated via `filings.files[]` — for most O&G companies the recent set will cover 5+ years of 10-Ks, so this is not an issue in practice.
- `company_tickers.json` uses CIK as an integer without leading zeros. The submissions API URL requires zero-padding to 10 digits: `CIK${String(cik).padStart(10, '0')}.json`.

---

## Phased Build Order

### Phase 1 — Shell & Config
- `index.html` with tab navigation, Vue 3 CDN mount
- `styles.css` — layout, dark theme, CSS variables
- `utils/config.js` — load/save from localStorage with config.json default
- Settings panel — edit EIA key, tickers, feeds, companies
- **Goal:** App shell runs; config persists across reloads.

### Phase 2 — Oil Prices (Feature 1)
- `services/yahooFinance.js` — fetchQuote, fetchChart
- `utils/spread.js` — simple spread calculation
- `components/OilPrices.js` — price cards + spread selector
- **Goal:** Brent, WTI, NG futures display live; spread computes correctly.

### Phase 3 — Stock Watchlist (Feature 3)
- `components/Stocks.js` — reuses yahooFinance service
- Batch quote fetch + sparkline SVG renderer
- **Goal:** Watchlist shows configured tickers with price/change/sparkline.

### Phase 4 — US Gas Prices + Crack Spread (Feature 2)
- `services/eia.js` — fetch retail gas series
- Extend `utils/spread.js` — 3-2-1 crack spread formula
- `components/GasPrices.js` — table + crack spread card
- **Goal:** EIA weekly gas prices display; crack spread calculates using live crude.

### Phase 5 — News Aggregator (Feature 4)
- `services/rss.js` — fetch via rss2json + allorigins fallback; parse; merge
- `components/News.js` — article list with source badges
- **Goal:** All configured feeds load and display merged, sorted news.

### Phase 6 — Document Collector (Feature 5)
- `services/edgar.js` — resolveCIK, fetchFilings, buildFilingUrl
- `components/Documents.js` — accordion per company, filing tables, transcript links
- **Goal:** For each configured company, 10-K/10-Q/8-K links render with filing dates.

### Phase 7 — Polish
- Auto-refresh timer (configurable interval from config)
- Loading skeletons / error states per component
- Responsive layout (mobile-friendly grid)
- Export/share config as JSON download

---

## Sub-Tasks

### Sub-Task 1 — Shell, Config & Settings
**Intent:** Create the app shell and config infrastructure that all other features depend on.
**Expected Outcomes:** `index.html` opens in browser; tabs switch; config loads from localStorage; Settings panel reads/writes all config fields.
**Todo List:**
1. Create `index.html` with Vue 3 CDN import, tab bar, and component mount points
2. Create `styles.css` with dark theme, CSS variables, grid layout
3. Create `config.json` with full default config as specified above
4. Create `utils/config.js` with `loadConfig()` and `saveConfig()` using localStorage + config.json default
5. Create `app.js` root Vue app with `activeTab` state and config injection
6. Create Settings panel component (inline in app.js or separate) editing all config fields
**Status:** [x] done

---

### Sub-Task 2 — Yahoo Finance Service + Oil Price Indexes
**Intent:** Implement the Yahoo Finance data service and the Oil Prices tab.
**Expected Outcomes:** Price cards for BZ=F, CL=F, NG=F, HO=F, RB=F display current prices; spread selector computes Brent-WTI spread.
**Todo List:**
1. Create `services/yahooFinance.js` — `fetchQuote(symbol)` and `fetchChart(symbol, interval, range)` using fetch + allorigins fallback
2. Create `utils/spread.js` — `calcSpread(priceA, priceB)` returning value and percentage
3. Create `components/OilPrices.js` — price cards grid, two-dropdown spread selector, spread result card, 60s auto-refresh
**Status:** [x] done

---

### Sub-Task 3 — Stock Watchlist
**Intent:** Reuse Yahoo Finance service to show a configurable O&G stock watchlist with sparklines.
**Expected Outcomes:** All configured tickers show price, % change, volume, company name, and a 30-day SVG sparkline. Adding/removing tickers via Settings reflects immediately.
**Todo List:**
1. Extend `services/yahooFinance.js` with `fetchBatchQuotes(tickers[])` using v7 batch endpoint
2. Create `components/Stocks.js` — watchlist table, SVG sparkline renderer (pure JS, no chart lib), ticker add/remove UI
**Status:** [x] done

---

### Sub-Task 4 — EIA Gas Prices + Crack Spread
**Intent:** Fetch EIA weekly retail gas prices and compute the 3-2-1 crack spread.
**Expected Outcomes:** Table shows national average regular/midgrade/premium/diesel prices for last 12 weeks; crack spread card shows computed value using live WTI price.
**Todo List:**
1. Create `services/eia.js` — `fetchGasPrices(apiKey)` and `fetchDieselPrices(apiKey)` using EIA v2 API
2. Extend `utils/spread.js` — `calcCrackSpread(gasPriceUSDgal, dieselPriceUSDgal, crudePriceUSDbbl)` implementing 3-2-1 formula with unit conversion
3. Create `components/GasPrices.js` — price history table, crack spread result card, EIA key missing warning if key not set
**Status:** [x] done

---

### Sub-Task 5 — RSS News Aggregator
**Intent:** Fetch and merge multiple RSS feeds via a CORS proxy and display an aggregated news feed.
**Expected Outcomes:** Articles from all configured feeds display merged by date; each has source label, title (link), date, snippet. Feed errors show per-feed badges.
**Todo List:**
1. Create `services/rss.js` — `fetchFeed(url)` via rss2json primary + allorigins/DOMParser fallback; `mergeFeeds(feedResults[])` sorts by date, dedupes by link
2. Create `components/News.js` — article list, source badge, loading states, per-feed error display, 30-min cache
**Status:** [x] done

---

### Sub-Task 6 — SEC Document Collector
**Intent:** For each configured company, fetch SEC EDGAR filings and surface 10-K, 10-Q, 8-K links plus transcript search links.
**Expected Outcomes:** Accordion per company; each expands to show filing type tabs; filing rows have date + direct SEC link; transcript tab links to Seeking Alpha and SEC 8-K search.
**Todo List:**
1. Create `services/edgar.js` — `loadCIKMap()` fetches company_tickers.json and caches; `resolveCIK(ticker)` looks up; `fetchFilings(cik)` fetches submissions; `buildFilingUrl(cik, accessionNumber, primaryDoc)`; `getTranscriptLinks(ticker)`
2. Create `components/Documents.js` — company accordion, filing-type tab switcher, filing rows, transcript links section, 150ms request stagger, sessionStorage cache
**Status:** [x] done

---

### Sub-Task 7 — Polish & Auto-Refresh
**Intent:** Add cross-cutting concerns: auto-refresh timer, loading skeletons, error boundaries, responsive layout.
**Expected Outcomes:** App auto-refreshes on configured interval; loading states are visible while fetching; layout is usable on tablet/mobile; config can be exported as JSON.
**Todo List:**
1. Implement global refresh timer in `app.js` using `setInterval` + configurable interval from config; emit `refresh` event or toggle reactive flag that components watch
2. Add loading skeleton CSS + per-component loading/error state rendering
3. Audit and fix CSS grid for mobile breakpoints (max-width: 768px)
4. Add "Export Config" button in Settings that triggers JSON download via Blob URL
**Status:** [x] done
