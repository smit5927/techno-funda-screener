# Video Strategy Ingestion

The 73 raw Learn2Trade videos contain several trading styles: positional equity, intraday, derivatives, options, commodities, currency, operator/open-interest analysis, psychology, and risk management. The screener applies only rules that are reproducible from free end-of-day equity data. Intraday/options/commodity-specific rules are not forced into positional cash-equity signals.

## Rule Precedence

1. The user's six compulsory entry checks decide whether an entry exists.
2. The user's closed-week weekly-RS-below-zero rule decides the compulsory exit.
3. Video-derived price, volume, trend, sector, volatility, candle, market-regime, and fundamental evidence ranks signal quality and explains risk.
4. Optional evidence never converts a failed compulsory setup into an entry.

## Ingested Technical Evidence

- Multi-timeframe structure: weekly defines relative leadership; daily confirms timing and trend.
- RS55: roughly a three-month relative return comparison against the benchmark.
- RS21: shorter relative momentum and early deterioration context.
- Breakout confirmation: a strong stock is preferred when price confirms through a prior range/high.
- Volume shocker: unusual volume supports participation and follow-through.
- Trend context: Supertrend and 50/200-DMA structure distinguish healthy trends from weak ones.
- Sector context: strong stocks are preferred when their industry group has broad participation.
- Candle IPC principle: identification, placement, and confirmation; bullish engulfing, hammer, and previous-high confirmation are recorded.
- Volatility and liquidity: ATR percentage and average traded value expose unstable or hard-to-execute setups.
- Risk references: Supertrend distance, previous candle low, two-candle low, and four-candle low are recorded without overriding the compulsory exit.
- Market regime: NIFTY 500 RSI and 50/200-DMA context show whether the broad market supports long trades.

## Ingested Fundamental Evidence

- Compare current performance with the same period last year.
- Prefer rising annual net income and operating income.
- Prefer improving EBITDA margin quarter-on-quarter and year-on-year.
- Track P/E trend as optional market-rating context, not as a compulsory trigger.
- Fundamentals improve confidence/grade but price action remains the actual trade trigger.

## Execution Discipline

- A candle-based signal is known only after the candle closes.
- The system therefore records the close date as the signal date and uses the next trading session for execution.
- Entry and exit fills use the 09:15 five-minute candle open, a deterministic price inside the requested 09:15-09:20 window.
- Rs. 100000 capital is converted to whole-share quantity from the actual fill, not from the signal-day close.

## Audit Evidence

`npm run audit:videos` performs the repeatable audit:

- decodes every video at one frame per second,
- decodes the complete primary audio stream,
- parses every VTT caption cue and complete transcript,
- counts strategy evidence by topic for every video,
- writes `analysis/video-re-audit-report.json`.

Raw videos and generated analysis remain local and are excluded from Git.

Latest repeat audit result: 73/73 videos passed with zero decode, audio, transcript, caption, or frame-tolerance failures.
