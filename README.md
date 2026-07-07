# Techno Funda Screener

Daily-close based screener with two lists, Telegram alerts, automatic trade journal, and Excel export.

## Rules

- Entry: weekly RSI 14 > 50, daily RSI 14 > 50, weekly RS 21 > 0, daily long RS 55 > 0, daily short RS 21 > 0, and daily close above Supertrend.
- Exit: weekly RS 21 < 0 on closed weekly candle.
- Fundamentals are optional strength checks, not compulsory entry filters.
- Every signal stores the reason on the website, Telegram alert, JSON result, and trade sheet.

## Lists

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

If the first row has a column named `Symbol`, `Ticker`, `TradingView Symbol`, `Trading Symbol`, `TV Symbol`, `Scrip`, or `Stock`, only that column is imported. Otherwise the app scans the first sheet and extracts symbol-like values automatically. After import, My Custom List is scanned automatically and the trade sheet is refreshed.

For free cloud mode, upload the Excel/CSV directly from the website with the Techno Funda access code.

## Local Setup

```powershell
npm.cmd install
npm.cmd run update:universe
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

Entry opens an automatic trade if no open trade exists for the same symbol/list. Exit closes that open trade and calculates P&L, P&L %, holding days, entry reason, and exit reason.

Live mode is baseline based:

- The first live scan records current statuses only.
- Existing/past ENTRY candidates do not create Telegram alerts.
- Existing/past ENTRY candidates do not open Excel trades.
- A trade opens only when a symbol changes into ENTRY after the go-live baseline.
- A trade closes only for trades opened by this system after go-live.

Position sizing uses:

```text
TRADE_CAPITAL_PER_STOCK=100000
```

## Fully Free Cloud Mode

This mode does not need Render and does not need the office PC to stay on.

It uses:

- GitHub Actions for the daily morning scan.
- GitHub Pages for the mobile website.
- Supabase free database and Edge Function for website upload/results.
- Telegram bot secrets stored in GitHub.
- Repository files for scan history, trade journal, and downloadable Excel/CSV trade sheet.

The workflow file is:

```text
.github/workflows/daily-screener.yml
```

It runs at:

```text
8:15 AM Asia/Kolkata, Monday-Friday. GitHub Actions stores this as `02:45 UTC`.
```

It also has `workflow_dispatch`, so you can run it manually from the GitHub Actions tab.

### Important Free Limitation

GitHub Pages on GitHub Free is available for public repositories. If the repo is public, your website data and trade sheet download links can also be public. If you want private GitHub Pages, GitHub requires a paid plan.

Supabase free tier is used only for Techno Funda data with `techno_funda_*` names. Existing GTF strategy tables such as `gtf_*` are separate and are not touched.

### Free Setup Steps

1. Create a public GitHub repository.
2. Push this project folder to that repo.
3. In GitHub repo settings, open `Settings > Secrets and variables > Actions`.
4. Add these repository secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TECHNO_FUNDA_INTERNAL_KEY
```

5. Open `Settings > Pages`.
6. Set build/deploy source to GitHub Actions.
7. Open `Actions > Daily Techno Funda Screener > Run workflow` once.
8. After it finishes, open the GitHub Pages URL on mobile.

### Website Custom Excel Upload

Open the website, click `Edit My List`, enter the Techno Funda access code, choose your Excel/CSV file, and click `Import Excel & Scan`.

The first sheet can have a column named `TradingView Symbol`, `Symbol`, `Ticker`, `Trading Symbol`, `TV Symbol`, `Scrip`, or `Stock`.

Example values:

```text
NSE:MIDHANI
NSE:CDSL
NSE:LT
BSE:500325
```

After upload, the cloud list is saved immediately. The next scheduled scan uses that list automatically. You can also run the GitHub workflow manually.

## Cloud Deployment For Mobile Without PC

Use Render with the included `render.yaml`.

Important: this app needs persistent storage for `trades.json`, the Excel file, and your custom list. Render persistent disks are available on paid plans. The Blueprint uses:

```yaml
plan: starter
disk:
  mountPath: /var/data
  sizeGB: 1
```

Deployment flow:

1. Push this folder to a GitHub repository.
2. Open Render Dashboard.
3. Create a new Blueprint from that GitHub repo.
4. Render will read `render.yaml`.
5. Fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
6. Deploy.
7. Open the Render URL on mobile.

After deployment your mobile URL will look like:

```text
https://techno-funda-screener.onrender.com
```

The server runs the weekday morning scan automatically:

```text
SCAN_CRON=15 8 * * 1-5
SCAN_TIMEZONE=Asia/Kolkata
```
