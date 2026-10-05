# Oil & Gas Market Dashboard

A single-page app (SPA) for tracking oil prices, gas prices, O&G stocks, news, and SEC filings, with optional user accounts that save settings to a profile. No build step and no npm dependencies — one small Node server (Node ≥ 22.13).

## Quick Start

```bash
./run.sh
```

This runs `server.js`, a single dependency-free Node process that serves the
static app and relays the third-party APIs that don't send CORS headers
(needed for the Markets tab), and always serves from this
directory regardless of where you run it from. On macOS you can also just
double-click `run.command`.

To enable the retail gas prices section / Economic Indicators tab, copy
`.env.example` to `.env` and fill in your free API keys — `server.js` loads
it automatically, no install step needed:

```bash
cp .env.example .env
# edit .env with your EIA_API_KEY / FRED_API_KEY, then:
./run.sh
```

`.env` is gitignored; never commit real keys. Both tabs work fine without
it too — they just show a "not configured" notice instead.

<details>
<summary>Manual / without run.sh</summary>

```bash
node server.js
# or: PORT=8080 node server.js
```
`.env` is picked up the same way regardless of how you launch `server.js`.
</details>

Then open `http://localhost:3000` in your browser.

> **Note:** The app must be served over HTTP — not opened as `file://` — because ES module imports require a server origin.

> **Note:** `query1.finance.yahoo.com` and `api.stlouisfed.org` (FRED) don't
> send CORS headers, so browser requests to them always fail directly.
> `server.js` relays those requests server-side (same origin, at `/proxy`)
> instead of depending on a public CORS-bypass proxy (those are unreliable
> and are often blocked by corporate network filtering). Without the server
> running, Markets will show "Unavailable".

## Features

| Tab | Description |
|---|---|
| **Markets** | Four sub-tabs (the fourth, **Stocks**, is the row below). **Economic Indicators**: inflation (CPI YoY), unemployment, Fed funds rate, 2/10/30-Year Treasury yields, and the 10Y–2Y yield curve spread, via FRED. Historical chart (1M–5Y) per series; the yield curve option overlays the 10Y and 2Y lines directly with their crossing shaded, rather than just the spread value. Optional news cards (from feeds tagged in Settings) between the indicator cards and the chart, limited to a configurable recent-days window. Requires a FRED API key, set by whoever runs this deployment (see [FRED API Key](#fred-api-key-required-for-economic-indicators-tab) below) — not something a visitor enters. **Oil Price Indexes**: BZ=F, CL=F, NG=F, HO=F, RB=F with a spread calculator and historical spread chart. **Retail Gas Prices**: the 3-2-1 crack spread (live futures, no key needed) and EIA retail gasoline/diesel prices with their own historical chart. Retail prices require an EIA API key, set by whoever runs this deployment (see [EIA API Key](#eia-api-key-required-for-retail-gas-prices) below) — not something a visitor enters. |
| **Markets → Stocks** | Major market indexes (S&P 500, Dow, Nasdaq, Russell 2000, VIX) plus stock watchlists. **Search** by ticker or company name to add a stock; **Edit** shows a remove button on each card. The **Default** list is part of your settings (works signed out; also editable in Settings). Signed-in users can create more named watchlists (**+ New list**, Rename, Delete; up to 20 lists × 50 stocks), stored only in the server database — the `watchlists` table, via `/api/watchlists`. Each watchlist is a configurable O&G stock watchlist — price, today's change vs. the previous close, volume, and a sparkline of today's intraday prices (dashed line = previous close). Reorder the watchlist by dragging a card by its ⠿ handle (mouse or touch), or focus the handle and press ↑/↓; the new order is saved to settings (your profile when signed in). A **Top movers** card under the indexes shows today's 3 biggest gainers and losers (by % change) across the watchlists you toggle on in the card (Default and any of yours, in any combination; a stock in several counts once); click one to open its card. Expand a ticker for **Charts** (price history with 1D intraday and 1M–5Y range buttons), **News**, **Documents** (SEC EDGAR filings — 10-K, 10-Q, 8-K, Proxy — plus earnings transcript links), and **Portfolio** (on every list; signed in): **＋ Add purchase** (shares, price — prefilled with the last price — date, prefilled with today, and **Pay from**: a Cash holding such as a money-market fund, whose balance is reduced by the cost, or "Outside the portfolio"; the position's quantity and share-weighted average cost update, and purchases are listed in the tab, each deletable to reverse it), or enter quantity and average cost directly to see total cost, market value, and total/today's gain or loss ($ and %). Positions are saved with your settings, per ticker. A **Portfolio** tab (after News in the top bar, shown when you're signed in and hold at least one position or have a closed one) lists every stock you hold in a collapsible **Holdings** card whose header shows the totals across all positions — market value, total cost, total and today's G/L (visible even when collapsed). Only there, each holding's Portfolio tab also has **Sell**: shares (**All** fills your whole position), price (prefilled with the last price), date, and **Deposit to** a Cash holding (its balance grows by the proceeds) or "Outside the portfolio". A partial sale keeps the average cost and books a realized G/L of (sale price − average cost) × shares, shown on the tab and in the Transactions list (buys and sells; deleting a sale puts the shares back and reverses the deposit). Selling everything moves the stock to a collapsible **Closed positions** card under Holdings: per position the shares sold, average cost, average sale price, cost basis, proceeds and realized G/L ($ and %), opened → closed dates; header totals for cost basis, proceeds and realized G/L, all at average cost. **Undo close** reverses the final sale (only while the stock isn't held again); **Delete** just removes the record. Closed positions are saved with your settings (`closedPositions`). Under the allocation charts, a **Top movers** card ranks your holdings. An **Allocation** donut groups holdings by market value either **by asset type** (Stocks, Funds, Bonds, Cash, Crypto, Commodities, Other — automatic from Yahoo's instrument type, changeable per position on its Portfolio tab) or **by sector** (stocks by their Yahoo sector; other holdings by type, since fund sector breakdowns need Yahoo authentication this app doesn't use). |
| **News** | Aggregated RSS feeds — EIA Today in Energy, OilPrice.com, Rigzone, FRED Blog. Filterable by source/freshness/text search; configurable feed list. Articles open in a popup viewer inside the dashboard by default (or a new tab — **Settings → News RSS Feeds → Open articles in**). Sites that forbid being framed (e.g. Reuters, CNBC, Rigzone) are detected by the server (`/api/frame-check`), and the popup offers "Open in new tab" instead of a broken frame. Cmd/Ctrl-click always opens a new tab. |
| **Account menu → ⚙ Settings** | Tickers, RSS feeds, thresholds, and more — saved to your account profile when signed in, otherwise to this browser's localStorage. Import/Export/Reset. Sections are collapsible. EIA/FRED API keys are *not* here — they're fixed per-deployment configuration (below). |
| **Stock alerts** (signed in) | Each stock card has a **🔔 Alerts** tab (just the bell on phones) to create, edit, pause/re-arm and delete alerts, with **Quick add** presets (Above +5%, Below −5%, Up/Down 3% today, +20% gain / −10% loss on a held position, 52-wk high, Volume 2×). Types: **price** above/below a $ value or a % from the current price; **daily move** up/down/either ±X% vs. the previous close; **position** gain/loss ±X% vs. your Portfolio average cost; **52-week high/low** (at it, or within X%); **volume** ≥ N× the 3-month average. Each fires **once** or **every day** (at most once per trading day) and can carry a note. There's no background job: the server evaluates all of your alerts — fetching its own quotes for every alerted stock — each time the dashboard refreshes quotes, and also immediately when you save one. Triggered alerts land in **Inbox → Alerts** (and the Inbox badge). **＋ New alert** in Inbox → Alerts creates the same alert for many stocks at once: add whole groups (Default, each of your watchlists, Portfolio holdings), type tickers, and ✕ any you want to leave out — one alert per stock (up to 50 at a time); % price targets use each stock's own current price, and gain/loss alerts skip stocks you don't hold. Stored in the `alerts` / `alert_events` tables via `/api/alerts`; up to 200 alerts. |
| **Inbox** (signed in) | Sub-tabs **Notes · Alerts · Messages**. The Inbox tab shows a badge with unread alerts + messages, and opens on unread alerts, then unread messages, otherwise Notes (alerts come from your stock alerts; messages arrive with the upcoming group feature). **Notes** — save stock news for later: on a stock's **News** tab, **Save to notes** opens a form to pick existing labels or type new ones and add a note; the article is filed under that stock (the item then shows **✓ In Notes**, which opens Inbox → Notes). **＋ New note** on Inbox → Notes writes a manual note: labels, any stocks (up to 10), an optional link, and text. Notes lists everything newest first — filter by stock, label or text, edit or delete notes, delete labels (removed from every note). Stored only in the server database (`notes`, `note_symbols`, `note_labels`, `note_label_links` tables, via `/api/notes`; an older single-stock notes table is migrated automatically on startup); up to 2,000 notes, 100 labels, 10 labels per note. |
| **On a phone** | Swipe left/right on the Markets content to change sub-tab; drag a finger along any chart to read values; long-press a watchlist card (or use its ⠿ handle) to reorder. **Add to Home Screen** (Safari share menu on iPhone, Chrome menu on Android) installs it as a full-screen app with its own icon — on Android that needs the site served over HTTPS (e.g. the Railway deployment); over plain http on your LAN, Chrome adds a regular browser shortcut instead. |
| **Theme switch** (header, ☀ ☾ ◐; inside the account menu on phones) | Light, Dark, or System (follows the OS light/dark setting, live). Saved with the rest of the settings — to the profile when signed in — and applied before first paint, so there's no flash of the wrong theme on reload. |
| **Profile page** (signed in) | Side navigation (a tab row on phones): **Profile** — display name, password, sign out; **Labels** — the labels used in Inbox → Notes, with how many notes use each. **＋ New label** / **Edit** open a dialog with a live preview: name, description, and color (the color button cycles through common colors; or type any hex code). Edits carry to every note; Delete removes the label from its notes. Colors show on note chips and as dots in the label filters and note form. **Manage labels** next to the label filters in Inbox → Notes jumps here. |
| **Account menu** (header, right) | Opens Profile / Sign in, Settings and Sign out; shows your initials when signed in. Optional user accounts: register and sign in with email + password. A signed-in user's dashboard settings are stored in their profile in the server database, so they follow them to any browser/device. The profile page edits the display name, changes the password (signing out other devices), and signs out. |

## Configuration

Settings are seeded from `config.json` on first load and stored in one of two places:

- **Signed out:** this browser's `localStorage`, under the key `oilgas_config`.
- **Signed in:** the user's profile in the server's SQLite database (see [User Accounts](#user-accounts)).
  When an account is created, whatever settings the browser was already using are copied into the new
  profile, so nothing set up anonymously is lost. Signing out switches back to the browser's own settings.

You can edit settings live in the **⚙ Settings** tab — no page reload required. Each settings section can be
collapsed independently (click its header); they're all expanded by default.

### EIA API Key (required for retail gas prices)

This is **fixed, per-deployment configuration** — set once by whoever runs the app, not something a visitor
types into Settings (the Settings tab has no field for it at all).

1. Register for free at [eia.gov/opendata](https://www.eia.gov/opendata/)
2. Copy your API key
3. Set it as the **`EIA_API_KEY`** environment variable when running the server — locally, the easiest way is
   a `.env` file (copy `.env.example` to `.env`, fill it in, run `./run.sh` as usual); a one-off shell var
   also works:
   ```bash
   EIA_API_KEY=your-key-here ./run.sh
   ```
   On Railway, add it under the service's **Variables** tab instead (see [Deploying to Railway](#deploying-to-railway)) — `.env` files aren't deployed there.

`server.js` injects it into the `config.json` it serves to the browser — it's never written to the `config.json`
file on disk or committed to git, and a visitor can't change or export it from Settings.

### FRED API Key (required for Economic Indicators tab)

Same model as the EIA key above — fixed per-deployment configuration, not a Settings field.

1. Register for free at [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)
2. Copy your API key
3. Set it as the **`FRED_API_KEY`** environment variable — same `.env` file as above, or:
   ```bash
   FRED_API_KEY=your-key-here ./run.sh
   ```
   On Railway, add it under the service's **Variables** tab.

Both keys go in the same `.env` file (see `.env.example`), or can be set together inline:
`EIA_API_KEY=xxx FRED_API_KEY=yyy ./run.sh`.

## User Accounts

Accounts, sessions, and profiles live in a SQLite database using Node's built-in `node:sqlite` (Node ≥ 22.13) —
still no `npm install`. The file defaults to `data/app.db` (gitignored, never served over HTTP); set
**`DATABASE_PATH`** to put it elsewhere.

- Passwords are hashed with scrypt (`node:crypto`); minimum 8 characters.
- Sessions are an HttpOnly, `SameSite=Lax` cookie (`Secure` when served over HTTPS) valid for 30 days. Only
  a SHA-256 of the session token is stored, so a copy of the database can't be used to hijack sessions.
- Changing the password signs out every other device.
- Sign-in/registration is rate-limited to 20 attempts per IP per 15 minutes (in memory, per process).
- API keys (`EIA_API_KEY`/`FRED_API_KEY`) are never stored in a profile — they stay per-deployment.

API (same origin, JSON): `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me`, `GET`/`PUT /api/profile` (`{ displayName?, settings? }`), `PUT /api/profile/password`.

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
- **Plain CSS** with CSS variables — dark and light palettes, switched via `<html data-theme>`
- No external UI libraries, no bundler

## Project Structure

```
oil-and-gas/
├── index.html          # Entry point
├── config.json         # Default configuration seed
├── app.js              # Root Vue app + Settings panel
├── styles.css          # Styles + dark/light theme palettes
├── server.js           # Static file server + same-origin CORS relay + /api (single process/port)
├── server/
│   ├── auth.js         # /api routes: register, login/logout, profile, password change
│   ├── frameCheck.js   # /api/frame-check: can an article URL be shown in an iframe?
│   └── db.js           # SQLite (node:sqlite) schema + queries: users, profiles, sessions
├── data/               # SQLite database file (created on first run; gitignored)
├── package.json        # `npm start` → node server.js (used by Railway)
├── .env.example        # Template for local API keys — copy to .env (gitignored)
├── components/
│   ├── EconomicIndicators.js  # FRED macro indicators + historical chart
│   ├── OilGasMarkets.js  # Oil indexes + spread, crack spread, EIA retail gas prices
│   ├── Stocks.js       # Market indexes + stock watchlist + sparklines + per-ticker SEC filings
│   ├── News.js         # RSS news aggregator
│   ├── Account.js      # Sign in / register / profile page
│   ├── ArticleViewer.js # Popup viewer for news articles (sandboxed iframe)
│   ├── HistoryChart.js # Shared single-series historical line chart (SVG)
│   └── DualLineChart.js # Shared two-series overlay chart w/ crossing-shaded fill (SVG)
├── services/
│   ├── yahooFinance.js # Yahoo Finance API calls
│   ├── eia.js          # EIA API calls
│   ├── fred.js         # FRED (economic data) API calls
│   ├── rss.js          # RSS feed fetching + caching
│   ├── auth.js         # Client for the /api account + profile routes
│   └── edgar.js        # SEC EDGAR API + helpers
└── utils/
    ├── config.js       # Config persistence (user profile when signed in, else localStorage)
    ├── articleViewer.js # Popup-vs-new-tab article opening + safe link helper
    ├── theme.js        # Light/dark/system theme preference → <html data-theme>
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
7. **Persist user accounts:** Railway's container filesystem is wiped on every deploy, so add a **Volume**
   to the service (e.g. mounted at `/data`) and set **`DATABASE_PATH=/data/app.db`** under **Variables**.
   Without this, accounts and saved profiles are lost on each redeploy.
8. Set **EIA_API_KEY** / **FRED_API_KEY** under the service's **Variables** tab to enable retail gas prices / the Economic Indicators tab for everyone visiting this deployment — see [EIA API Key](#eia-api-key-required-for-retail-gas-prices) / [FRED API Key](#fred-api-key-required-for-economic-indicators-tab) above. These are fixed for the whole deployment, not something each visitor sets.

If you'd rather deploy via CLI: `npm i -g @railway/cli`, then from the `oil-and-gas/` directory run `railway login`, `railway init`, `railway up`.

## Known Limitations

- **Yahoo Finance** is an unofficial API — it may break without notice.
- **rss2json.com** free tier is limited to 10 requests/hour per IP. Results are cached for 30 minutes.
- **Retail gas prices** (in Markets) are hidden until an EIA API key is configured.
- Prices from Yahoo Finance may be delayed 15–20 minutes.
- SEC EDGAR is rate-limited to 10 requests/second; the app staggers requests automatically.
