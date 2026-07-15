# Techno Funda Screener

Daily-close based screener for all NSE equities, Nifty 500, and a custom uploaded list, with Telegram alerts, next-morning execution, automatic trade journal, and Excel export.

## Rules

- Entry: weekly RSI 14 > 50, daily RSI 14 > 50, weekly RS 21 > 0, daily long RS 55 > 0, daily short RS 21 > 0, and daily close above Supertrend.
- Exit: weekly RS 21 < 0 on closed weekly candle.
- Fundamentals are optional strength checks, not compulsory entry filters.
- Video-ingested setup strength adds optional score/context for higher-low 20-day bases, 55-day/52-week breakouts, retracements, MACD/OBV, official NSE delivery/operator activity, RS trend, 50/200 DMA, candles, ATR/liquidity, market/sector/derivative/options/commodity context, fundamentals and risk. Winner pyramiding separately requires a post-fill advance, controlled pullback, and fresh daily close above its confirmed swing high. GTF remains secondary confluence only. Full notes are in `docs/strategy-rules.md` and `docs/video-ingestion.md`.
- Waiting entries are re-underwritten at the latest close and actual 09:17 price before freed cash is used. Signal run-up/age are warnings rather than automatic rejection when the current entry remains valid. Optional rotations require two-close confirmation on both sides and replacement preflight before the weak holding is sold. Early-weakness partial exits also require two independent primary weaknesses across two completed closes; GTF, grade and fundamentals are secondary context rather than standalone sell triggers.
- Every signal stores the reason on the website, Telegram alert, JSON result, and trade sheet.

## Lists

- All NSE Market: `config/all-market.csv`
- Default Nifty 500: `config/universe.csv`
- My Custom List: `config/custom-list.csv` locally, or Supabase cloud upload in free online mode

The local website lets you edit My Custom List from mobile when the PC server is running. In free cloud mode, the GitHub Pages website uploads your Excel/CSV list to Supabase.

You can also upload an Excel/CSV file from the website. Supported symbol formats:

```text
NSE:MIDHANI
MIDHANI
MIDHANI.NS
BSE:500325
```

If the first row has a column named `Symbol`, `Ticker`, `TradingView Symbol`, `Trading Symbol`, `TV Symbol`, `Scrip`, or `Stock`, only that column is imported. Otherwise the app scans the first sheet and extracts symbol-like values automatically.

For free cloud mode, upload the Excel/CSV directly from the website with the Techno Funda access code.

## Trade Settings

The website has a `Trade Settings` panel. Enter the Techno Funda access code once, then choose which universe should drive the trade sheet, Telegram trade alerts, and open positions from the next scheduled scan:

- All NSE Market
- Nifty 500
- My List

Default quality is `Best only (A+/A)`, so the trade sheet takes only the highest-grade valid entries. The screener table still displays all candidates for review.

## Local Setup

```powershell
npm.cmd install
npm.cmd run update:universes
npm.cmd run scan -- --no-telegram
npm.cmd start
```

Open `http://localhost:3000`.

## Telegram

Create a bot with BotFather, send one message to the bot, then set:

```text
TELEGRAM_BOT_TOKEN=123456789:your_bot_token
TELEGRAM_CHAT_ID=123456789
```

Test:

```powershell
npm.cmd run scan -- --telegram
```

## Trade Sheet

Every scan updates:

- `data/trades.json`
- `data/techno-funda-trade-sheet.xlsx`
- `data/techno-funda-trade-sheet.csv`

A new closing signal submits its model order at 09:17 on the next trading session. The exact 09:17 one-minute candle is preferred; when an illiquid stock has no transaction at that minute, the first actual traded candle through 09:30 is used and its real fill time is separately audited. The journal separates signal dates from execution dates, prevents duplicate positions across lists, and calculates quantity, invested/current value, realized/unrealized P&L, holding days, and full reasons.

Live mode is baseline based:

- The first live scan records current statuses only.
- Existing/past ENTRY candidates do not create Telegram alerts.
- Existing/past ENTRY candidates do not open Excel trades.
- A trade opens only when a symbol changes into ENTRY after the go-live baseline.
- A trade closes only for trades opened by this system after go-live.
- Weekly RS below zero remains the compulsory exit; daily weakness remains an early-warning reference.
- The cloud workflow runs the full prior-close scan at 08:00 IST. Lightweight, idempotent execution passes retry after 09:17 at staggered times from 09:21 through 10:10 IST, so delays in GitHub's free scheduled runners do not leave valid pending orders stuck. These passes reuse the saved closing scan and do not rescan the full market.
- Every open-position row shows invested value and current market value. The website uses near-live one-minute quotes when available; the downloadable Excel records the latest processed EOD/execution value.
- Trade scope is strict: candidate lookup, new orders, open-position display, Telegram trade alerts, and the trade sheet use only the currently selected universe. Source-list memberships remain audit metadata and cannot admit an out-of-scope waiting candidate.

Position sizing uses:

```text
TRADE_CAPITAL_PER_STOCK=100000
```

## Fully Free Cloud Mode

This mode does not need Render and does not need the office PC to stay on.

It uses:

- GitHub Actions for the daily morning scan.
- GitHub Pages for the mobile website.
- Supabase free database and Edge Function for website uploads, settings, and cloud-state backup.
- Telegram settings saved from the website into the Techno Funda Supabase table.
- Repository files for scan history, trade journal, and downloadable Excel/CSV trade sheet.

The workflow file is:

```text
.github/workflows/daily-screener.yml
```

It runs at:

```text
8:00 AM Asia/Kolkata, Monday-Friday. GitHub Actions stores this as `02:30 UTC`.
9:25 AM Asia/Kolkata, Monday-Friday. GitHub Actions stores this as `03:55 UTC`.
```

It also has `workflow_dispatch`, so you can run it manually from the GitHub Actions tab.

### Important Free Limitation

GitHub Pages on GitHub Free is available for public repositories. If the repo is public, your website data and trade sheet download links can also be public. If you want private GitHub Pages, GitHub requires a paid plan.

Supabase free tier is used only for Techno Funda data with `techno_funda_*` names. Existing GTF strategy tables such as `gtf_*` are separate and are not touched.

### Free Setup Steps

1. Create a public GitHub repository.
2. Push this project folder to that repo.
3. In GitHub repo settings, open `Settings > Secrets and variables > Actions`.
4. Add this repository secret:

```text
TECHNO_FUNDA_INTERNAL_KEY
```

5. Open `Settings > Pages`.
6. Set build/deploy source to GitHub Actions.
7. Open `Actions > Daily Techno Funda Screener > Run workflow` once.
8. After it finishes, open the GitHub Pages URL on mobile.

### Website Custom Excel Upload

Open the website, click `Edit My List`, enter the Techno Funda access code, choose your Excel/CSV file, and click `Import Excel & Save`.

The first sheet can have a column named `TradingView Symbol`, `Symbol`, `Ticker`, `Trading Symbol`, `TV Symbol`, `Scrip`, or `Stock`.

Example values:

```text
NSE:MIDHANI
NSE:CDSL
NSE:LT
BSE:500325
```

After upload, the cloud list is saved immediately. The next scheduled scan uses that list automatically. You can also run the GitHub workflow manually.

### Website Telegram Setup

Open the website, click `Telegram`, enter the same Techno Funda access code, add the bot token and chat ID, then click `Save Telegram`. The public website never shows the saved token.

Telegram settings are stored in Supabase and reused automatically on future scans. If Telegram says `chat not found`, open the bot once in Telegram and confirm the saved chat ID is correct.
