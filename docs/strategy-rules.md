# Techno Funda RS Strategy Rules

This screener follows the user-defined daily closing workflow and the RS model learned from the raw Learn2Trade videos.

## Ingest Summary

- Raw videos scanned: 73
- Captions/transcripts parsed: 73
- Visual scan: one frame per second across all videos, 127,925 seconds sampled
- Benchmark: NIFTY 500 / CNX500 (`^CRSLDX` in Yahoo Finance)

Generated transcript/frame artifacts are kept in `analysis/` and are intentionally ignored by Git.

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

## Trade Sheet

Every new post-go-live entry opens an automatic trade with capital per stock from config, currently Rs. 100000. The trade sheet stores entry/exit date, entry/exit price, quantity, invested value, P&L, setup score, sector breadth, breakout/high-zone flags, volume ratio, risk to Supertrend, previous candle low, 2-candle low, and 4-candle low.
