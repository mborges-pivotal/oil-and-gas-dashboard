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

To enable the retail gas prices (Markets → Energy) / Markets → Economy, copy
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
| **Markets** | Three sub-tabs: **Markets** first (the indexes, with the news under them; it opens by default), then the two described here. **Economy**: inflation (CPI YoY), unemployment, Fed funds rate, 2/10/30-Year Treasury yields, and the 10Y–2Y yield curve spread, via FRED. Historical chart (1M–5Y) per series; the yield curve option overlays the 10Y and 2Y lines directly with their crossing shaded, rather than just the spread value. Optional news cards (from feeds tagged in Settings) between the indicator cards and the chart, limited to a configurable recent-days window. Requires a FRED API key, set by whoever runs this deployment (see [FRED API Key](#fred-api-key-required-for-the-economy-tab) below) — not something a visitor enters. **Energy** has two tabs (the last one used is remembered): **Oil Price Indexes**: BZ=F, CL=F, NG=F, HO=F, RB=F with a spread calculator and historical spread chart. **Retail Gas Prices**: the 3-2-1 crack spread (live futures, no key needed) and EIA retail gasoline/diesel prices with their own historical chart. Retail prices require an EIA API key, set by whoever runs this deployment (see [EIA API Key](#eia-api-key-required-for-retail-gas-prices) below) — not something a visitor enters. |
| **Home: Markets** | Markets is the home page — the app opens on it, and the logo (icon and name, top left) brings you back to it (the Markets indexes) from anywhere. Under the top bar, a **subheader** on every page, frozen while you scroll and aligned with the logo: **My Account** (Account when signed in, otherwise the sign-in page) then Markets' sections — Markets · Economy · Energy — then **Leaderboard** (🏆 on phones); on the right, Markets' last-updated time (on narrower screens it sits just below) and the **theme button** — one icon that cycles **System ◐ → Dark ☾ → Light ☀**. The top bar has the logo on the left and **Inbox** (signed in) and the profile picture on the right. |
| **Markets → Markets** | The major market indexes (S&P 500, Dow, Nasdaq, Russell 2000, VIX), refreshed every refresh interval. |
| **My Account → Watchlist** (signed in; between Summary and Portfolios) | Stock watchlists. **Search** by ticker or company name to add a stock; **Edit** shows a remove button on each card; signed in, it also adds **⇄** (copy or move that stock to another list — Default or yours — or to a **＋ New list**) and checkboxes with a bar for several at once (**Copy to**, **Move to**, **Remove**, select all). Copied/moved stocks go to the end of the destination; a list that already has them is marked "✓ already" (a move then just removes them here), and a full list (50) is disabled. Each change shows a message with **Undo** (which puts moved stocks back in their old places, and deletes a list it just created). Notes, alerts and positions belong to the stock, so they're unaffected. On phones the picker opens as a bottom sheet. The **Default** list is part of your settings (works signed out; also editable in Settings). Signed-in users can create more named watchlists (**+ New list**, Rename, Delete; up to 20 lists × 50 stocks), stored only in the server database — the `watchlists` table, via `/api/watchlists`. Each watchlist is a configurable O&G stock watchlist — price, today's change vs. the previous close, volume, and a sparkline of today's intraday prices (dashed line = previous close). Reorder the watchlist by dragging a card by its ⠿ handle (mouse or touch), or focus the handle and press ↑/↓; the new order is saved to settings (your profile when signed in). A **Top movers** card above the list shows today's 3 biggest gainers and losers (by % change) across the watchlists you toggle on in the card (Default and any of yours, in any combination; a stock in several counts once); click one to open its card. A stock with earnings within 7 days shows an **Earnings in Nd** badge on its card (dashed when the date is estimated; hover for details). Expand a ticker for **Summary** (opens first: a brief company description — the opening of its English Wikipedia article, found through Wikidata's ticker data, so funds and some foreign listings have none — plus sector/industry from Yahoo and official name, SEC industry, headquarters and fiscal year end from SEC EDGAR, cached in the browser for 30 days; then **Upcoming events**, soonest first — the next **earnings** date (Nasdaq / Zacks, via the server's `GET /api/events/earnings`, cached 6 hours; marked Confirmed once the company has announced it, otherwise Estimated; with before-open/after-close and consensus vs. year-ago EPS), the next **ex-dividend** date and amount *estimated* from the stock's past dividends (regular monthly/quarterly/semiannual/annual payers only; none if overdue), and **expirations of your option contracts** on that stock; then a **Performance** table for 5 and 10 trading days, 1/3/6 months, YTD and 1/2/5/10 years: price change, total return with dividends reinvested (Yahoo's adjusted close), the S&P 500's price change and the difference in percentage points — hover a row for its start date), **Charts** (price history with 1D intraday and 1M–5Y range buttons), **News**, **Documents** (SEC EDGAR filings — 10-K, 10-Q, 8-K, Proxy — plus earnings transcript links), and **Portfolio** (on every list; signed in): **＋ Add purchase** (shares, price — prefilled with the last price — date, prefilled with today, and **Pay from**: a Cash holding such as a money-market fund, whose balance is reduced by the cost, or "Outside the portfolio"; the position's quantity and share-weighted average cost update, and purchases are listed in the tab, each deletable to reverse it), or enter quantity and average cost directly to see total cost, market value, and total/today's gain or loss ($ and %). Positions are saved with your settings, per ticker. **Multiple portfolios** (signed in): positions, option contracts, closed positions and cash all belong to a portfolio (e.g. Main, IRA, Trading), saved with your settings in `portfolios`. Each portfolio has a name and an **ID** derived from it and **unique across all accounts** ("Retirement IRA" → `retirement-ira`, then `retirement-ira-2`, …; lowercase letters, digits and hyphens). IDs come from the server (`/api/portfolios/id`, the `portfolio_ids` table): ＋ New portfolio shows the ID as you type the name (editable — checked as you type, with a suggestion when taken); a portfolio created from a purchase or a move gets one from its name. Renaming keeps the ID; deleting frees it. Every settings save, and the server at startup, makes sure each ID is valid and unique (older `pf_…` IDs are replaced, with transfers updated) and the app adopts any ID that changed — a settings file from before this feature is moved into one portfolio named **Main** automatically. On a stock's **Portfolio** tab (My Account → Watchlist), a **Portfolio** field picks which portfolio the tab works in (✓ marks the ones holding that stock; it starts on one that does, else the last one used) or **＋ New portfolio…** with a name — created when you save the purchase. Cash to pay from / deposit to comes from that same portfolio's cash holdings, or **Account cash** (paying defaults to the first one with money in it; it can also secure puts in any portfolio). The account's cash is saved with your settings in `accountCash`. **My Account** (first in the subheader, shown when you're signed in) has four sub-tabs — Summary · Watchlist · Portfolios · Transactions (the last one used is remembered): **Summary** — an **Account** card like the portfolio cards (total value of every portfolio plus the account's cash, **1D %** and **All-time %**, and the holdings + options + cash breakdown) with the account's **Cash** at the bottom (balance, cash reserved for cash-secured puts, and **＋ Deposit** from one of your connected bank accounts: amount, date, from — no balance or bank check yet; deposits are listed and deletable, which takes the money back out), then a tabbed card for all portfolios combined — **Performance** (the all-time gain chart, every portfolio together), **Holdings** (the stacked bar and top-10 list; the account's cash is a holding here), **By sector** and **By asset type** (donuts; the account's cash counts as Cash), each of the last three in **%** or **$** (on phones the tabs read Performance · Holdings · Sectors · Types); **Portfolios** — a card per portfolio with its name, **Position** (total value), **1D %** and **All-time %** (gain over the money invested; cash counts in the value but not that base), plus **＋ New portfolio**; clicking a card opens it: Rename / Delete, an overview card with three tabs (the tab and %/$ choice are remembered) — **Holdings**: the top holdings as one horizontal 100% stacked bar (the 6 largest by value, the rest as Other; hover a segment for its value) with a ranked top-10 list, **Sectors**: the by-sector donut as on the Summary, each switchable between **%** and **$** — and **Performance**: an **All-time gain** chart (gain vs. cost of the stocks and funds held at each point, rebuilt from your trades and Yahoo's daily closes; **1D · 1W · 1M · YTD · 1Y · All-Time**; 1D uses today's 5-minute prices; the range you pick is remembered — Summary and Portfolios each keep their own; positions entered as totals count as held throughout; cash and options aren't charted), then Top movers, Holdings, Options and Closed positions for that portfolio. In an opened portfolio, a holding's Portfolio tab has **Move…**: pick another portfolio (or ＋ New) and the shares (All, or part). Moving all of it takes its trades along (merging into a position already there: quantities add, the average is share-weighted, trades combine); moving part records *Moved to* / *Moved from* trades at the average cost, and the source keeps its average. Nothing is sold — no realized G/L, no cash moves. **Move the options on XOM too** brings its option contracts (a put secured by a cash holding the target doesn't have stays behind, and shares covering calls can only move with those calls). Each move shows **Undo** for a few seconds and is logged as a **Transfer** in Transactions (filterable; listed under either portfolio), saved in `transfers`; (The **Leaderboard** — the subheader's last tab, after Energy, open to everyone, signed in or not:) public portfolios from every account ranked by return for **Today · 1W · 1M · 3M · YTD · 1Y · All-Time** (computed on the server, `GET /api/leaderboard?period=`, cached 5 minutes): rank, movement since the previous trading day's standings (▲ green / ▼ red / NEW), the portfolio's picture (its initials when it has none), the portfolio name, the owner's display name and the return; your rows are highlighted. Returns cover stocks and funds (cash and options left out), adjusted for money added or taken out (Modified Dietz); All-Time is the gain over cost of what's held. Click a portfolio for its **profile** (also opened by a forwarded `#portfolio=<id>` link, signed in or not): its picture, name, @id, owner, followers and All-Time return, **＋ Follow** (signing in first if needed) and **↗ Forward**, then **Performance** (the all-time gain chart, 1D–All-Time), **Holdings** (each holding's weight) and **Sectors** (the donut) — **percentages only**, no $ toggle — and **Top movers** among its holdings today. The server (`GET /api/portfolios/:id/profile`, public portfolios only) sends its holdings and trades scaled to a cost of 100, so no amounts or share counts ever leave it; option contracts and closed positions aren't included. Never shared: amounts, share counts, options or emails. A portfolio is **Private** (default) or **Public** — chosen when you create it or with **Edit** (name and visibility; the ID stays); cards show 🔒/🌐. A **picture** can be added when creating the portfolio (optional; uploaded once its ID is claimed) and changed with **Edit**: **Choose from library** (phones) / **Upload image** (desktop) or **Take photo** (the rear camera on a phone, the webcam on desktop — a live view on https/localhost, the phone's camera app elsewhere); it's cropped square and shrunk in the browser, stored in the database against the portfolio's ID (only its owner can set it; deleting the portfolio deletes it) and shown on the portfolio's card and header — its initials until one is set. **Transactions** — every recorded trade in every portfolio (filter to one; each row names its portfolio), newest first and grouped by month: stock buys and sells, option buy/sell to open, buy/sell to close and expirations, from open and closed positions alike (closed ones are tagged), each with its cash flow (− paid, + received, and the cash holding it came from or went to) and realized G/L; filter by All / Stocks / Options or by ticker, contract or type, with the matching trades' net cash flow and realized G/L on top. Transactions is read-only (trades are added or deleted on the position) and positions entered as a total have no trades to list. The Positions tab lists every stock you hold in a collapsible **Holdings** card whose header shows the totals across all positions — market value, total cost, total and today's G/L (visible even when collapsed). Only there, each holding's Portfolio tab also has **Sell**: shares (**All** fills your whole position), price (prefilled with the last price), date, and **Deposit to** a Cash holding (its balance grows by the proceeds) or "Outside the portfolio". A partial sale keeps the average cost and books a realized G/L of (sale price − average cost) × shares, shown on the tab and in the Transactions list (buys and sells; deleting a sale puts the shares back and reverses the deposit). Selling everything moves the stock to a collapsible **Closed positions** card under Holdings: per position the shares sold, average cost, average sale price, cost basis, proceeds and realized G/L ($ and %), opened → closed dates; header totals for cost basis, proceeds and realized G/L, all at average cost. **Undo close** reverses the final sale (only while the stock isn't held again); **Delete** just removes the record. Closed positions are saved with your settings (`closedPositions`). **Options** (signed in): each stock's Portfolio tab has an **Options on …** section. **＋ Add option**: Buy or Sell (to open), Call or Put, expiration (prefilled with the next monthly, third-Friday expiration) and strike (prefilled near the price); the app builds the contract's OCC symbol and checks it exists by fetching its quote ("✗ No such contract" otherwise — Yahoo's option chains need authentication, so there's no strike picker). Contracts, premium per share (prefilled with the last price), date, and **Pay from** (buying) / **Deposit to** (selling) a cash holding. Each contract shows Long/Short, ITM/ATM/OTM, days left (amber within 7 days, red once expired), contracts, average premium, last, value (× 100; a short option counts as a negative value — a liability), G/L, breakeven and the last trade time. Each Holdings row shows its **weight**: the share of the Holdings' total market value (bar, %, and its value; options excluded — they have their own card), once every holding has a price. **Sorting** (Portfolio → Positions): a **Sort** row on Holdings (Added, Stock, Last, Chg, Chg %, Vol, Weight, G/L, G/L %) and on Options (Expiration — grouped by date, the default — Stock, Strike, Contracts, Last, Value, G/L, G/L %; any sort but Expiration shows one flat list). Click a column to sort by it, again to reverse; numbers start largest-first, names A→Z, missing values always last; each card remembers its sort. On the Portfolio page, a collapsible **Options** card (between Holdings and Closed positions, open/closed state remembered) lists every open contract grouped by expiration date (nearest first; amber within 7 days, red once expired), each with the same actions plus **Open XOM** to jump to the stock; its header shows net value (shorts negative), net premium paid/received, G/L, today's G/L and reserved cash, and **＋ Add option** takes a ticker to start a contract on any stock. Holdings lists only stocks, funds and cash, with their own totals; a **Net value** line above them adds the two (holdings ± options). Long options form an **Options** slice in the allocation charts; a line under the charts sums what short options leave out (their value, reserved cash, shares covering calls). **Close** (Portfolio page; sell to close a long, buy to close a short) records realized G/L and moves cash; closing every contract moves it to **Closed positions** (Undo close / Delete). An expired contract offers **Record expiry** — closes at 0, or at its intrinsic value if it's in the money (exercise/assignment isn't tracked yet). **Trades** lists the contract's trades (each deletable, reversing its cash). Each contract has its own **🔔 alerts**: premium target, daily premium move, position gain/loss vs. the average premium (a short gains as the premium falls), **days to expiration**, and **goes in / out of the money** (checked against the stock's price) — with quick presets, managed there or in Profile → Alerts. **Covered** (selling to open, checked by default): a **covered call** reserves 100 of your shares per contract (shows how many it covers and what you'd receive if called away; blocked if there aren't enough uncovered shares); a **cash-secured put** reserves strike × 100 × contracts of a Cash holding you pick (shows the obligation if assigned, the premium, the net cost and the cash left available; blocked if there isn't enough available cash). Unchecked, it's marked **Naked** with a margin warning. Reservations move no money and are released when the contract is closed, expires or is deleted: reserved cash can't pay for purchases (Pay from shows *available* cash), shares covering calls can't be sold or edited away, and the cash holding's Portfolio tab and Holdings row show reserved vs. available — **Reserved cash** is in the Options card header. Covered contracts get an **Assignment risk** alert preset. Saved with your settings (`optionPositions`, keyed by OCC symbol). Under the allocation charts, a **Top movers** card ranks your holdings. An **Allocation** donut groups holdings by market value either **by asset type** (Stocks, Funds, Bonds, Cash, Crypto, Commodities, Other — automatic from Yahoo's instrument type, changeable per position on its Portfolio tab) or **by sector** (stocks by their Yahoo sector; other holdings by type, since fund sector breakdowns need Yahoo authentication this app doesn't use). |
| **Markets → News** (on the Markets tab, under the Major Market Indexes) | Aggregated RSS feeds — EIA Today in Energy, OilPrice.com, Rigzone, FRED Blog. Filterable by source/freshness/text search; configurable feed list. The feeds are fetched once per visit — the first time Markets is shown — and kept while you move between tabs; **↻ Refresh** fetches them again (so does changing the feed list in Settings). Articles open in a popup viewer inside the dashboard by default (or a new tab — **Settings → News RSS Feeds → Open articles in**). Sites that forbid being framed (e.g. Reuters, CNBC, Rigzone) are detected by the server (`/api/frame-check`), and the popup offers "Open in new tab" instead of a broken frame. Cmd/Ctrl-click always opens a new tab. |
| **Profile → ⚙ Dashboard** (signed in; also **⚙ Dashboard settings** in the profile menu) | The dashboard's settings: auto-refresh interval, the Yahoo Finance relay, crack-spread strength thresholds, and the news RSS feeds (add, pause, remove, show on Economy; RSS proxy; open articles in a popup or a new tab; Economy news-card window). **Save changes** stores them in your profile. Sections are collapsible. The watchlist is edited on My Account → Watchlist and the theme with the ◐ button, not here. EIA/FRED API keys are *not* here — they're fixed per-deployment configuration (below). |
| **Stock alerts** (signed in) | Each stock card has a **🔔 Alerts** tab (just the bell on phones) to create, edit, pause/re-arm and delete alerts, with **Quick add** presets (Above +5%, Below −5%, Up/Down 3% today, +20% gain / −10% loss on a held position, 52-wk high, Volume 2×). Types: **price** above/below a $ value or a % from the current price; **daily move** up/down/either ±X% vs. the previous close; **position** gain/loss ±X% vs. your Portfolio average cost; **52-week high/low** (at it, or within X%); **volume** ≥ N× the 3-month average; **earnings coming up** — the next earnings report is N or fewer days away (Quick add: Earnings in 7d). Each fires **once** or **every day** (at most once per trading day) and can carry a note. There's no background job: the server evaluates all of your alerts — fetching its own quotes for every alerted stock — each time the dashboard refreshes quotes, and also immediately when you save one. Triggered alerts land in **Inbox → Alerts** (and the Inbox badge). Each can be **✓ Acknowledged** (or **Acknowledge all**) — that also marks it read and moves it to a collapsible **Acknowledged** group under the list (collapsed at first, open state remembered; newest acknowledgement first), where **Un-acknowledge** moves it back. Saved in `alert_events.acked_at` (added automatically on startup) via `POST /api/alerts/events/ack`. **＋ New alert** in Inbox → Alerts creates the same alert for many stocks at once: add whole groups (Default, each of your watchlists, Portfolio holdings), type tickers, and ✕ any you want to leave out — one alert per stock (up to 50 at a time); % price targets use each stock's own current price, and gain/loss alerts skip stocks you don't hold. Stored in the `alerts` / `alert_events` tables via `/api/alerts`; up to 200 alerts. |
| **Inbox** (signed in; top right, next to the profile picture) | Sub-tabs **Notes · Alerts · Activity**. The Inbox shows a badge with unread alerts + new activity, and opens on unread alerts, then new activity, otherwise Notes (alerts come from your stock alerts; activity is portfolio updates — see **Portfolio updates** below). **Notes** — save stock news for later: on a stock's **News** tab, **Save to notes** opens a form to pick existing labels or type new ones and add a note; the article is filed under that stock (the item then shows **✓ In Notes**, which opens Inbox → Notes). **＋ New note** on Inbox → Notes writes a manual note: labels, any stocks (up to 10), an optional link, and text. Notes lists everything newest first — filter by stock, label or text, **Edit** or **Archive** a note; archived notes move to a collapsible **Archived** group under the active ones (collapsed at first, open state remembered; the same filters apply), where each can be **Restored** or **Deleted** for good — only archived notes can be deleted. Labels are managed (and deleted) in Profile → Labels. Stored only in the server database (`notes`, `note_symbols`, `note_labels`, `note_label_links` tables, via `/api/notes`; an older single-stock notes table — and, later, the `archived_at` column — are migrated automatically on startup); up to 2,000 notes, 100 labels, 10 labels per note. |
| **Portfolio updates** (signed in) | Share what you bought and sold, and follow other people's public portfolios. **Share update** (Account → Transactions, or Inbox → Activity): tick stock buys and sells from one portfolio (the first one ticked locks the portfolio; up to 20) and add an optional message (up to 500 characters) → **Post**. Only the **action and ticker** are shared — never quantities, prices or amounts. An update has a header with BUY/SELL and the tickers on the first line, then the portfolio's highlighted **@id**, its name and owner, then the message. **Inbox → Activity** has two feeds: **You** — your own updates (from a private portfolio, only you see them, marked 🔒) and others' likes and replies on them; **Following** — updates from the public portfolios you follow, **posted after you followed** (if a portfolio goes private, its updates disappear for followers). Followers and the author can **♥ like** and **💬 reply** (up to 2,000 characters); anyone can read the replies. The author can **Delete** an update (with its likes and replies) and any reply on it; you can delete your own replies. **↗ Forward** copies a link (`#post=<id>` / `#portfolio=<id>`) to paste wherever you like — nothing is ever sent to other users, so the app can't be used to spam them. Opening a link (signed in; kept until you sign in) shows that update on top of Inbox → Activity — read-only with **＋ Follow** unless you follow it — or, for a portfolio, opens its public profile on the Leaderboard (no sign-in needed). **Discover** (Account → Portfolios, below your portfolio cards): public portfolios from every account, best All-Time return first, searchable by name, @id or owner — each with its picture, owner, All-Time return (as on the Leaderboard), follower count, **＋ Follow / ✓ Following** and **↗ Forward**. **Badges**: the Activity sub-tab and the You / Following chips count what's new since you last opened each feed (likes and replies on your updates; new updates from portfolios you follow), refreshed with the quotes; they're in the Inbox tab's badge too. At most 20 updates a day per account. Stored in the database (`posts`, `post_likes`, `post_replies`, `portfolio_follows`, `feed_reads`; deleting a portfolio deletes its updates and follows). |
| **On a phone** | Swipe left/right on the Markets content to change sub-tab; drag a finger along any chart to read values; long-press a watchlist card (or use its ⠿ handle) to reorder. **Add to Home Screen** (Safari share menu on iPhone, Chrome menu on Android) installs it as a full-screen app with its own icon — on Android that needs the site served over HTTPS (e.g. the Railway deployment); over plain http on your LAN, Chrome adds a regular browser shortcut instead. |
| **Theme button** (right end of the subheader; one icon — click to cycle System ◐ → Dark ☾ → Light ☀) | Light, Dark, or System (follows the OS light/dark setting, live). Saved with the rest of the settings — to the profile when signed in — and applied before first paint, so there's no flash of the wrong theme on reload. |
| **Profile page** (signed in) | Side navigation (a tab row on phones): **Profile** — your **avatar** (every account starts with a random one — an emoji on a colored circle; **Choose avatar** picks another emoji and color or a random one, **Upload photo** takes any picture, **Take photo** uses the device camera — a live view on https/localhost, the phone's camera app elsewhere; pictures are cropped square and shrunk to 256 px in the browser, stored in the database and served by an unguessable link to signed-in users; **Remove photo** goes back to the emoji; shown in the top bar, the profile menu and on the Leaderboard), display name, password, sign out; **Labels** — the labels used in Inbox → Notes, with how many notes use each. **＋ New label** / **Edit** open a dialog with a live preview: name, description, and color (the color button cycles through common colors; or type any hex code). Edits carry to every note; Delete removes the label from its notes. Colors show on note chips and as dots in the label filters and note form. **Manage labels** next to **＋ New note** in Inbox → Notes jumps here. **Bank accounts** — external accounts to deposit from: bank, account number (only the last 4 digits are stored), type (checking, savings, investments) and status (connected / not connected — your own setting; nothing is verified yet, and only connected accounts can be deposited from); add, edit, connect/disconnect, remove. Stored in the `bank_accounts` table via `/api/bank-accounts`. **Alerts** — every stock alert you've created, grouped by stock, filterable by status (All / Active / Paused or triggered) and by ticker or note text; each has **Edit** (the same form as a stock's 🔔 tab — saving re-arms a triggered one-time alert), **Pause / Resume / Re-arm** and **Delete**. **＋ New alert** opens the multi-stock composer (groups, tickers, exclusions). **Manage alerts** in Inbox → Alerts jumps here. |
| **Account menu** (header, right) | Opens Profile / Sign in, Dashboard settings and Sign out; the button is your profile picture when signed in. Optional user accounts: register and sign in with email + password. A signed-in user's dashboard settings are stored in their profile in the server database, so they follow them to any browser/device. The profile page edits the display name, changes the password (signing out other devices), and signs out. |

## Configuration

Settings are seeded from `config.json` on first load (the Default watchlist starts empty) and stored in one of two places:

- **Signed out:** this browser's `localStorage`, under the key `oilgas_config`.
- **Signed in:** the user's profile in the server's SQLite database (see [User Accounts](#user-accounts)).
  When an account is created, whatever settings the browser was already using are copied into the new
  profile, so nothing set up anonymously is lost. Signing out switches back to the browser's own settings.

Signed in, you edit them in **Profile → ⚙ Dashboard** — no page reload required. Each section can be
collapsed independently (click its header); they're all expanded by default. (Signed out, the defaults are used.)

### EIA API Key (required for retail gas prices)

This is **fixed, per-deployment configuration** — set once by whoever runs the app, not something a visitor
types into the dashboard settings (there's no field for it at all).

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
file on disk or committed to git, and a visitor can't change it from the dashboard settings.

### FRED API Key (required for the Economy tab)

Same model as the EIA key above — fixed per-deployment configuration, not a dashboard setting.

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

Portfolio updates (`server/social.js`, signed in): `GET /api/portfolios/public?q=` (Discover),
`POST`/`DELETE /api/portfolios/:id/follow`, `POST /api/posts` (`{ portfolioId, trades: [{ action, symbol }], message }`),
`GET`/`DELETE /api/posts/:id`, `GET /api/feed?tab=you|following&before=`, `GET /api/feed/unread`, `POST /api/feed/read`
(`{ tab }`), `POST`/`DELETE /api/posts/:id/like`, `GET`/`POST /api/posts/:id/replies`, `DELETE /api/replies/:id`.

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
├── app.js              # Root Vue app: header, subheader, page routing
├── styles.css          # Styles + dark/light theme palettes
├── server.js           # Static file server + same-origin CORS relay + /api (single process/port)
├── server/
│   ├── auth.js         # /api routes: register, login/logout, profile, password change
│   ├── frameCheck.js   # /api/frame-check: can an article URL be shown in an iframe?
│   ├── social.js       # Portfolio updates, follows, likes, replies, Discover (/api/posts, /api/feed, …)
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
│   ├── ActivityFeed.js # Inbox → Activity: You / Following updates, likes, replies, Forward
│   ├── DiscoverPortfolios.js # Account → Portfolios → Discover: search + Follow public portfolios
│   ├── HistoryChart.js # Shared single-series historical line chart (SVG)
│   └── DualLineChart.js # Shared two-series overlay chart w/ crossing-shaded fill (SVG)
├── services/
│   ├── yahooFinance.js # Yahoo Finance API calls
│   ├── eia.js          # EIA API calls
│   ├── fred.js         # FRED (economic data) API calls
│   ├── rss.js          # RSS feed fetching + caching
│   ├── auth.js         # Client for the /api account + profile routes
│   ├── social.js       # Client for portfolio updates, follows, likes and replies
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
8. Set **EIA_API_KEY** / **FRED_API_KEY** under the service's **Variables** tab to enable retail gas prices / the Economy tab for everyone visiting this deployment — see [EIA API Key](#eia-api-key-required-for-retail-gas-prices) / [FRED API Key](#fred-api-key-required-for-the-economy-tab) above. These are fixed for the whole deployment, not something each visitor sets.

If you'd rather deploy via CLI: `npm i -g @railway/cli`, then from the `oil-and-gas/` directory run `railway login`, `railway init`, `railway up`.

## Known Limitations

- **Yahoo Finance** is an unofficial API — it may break without notice.
- **rss2json.com** free tier is limited to 10 requests/hour per IP. Results are cached for 30 minutes.
- **Retail gas prices** (in Markets) are hidden until an EIA API key is configured.
- Prices from Yahoo Finance may be delayed 15–20 minutes.
- SEC EDGAR is rate-limited to 10 requests/second; the app staggers requests automatically.
