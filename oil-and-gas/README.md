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

> **Note:** `query1.finance.yahoo.com` doesn't send CORS headers, so browser
> requests to it always fail directly. `server.js` relays those requests
> server-side (same origin, at `/proxy`) instead of depending on a public
> CORS-bypass proxy (those are unreliable and are often blocked by corporate
> network filtering). Without the server running, Oil Prices and Stocks will
> show "Unavailable".

## Features

| Tab | Description |
|---|---|
| **Oil Prices** | Brent (BZ=F), WTI (CL=F), Nat Gas (NG=F), Heating Oil (HO=F), RBOB Gasoline (RB=F). Spread calculator with a historical chart (1M–5Y) overlaying both indexes' actual prices, gap between them shaded green/red by which is on top. |
| **Gas Prices** | EIA weekly retail gasoline by grade (Regular/Midgrade/Premium/Diesel) + 3-2-1 crack spread. Requires EIA API key. |
| **Stocks** | Configurable O&G stock watchlist with price, % change, volume, 30-day sparkline. |
| **News** | Aggregated RSS feeds from Reuters, EIA, OilPrice.com, Rigzone. Configurable feed list. |
| **Documents** | SEC EDGAR 10-K, 10-Q, 8-K, Proxy filings + earnings transcript links. Configurable company list. |
| **⚙ Settings** | All configuration: EIA key, tickers, RSS feeds, companies. Persisted to localStorage. Import/Export/Reset. Behind an admin login; sections are collapsible. |

## Configuration

All settings are stored in `localStorage` under the key `oilgas_config` and seeded from `config.json` on first load.

You can edit settings live in the **⚙ Settings** tab — no page reload required. Each settings section can be
collapsed independently (click its header); they're all expanded by default.

### Admin login

The Settings tab is gated by a login screen, default **admin / admin**. Change the username/password under
**Settings → Admin Account** (requires the current password). Credentials are stored hashed in this browser's
localStorage, separately from the rest of the config — they're never included in Export/Import/Reset.

**This is a lightweight, client-side-only lock, not real access control.** The app has no backend or database:
the whole check runs in JS delivered to the browser, so anyone with DevTools access to the page can read the
stored hash, flip the session flag directly, or just edit localStorage — none of that requires the password.
It's meant to keep settings from being casually changed on a shared screen (e.g. a dashboard on an office TV),
not to protect data from a motivated user. Don't rely on it once this app is deployed somewhere public (see
[Deploying to Railway](#deploying-to-railway)) — anyone who bypasses the login has the same access as an admin.

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
├── server.js           # Static file server + same-origin CORS relay (single process/port)
├── package.json        # `npm start` → node server.js (used by Railway)
├── components/
│   ├── OilPrices.js    # Oil price indexes + spread
│   ├── GasPrices.js    # EIA gas prices + crack spread
│   ├── Stocks.js       # Stock watchlist + sparklines
│   ├── News.js         # RSS news aggregator
│   ├── Documents.js    # SEC EDGAR document collector
│   └── Login.js        # Admin login form (Settings gate)
├── services/
│   ├── yahooFinance.js # Yahoo Finance API calls
│   ├── eia.js          # EIA API calls
│   ├── rss.js          # RSS feed fetching + caching
│   └── edgar.js        # SEC EDGAR API + helpers
└── utils/
    ├── config.js       # localStorage config persistence
    ├── formatters.js   # Currency, percent, date formatters
    ├── spread.js       # Spread + crack spread calculations
    ├── auth.js         # Admin credential storage/verification (client-side only)
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
7. In the app's **⚙ Settings** tab, add your EIA API key (Gas Prices tab) — it's stored in the browser's localStorage, per visitor, not on the server.

If you'd rather deploy via CLI: `npm i -g @railway/cli`, then from the `oil-and-gas/` directory run `railway login`, `railway init`, `railway up`.

## Known Limitations

- **Yahoo Finance** is an unofficial API — it may break without notice.
- **rss2json.com** free tier is limited to 10 requests/hour per IP. Results are cached for 30 minutes.
- **Gas Prices tab** is disabled until an EIA API key is configured.
- Prices from Yahoo Finance may be delayed 15–20 minutes.
- SEC EDGAR is rate-limited to 10 requests/second; the app staggers requests automatically.
