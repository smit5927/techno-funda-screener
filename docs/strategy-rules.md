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

## Optional Strength Score

These checks do not create or block entry by themselves. They increase setup quality and are saved in the website detail view, CSV export, Telegram alert, and trade sheet:

- Price crosses the previous 55-day high.
- Price is inside the 52-week high zone or crosses the 52-week high.
- Latest volume is at least 1.5x the 50-day average.
- Weekly RS and daily RS55 are rising.
- Close is above 50-DMA and 200-DMA, with 50-DMA above 200-DMA.
- Close is within 7% of daily Supertrend, giving a tighter risk reference.
- Industry/sector breadth is strong: at least 50% of the sector passes daily strength checks, with at least 5 stocks in that sector.
- Daily candle gives previous-high confirmation, bullish engulfing, or hammer context.
- ATR(14) is controlled relative to price and average traded value supports liquidity.
- NIFTY 500 market regime is healthy from RSI and 50/200-DMA context.

Candlestick, market regime, volatility, liquidity, and fundamental checks rank a valid entry as A+/A/B/C. They never override a failed compulsory entry check.

## Scan Universes

- All NSE Market: official NSE equity master, refreshed before the daily scan.
- Nifty 500: official Nifty 500 constituents.
- My List: TradingView/NSE/BSE symbols uploaded as Excel, CSV, or text.

The same stock in multiple lists is scanned once and creates only one trade. Its source lists remain visible.

## Signal And Execution

- Indicators use only completed daily and weekly closing candles.
- A new entry or compulsory exit signal is executed in the next trading session.
- Execution price is the open of the first five-minute candle at 09:15 IST, inside the requested 09:15-09:20 window.
- Trade states are `PENDING_ENTRY`, `OPEN`, `PENDING_EXIT`, and `CLOSED`.
- Existing signals are baselined without old alerts or historical trades.

## Trade Sheet

Every new post-go-live entry uses Rs. 100000 capital. The workbook contains Summary, Open Positions, Pending Orders, Closed Trades, and All Trades sheets. It stores signal dates separately from 09:15 execution dates/prices, quantity, invested value, realized/unrealized P&L, setup grade, fundamentals, sector breadth, breakout/high-zone flags, volume, ATR, candle context, Supertrend risk, and candle-low references.
