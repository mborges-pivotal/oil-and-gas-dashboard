# Oil & Gas Market Dashboard

A browser-only single-page app (SPA) for tracking oil prices, gas prices, O&G stocks, news, and SEC filings. No backend, no build step required.

## Quick Start

```bash
./run.sh
```

This runs `server.js`, a single dependency-free Node process that serves the
static app and relays the third-party APIs that don't send CORS headers
(needed for Oil Prices + Stocks tabs), and always serves from this directory
regardless of where you run it from. On macOS you can also just double-click
`run.command`.

<details>
<summary>Manual / without run.sh</summary>

```bash
node server.js
# or: PORT=8080 node server.js
```
</details>

Then open `http://localhost:3000` in your browser.

> **Note:** The app must be served over HTTP — not opened as `file://` — because ES module imports require a server origin.

> **Note:** `query1.finance.yahoo.com` and `api.stlouisfed.org` (FRED) don't
> send CORS headers, so browser requests to them always fail directly.
> `server.js` relays those requests server-side (same origin, at `/proxy`)
> instead of depending on a public CORS-bypass proxy (those are unreliable
> and are often blocked by corporate network filtering). Without the server
> running, Oil Prices, Stocks, and Economic Indicators will show "Unavailable".

## Features

| Tab | Description |
|---|---|
| **Economic Indicators** | Inflation (CPI YoY), unemployment, Fed funds rate, 2/10/30-Year Treasury yields, and the 10Y–2Y yield curve spread, via FRED. Historical chart (1M–5Y) per series; the yield curve option overlays the 10Y and 2Y lines directly with their crossing shaded, rather than just the spread value. Optional news cards (from feeds tagged in Settings) between the indicator cards and the chart, limited to a configurable recent-days window. Requires a FRED API key, set by whoever runs this deployment (see [FRED API Key](#fred-api-key-required-for-economic-indicators-tab) below) — not something a visitor enters. |
| **Oil Prices** | Brent (BZ=F), WTI (CL=F), Nat Gas (NG=F), Heating Oil (HO=F), RBOB Gasoline (RB=F). Spread calculator with a historical chart (1M–5Y) overlaying both indexes' actual prices, gap between them shaded green/red by which is on top. |
| **Gas Prices** | EIA weekly retail gasoline by grade (Regular/Midgrade/Premium/Diesel) + 3-2-1 crack spread. Requires an EIA API key, set by whoever runs this deployment (see [EIA API Key](#eia-api-key-required-for-gas-prices-tab) below) — not something a visitor enters. |
| **Stocks** | Major market indexes (S&P 500, Dow, Nasdaq, Russell 2000, VIX) plus a configurable O&G stock watchlist with price, % change, volume, 30-day sparkline. |
| **News** | Aggregated RSS feeds — EIA Today in Energy, OilPrice.com, Rigzone, FRED Blog. Filterable by source/freshness/text search; configurable feed list. |
| **Documents** | SEC EDGAR 10-K, 10-Q, 8-K, Proxy filings + earnings transcript links. Configurable company list. |
| **⚙ Settings** | Tickers, RSS feeds, companies, thresholds, and more — persisted to localStorage. Import/Export/Reset. Sections are collapsible. EIA/FRED API keys are *not* here — they're fixed per-deployment configuration (below). |

## Configuration

All settings are stored in `localStorage` under the key `oilgas_config` and seeded from `config.json` on first load.

You can edit settings live in the **⚙ Settings** tab — no page reload required. Each settings section can be
collapsed independently (click its header); they're all expanded by default.

### EIA API Key (required for Gas Prices tab)

This is **fixed, per-deployment configuration** — set once by whoever runs the app, not something a visitor
types into Settings (the Settings tab has no field for it at all).

1. Register for free at [eia.gov/opendata](https://www.eia.gov/opendata/)
2. Copy your API key
3. Set it as the **`EIA_API_KEY`** environment variable when running the server:
   ```bash
   EIA_API_KEY=your-key-here ./run.sh
   ```
   On Railway, add it under the service's **Variables** tab instead (see [Deploying to Railway](#deploying-to-railway)).

`server.js` injects it into the `config.json` it serves to the browser — it's never written to the `config.json`
file on disk or committed to git, and a visitor can't change or export it from Settings.

### FRED API Key (required for Economic Indicators tab)

Same model as the EIA key above — fixed per-deployment configuration, not a Settings field.

1. Register for free at [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)
2. Copy your API key
3. Set it as the **`FRED_API_KEY`** environment variable when running the server:
   ```bash
   FRED_API_KEY=your-key-here ./run.sh
   ```
   On Railway, add it under the service's **Variables** tab.

Both keys can be set together, e.g. `EIA_API_KEY=xxx FRED_API_KEY=yyy ./run.sh`.

## Data Sources

| Data | Source | Key Required |
|---|---|---|
| Oil futures prices | Yahoo Finance (unofficial) | No |
| Stock quotes + sparklines | Yahoo Finance (unofficial) | No |
| Retail gas & diesel prices | EIA Open Data API v2 | **Yes (free)** |
| Inflation, unemployment, Fed funds rate, Treasury yields | FRED (Federal Reserve Bank of St. Louis) | **Yes (free)** |
| News feeds | rss2json.com proxy + allorigins.win fallback | No |
| SEC filings (10-K, 10-Q, 8-K) | SEC EDGAR (data.sec.gov) | No |

## Tech Stack

- **Vue 3** via CDN (no build step)
- **Plain CSS** with CSS variables (dark theme)
- No external UI libraries, no bundler

## Project Structure

```
oil-and-gas/
├── index.html          # Entry point
├── config.json         # Default configuration seed
├── app.js              # Root Vue app + Settings panel
├── styles.css          # Dark theme CSS
├── server.js           # Static file server + same-origin CORS relay (single process/port)
├── package.json        # `npm start` → node server.js (used by Railway)
├── components/
│   ├── EconomicIndicators.js  # FRED macro indicators + historical chart
│   ├── OilPrices.js    # Oil price indexes + spread
│   ├── GasPrices.js    # EIA gas prices + crack spread
│   ├── Stocks.js       # Market indexes + stock watchlist + sparklines
│   ├── News.js         # RSS news aggregator
│   ├── Documents.js    # SEC EDGAR document collector
│   ├── HistoryChart.js # Shared single-series historical line chart (SVG)
│   └── DualLineChart.js # Shared two-series overlay chart w/ crossing-shaded fill (SVG)
├── services/
│   ├── yahooFinance.js # Yahoo Finance API calls
│   ├── eia.js          # EIA API calls
│   ├── fred.js         # FRED (economic data) API calls
│   ├── rss.js          # RSS feed fetching + caching
│   └── edgar.js        # SEC EDGAR API + helpers
└── utils/
    ├── config.js       # localStorage config persistence
    ├── formatters.js   # Currency, percent, date formatters
    ├── spread.js       # Spread + crack spread calculations
    └── dateRange.js    # Shared range-picker options for historical charts
```

## Deploying to Railway

The repo root is one level above this app (`oil-and-gas/`), so Railway needs
to be told to build from this subdirectory.

1. Push this repo to GitHub (or use `railway up` from the CLI for a direct deploy without a repo).
2. In the [Railway dashboard](https://railway.app), **New Project → Deploy from GitHub repo**, and pick this repo.
3. Open the new service's **Settings** tab:
   - **Root Directory** → `oil-and-gas`
   - Leave **Build/Start Command** on auto-detect — Railway's Nixpacks builder finds `package.json`'s `start` script (`node server.js`) automatically.
4. Railway injects `PORT` itself; `server.js` reads `process.env.PORT`, so no config is needed there.
5. Deploy, then open the generated `*.up.railway.app` domain. Everything (SPA + `/proxy` relay) is served from that single domain/port.
6. Optional: set an env var **SEC_CONTACT** (e.g. `YourApp you@example.com`) — SEC EDGAR requires a real identifying User-Agent on automated requests or it starts 403'ing.
7. Set **EIA_API_KEY** / **FRED_API_KEY** under the service's **Variables** tab to enable the Gas Prices / Economic Indicators tabs for everyone visiting this deployment — see [EIA API Key](#eia-api-key-required-for-gas-prices-tab) / [FRED API Key](#fred-api-key-required-for-economic-indicators-tab) above. These are fixed for the whole deployment, not something each visitor sets.

If you'd rather deploy via CLI: `npm i -g @railway/cli`, then from the `oil-and-gas/` directory run `railway login`, `railway init`, `railway up`.

## Known Limitations

- **Yahoo Finance** is an unofficial API — it may break without notice.
- **rss2json.com** free tier is limited to 10 requests/hour per IP. Results are cached for 30 minutes.
- **Gas Prices tab** is disabled until an EIA API key is configured.
- Prices from Yahoo Finance may be delayed 15–20 minutes.
- SEC EDGAR is rate-limited to 10 requests/second; the app staggers requests automatically.
