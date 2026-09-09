# Oil & Gas Market Dashboard

A browser-only single-page app (SPA) for tracking oil prices, gas prices, O&G stocks, news, and SEC filings. No backend, no build step required.

## Quick Start

```bash
./run.sh
```

This starts both the static server and the local Yahoo Finance CORS relay
together, and always serves from this directory regardless of where you run
it from — safer than running `npx serve .` by hand, which serves the wrong
directory (and 404s on everything) if run one level too high, e.g. from the
repo root instead of here. On macOS you can also just double-click
`run.command`.

<details>
<summary>Manual / without run.sh</summary>

```bash
# Serve the directory (any static server works) — run from THIS directory
npx serve .

# Or with Python
python3 -m http.server 8080

# Also start the local Yahoo Finance CORS relay (needed for Oil Prices + Stocks tabs)
node local-proxy.js
```
</details>

Then open `http://localhost:3000` (or 8080) in your browser.

> **Note:** The app must be served over HTTP — not opened as `file://` — because ES module imports require a server origin.

> **Note:** `query1.finance.yahoo.com` doesn't send CORS headers, so browser
> requests to it always fail directly. `local-proxy.js` is a small,
> dependency-free Node relay (listens on port 8787) that fetches Yahoo
> Finance server-side instead of depending on a public CORS-bypass proxy
> (those are unreliable and are often blocked by corporate network
> filtering). Without it running, Oil Prices and Stocks will show
> "Unavailable".

## Features

| Tab | Description |
|---|---|
| **Oil Prices** | Brent (BZ=F), WTI (CL=F), Nat Gas (NG=F), Heating Oil (HO=F), RBOB Gasoline (RB=F). Spread calculator. |
| **Gas Prices** | EIA weekly retail gasoline by grade (Regular/Midgrade/Premium/Diesel) + 3-2-1 crack spread. Requires EIA API key. |
| **Stocks** | Configurable O&G stock watchlist with price, % change, volume, 30-day sparkline. |
| **News** | Aggregated RSS feeds from Reuters, EIA, OilPrice.com, Rigzone. Configurable feed list. |
| **Documents** | SEC EDGAR 10-K, 10-Q, 8-K, Proxy filings + earnings transcript links. Configurable company list. |
| **⚙ Settings** | All configuration: EIA key, tickers, RSS feeds, companies. Persisted to localStorage. Export/reset. |

## Configuration

All settings are stored in `localStorage` under the key `oilgas_config` and seeded from `config.json` on first load.

You can edit settings live in the **⚙ Settings** tab — no page reload required.

### EIA API Key (required for Gas Prices tab)

1. Register for free at [eia.gov/opendata](https://www.eia.gov/opendata/)
2. Copy your API key
3. Paste it in **⚙ Settings → EIA API Key**
4. Click **Save Changes**

The key is stored in your browser's localStorage. It is not sent anywhere except the EIA API itself.

## Data Sources

| Data | Source | Key Required |
|---|---|---|
| Oil futures prices | Yahoo Finance (unofficial) | No |
| Stock quotes + sparklines | Yahoo Finance (unofficial) | No |
| Retail gas & diesel prices | EIA Open Data API v2 | **Yes (free)** |
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
├── components/
│   ├── OilPrices.js    # Oil price indexes + spread
│   ├── GasPrices.js    # EIA gas prices + crack spread
│   ├── Stocks.js       # Stock watchlist + sparklines
│   ├── News.js         # RSS news aggregator
│   └── Documents.js    # SEC EDGAR document collector
├── services/
│   ├── yahooFinance.js # Yahoo Finance API calls
│   ├── eia.js          # EIA API calls
│   ├── rss.js          # RSS feed fetching + caching
│   └── edgar.js        # SEC EDGAR API + helpers
└── utils/
    ├── config.js       # localStorage config persistence
    ├── formatters.js   # Currency, percent, date formatters
    └── spread.js       # Spread + crack spread calculations
```

## Known Limitations

- **Yahoo Finance** is an unofficial API — it may break without notice.
- **rss2json.com** free tier is limited to 10 requests/hour per IP. Results are cached for 30 minutes.
- **Gas Prices tab** is disabled until an EIA API key is configured.
- Prices from Yahoo Finance may be delayed 15–20 minutes.
- SEC EDGAR is rate-limited to 10 requests/second; the app staggers requests automatically.
