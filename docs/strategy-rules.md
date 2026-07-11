# Techno Funda RS Strategy Rules

This screener follows the user-defined daily closing workflow and the RS model learned from the raw Learn2Trade videos.

## Ingest Summary

- Raw videos scanned: 73
- Captions/transcripts parsed: 73
- Visual scan: one frame per second across all videos, 127,925 seconds sampled
- Repeat audit passed 73/73 videos: 127,925 one-second frames, 127,916.52 decoded audio-seconds, 46,130 caption cues, 48,035 caption lines, and 324,838 transcript words. Evidence is in `analysis/video-re-audit-report.json`.
- Benchmark: NIFTY 500 / CNX500 (`^CRSLDX` in Yahoo Finance)

Generated transcript/frame artifacts are kept in `analysis/` and are intentionally ignored by Git.
The evidence-to-rule mapping is documented in `docs/video-ingestion.md`.

## Compulsory Entry

An entry signal is generated only when all of these are true on closing-basis data:

- Weekly RSI(14) is above 50.
- Daily RSI(14) is above 50.
- Weekly RS(21) versus NIFTY 500 is above 0.
- Daily long RS(55) versus NIFTY 500 is above 0.
- Daily short RS(21) versus NIFTY 500 is above 0.
- Daily close is above Supertrend(10, 3).

RS formula:

```text
(stockClose / stockCloseN) / (benchmarkClose / benchmarkCloseN) - 1
```

## Compulsory Exit

The active trade is closed when weekly RS goes below 0 on a closed weekly candle.

Daily RS21, daily RS55, Supertrend, and previous candle low are shown as early weakness/risk context, but they do not close the trade unless the compulsory weekly RS exit is triggered.

## Optional Strength And Institutional Score

These checks do not create or block entry by themselves. They increase setup quality and are saved in the website detail view, CSV export, Telegram alert, and trade sheet:

- Price crosses the previous 55-day high.
- Price is inside the 52-week high zone or crosses the 52-week high.
- Retracement buy setup: a leader pulls back 2-15% from the recent high, holds/reclaims Supertrend/50-DMA/breakout retest support within 5%, shows dry pullback volume or reclaim volume, closes with a bullish reclaim candle, and keeps support risk within 8%.
- Fibonacci confluence checks whether the pullback is holding near the 38.2%, 50%, or 61.8% level of the recent 55-session swing.
- Bollinger context identifies trend support versus a compressed/range-bound phase from the 20-session middle band and bandwidth.
- Latest volume is at least 1.5x the 50-day average.
- Weekly RS and daily RS55 are rising.
- Close is above 50-DMA and 200-DMA, with 50-DMA above 200-DMA.
- Close is within 7% of daily Supertrend, giving a tighter risk reference.
- Industry/sector breadth is strong: at least 50% of the sector passes daily strength checks, with at least 5 stocks in that sector.
- Daily candle gives previous-high confirmation, bullish engulfing, or hammer context.
- ATR(14) is controlled relative to price and average traded value supports liquidity.
- NIFTY 500 market regime is healthy from RSI and 50/200-DMA context.
- NIFTY 500, NIFTY 50, and BANK NIFTY index regime supports long trades.
- NSE F&O lot-size master confirms whether the stock is derivatives eligible and records the lot size.
- NSE OI-spurts underlyings add derivative participation context: change in OI, volume, futures value, and options value.
- NIFTY/BANKNIFTY option-chain positioning is attempted for PCR and OI support/resistance context.
- Gold, silver, copper, crude oil, and USD/INR proxy trends are mapped to sector sensitivity.

Candlestick, market regime, derivatives, option-chain, commodity/currency, volatility, liquidity, and fundamental checks rank a valid entry as A+/A/B/C. They never override a failed compulsory entry check.

## Entry Style Classification

Every valid entry is classified so the website, Telegram alert, CSV, and trade sheet show why the buy exists:

- `Retracement buy`: RS leader pulls back to support/retest zone and gives reclaim confirmation.
- `Breakout buy`: price closes through the recent high or 52-week high.
- `Momentum continuation buy`: price remains near high with volume confirmation.
- `Trend continuation buy`: compulsory RS/RSI/Supertrend checks pass, but no breakout/retracement tag is active.

The retracement module is an entry-style and quality module. The stock still must pass the compulsory weekly/daily RSI, weekly RS, daily RS55, daily RS21, and close-above-Supertrend checks.

## Institutional Multi-Market Context

The scanner creates a separate institutional context object for every stock:

- `index`: broad/sector proxy trend support from NIFTY 500, NIFTY 50, and BANK NIFTY.
- `derivatives`: F&O eligibility, lot size, and OI-spurts participation when NSE data is available.
- `options`: NIFTY/BANKNIFTY PCR, max put OI, and max call OI when the public NSE endpoint is available.
- `commodity`: commodity/currency proxy support or risk based on the stock's sector.

These modules add confluence, data-gap visibility, and trade-sheet explanation. They do not turn a failed equity RS/RSI/Supertrend setup into a buy.

## Scan Universes

- All NSE Market: official NSE equity master, refreshed before the daily scan.
- Nifty 500: official Nifty 500 constituents.
- My List: TradingView/NSE/BSE symbols uploaded as Excel, CSV, or text.

The same stock in multiple lists is scanned once and creates only one trade. Its source lists remain visible.

## Signal And Execution

- Indicators use only completed daily and weekly closing candles.
- A new entry or compulsory exit signal is executed in the first actual exchange session after the signal date.
- Saturday, Sunday, and NSE market holidays are never treated as execution days. The order remains pending until a real 09:15 market candle exists.
- Execution price is the open of the first five-minute candle at 09:15 IST, inside the requested 09:15-09:20 window.
- Trade states are `PENDING_ENTRY`, `OPEN`, `PENDING_EXIT`, and `CLOSED`.
- Existing signals are baselined without old alerts or historical trades.
- The free online workflow runs at 08:00 IST to publish prior-close candidates and again at 09:25 IST to fill the actual 09:15 execution price.

## Final Decision Hierarchy

1. Completed weekly and daily candles are aligned with NIFTY 500 before any decision is made.
2. All six compulsory RS, RSI, and Supertrend checks must pass to create an entry signal.
3. The setup is classified as retracement, breakout, momentum continuation, or trend continuation; retracement is not mandatory.
4. Video-derived sector, volume, trend, candle, volatility, liquidity, market, derivative, option, commodity/currency, and fundamental evidence grades the valid signal.
5. The selected trade universe and quality mode decide whether that signal enters the automated trade sheet.
6. A valid new signal remains pending through weekends and exchange holidays, then uses the next real session's 09:15 candle open.
7. An open position exits only when completed-week RS versus NIFTY 500 falls below zero; the sell then follows the same next-session execution rule.

## Trade Selection

The website has a persistent Trade Settings panel. The selected source applies from the next scheduled scan:

- All NSE Market
- Nifty 500
- My List

The default trade quality is `BEST_ONLY`, which opens sheet/Telegram trades only for A+ or A setup-grade entries. The screener table still shows every ENTRY/EXIT/WATCH candidate for research, but the trade sheet, Telegram trade alerts, and open positions use the selected trade source and quality filter.

## Trade Sheet

Every new post-go-live entry uses Rs. 100000 capital. The workbook contains Summary, Open Positions, Pending Orders, Closed Trades, and All Trades sheets. It stores signal dates separately from 09:15 execution dates/prices, quantity, invested value, realized/unrealized P&L, entry style, setup grade, institutional score, index/derivatives/options/commodity reasons, concept coverage, retracement depth/support/risk/volume, fundamentals, sector breadth, breakout/high-zone flags, volume, ATR, candle context, Supertrend risk, and candle-low references.
