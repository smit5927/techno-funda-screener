# Techno Funda Screener

Daily-close based screener for all NSE equities, Nifty 500, and a custom uploaded list, with Telegram alerts, next-morning execution, automatic trade journal, and Excel export.

## Rules

- Entry: weekly RSI 14 > 50, daily RSI 14 > 50, weekly RS 21 > 0, daily long RS 55 > 0, daily short RS 21 > 0, and daily close above Supertrend.
- Exit: weekly RS 21 < 0 on closed weekly candle.
- Fundamentals are optional strength checks, not compulsory entry filters.
- Video-ingested setup strength adds optional score/context for higher-low 20-day bases, 55-day/52-week breakouts, retracements, MACD/OBV, official NSE delivery/operator activity, RS trend, 50/200 DMA, candles, ATR/liquidity, market/sector/derivative/options/commodity context, fundamentals and risk. GTF remains secondary confluence only. Full notes are in `docs/strategy-rules.md` and `docs/video-ingestion.md`.
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

A new closing signal is executed on the next trading session using the exact 09:17 one-minute candle open. The journal separates signal dates from execution dates, prevents duplicate positions across lists, and calculates quantity from Rs. 100000, invested value, realized/unrealized P&L, holding days, and full reasons.

Live mode is baseline based:

- The first live scan records current statuses only.
- Existing/past ENTRY candidates do not create Telegram alerts.
- Existing/past ENTRY candidates do not open Excel trades.
- A trade opens only when a symbol changes into ENTRY after the go-live baseline.
- A trade closes only for trades opened by this system after go-live.
- Weekly RS below zero remains the compulsory exit; daily weakness remains an early-warning reference.
- The cloud workflow runs at 08:00 IST for prior-close candidates and again at 09:25 IST so the requested opening-window price is available in the trade sheet.

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
