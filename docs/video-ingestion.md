# Video Strategy Ingestion

The 73 raw Learn2Trade videos contain several trading styles: positional equity, intraday, derivatives, options, commodities, currency, operator/open-interest analysis, psychology, and risk management. The screener keeps the user-defined equity entry/exit rules compulsory, then adds the other video concepts as institutional context and confluence layers wherever free repeatable data is available.

## Rule Precedence

1. The user's six compulsory entry checks decide whether an entry exists.
2. The user's closed-week weekly-RS-below-zero rule decides the compulsory exit.
3. Video-derived price, volume, trend, sector, volatility, candle, market-regime, derivative, option-chain, commodity/currency, and fundamental evidence ranks signal quality and explains risk.
4. Optional evidence never converts a failed compulsory setup into an entry.

## Ingested Technical Evidence

- Multi-timeframe structure: weekly defines relative leadership; daily confirms timing and trend.
- RS55: roughly a three-month relative return comparison against the benchmark.
- RS21: shorter relative momentum and early deterioration context.
- Breakout confirmation: a strong stock is preferred when price confirms through a prior range/high.
- Retracement entry: a strong RS leader is preferred when it pulls back into Supertrend, 50-DMA, or breakout-retest support, volume contracts on the fall or expands on reclaim, and a bullish candle confirms the turn.
- Volume shocker: unusual volume supports participation and follow-through.
- Trend context: Supertrend and 50/200-DMA structure distinguish healthy trends from weak ones.
- Sector context: strong stocks are preferred when their industry group has broad participation.
- Candle IPC principle: identification, placement, and confirmation; bullish engulfing, hammer, and previous-high confirmation are recorded.
- Volatility and liquidity: ATR percentage and average traded value expose unstable or hard-to-execute setups.
- Risk references: Supertrend distance, previous candle low, two-candle low, and four-candle low are recorded without overriding the compulsory exit.
- Pullback risk: retracement support distance is recorded so the system can separate healthy buyable pullbacks from deep damage.
- Fibonacci retracement: 38.2%, 50%, and 61.8% supports from the recent swing are recorded as pullback confluence, never as a standalone buy.
- Bollinger/range context: 20-session bands and bandwidth distinguish trending participation from compressed/range-bound conditions.
- Market regime: NIFTY 500 RSI and 50/200-DMA context show whether the broad market supports long trades.

## Ingested Index, Derivatives, Options, And Commodity Evidence

- Index regime: NIFTY 500, NIFTY 50, and BANK NIFTY are tracked as institutional trend proxies using RSI, 21/55-day returns, 50/200-DMA structure, ATR percentage, and RS where applicable.
- Sector-index alignment: financial stocks use BANK NIFTY as the closer proxy; other stocks use the broad NIFTY 500/NIFTY 50 context.
- F&O eligibility and participation: the NSE F&O lot-size master is downloaded automatically. Each stock is tagged as F&O-listed or cash-only, with lot size where available. NSE OI-spurts underlyings are also attempted to capture change-in-OI participation, volume, futures value, and options value.
- Option-chain positioning: NIFTY and BANK NIFTY option-chain snapshots are attempted automatically. When NSE allows the public endpoint, the scanner records PCR, max put OI strike, max call OI strike, expiry, and bullish/neutral/bearish option bias.
- Commodity/currency context: Gold, silver, copper, crude oil, and USD/INR Yahoo proxies are tracked. Sector sensitivity maps metals to copper/base metals, energy to crude, exporters to USD/INR, precious-metal businesses to gold/silver, and input-cost sectors to crude risk.
- Data gaps are explicit. If NSE option-chain, OI-spurts, or another free endpoint is unavailable during a GitHub run, the website and trade sheet show a data gap instead of pretending the confirmation exists.
- News/event context is explicitly marked as a data gap until a reliable free repeatable feed is available. Pair-trading, short-selling, option-premium execution, intraday scalping, and manual terminal/charting lessons are represented as excluded playbooks because they are different execution systems, not missing equity-long confirmations.

## Ingested Fundamental Evidence

- Compare current performance with the same period last year.
- Prefer rising annual net income and operating income.
- Prefer improving EBITDA margin quarter-on-quarter and year-on-year.
- Track P/E trend as optional market-rating context, not as a compulsory trigger.
- Fundamentals improve confidence/grade but price action remains the actual trade trigger.

## Execution Discipline

- A candle-based signal is known only after the candle closes.
- The system therefore records the close date as the signal date and uses the next trading session for execution.
- "Next trading session" is data-confirmed: weekends and NSE holidays are skipped, and a pending order cannot fill until a real 09:15 exchange candle is available.
- Entry and exit fills use the 09:15 five-minute candle open, a deterministic price inside the requested 09:15-09:20 window.
- Whole-share quantity is recalculated from the actual fill using available cash, the per-position cap, structural-stop distance, and portfolio risk limits, not from the signal-day close.

## Merged Entry, Exit, And Money Management

- The six user-defined weekly/daily RS, RSI, and Supertrend checks remain the compulsory entry gate.
- Breakout, retracement, momentum, candle, volume, DMA, Fibonacci, Bollinger, sector, market, F&O/OI, option-chain, commodity/currency, liquidity, volatility, and fundamental evidence ranks valid entries instead of overriding the gate.
- Video exit methods are separated into protective structural stops, partial risk/profit exits, confirmed daily trend exits, and the completed-week RS final exit.
- Position size is risk-derived from a Rs. 10 lakh editable portfolio, 1% per-trade risk, 6% aggregate risk, 10% per-stock exposure, 25% sector exposure, and actual available cash.
- Valid signals that cannot receive capital remain in a ranked queue. Quality rotation needs a materially better challenger and measurable deterioration in the weakest open position.

## Audit Evidence

## Institutional Coverage Matrix

Every stock row now stores a compact concept coverage matrix:

- Strong concepts: video-derived buckets that passed for that stock.
- Weak concepts: buckets with data present but not supportive.
- Data gaps: buckets that need a public data source that was unavailable in that scan.
- Excluded playbooks: only broker-only live Greeks/order-book depth and intraday tick scalping remain outside the daily closing system.

The matrix is visible in the website detail panel, CSV export, Telegram trade alert, and Excel trade sheet.

`npm run audit:videos` performs the repeatable audit:

- decodes every video at one frame per second,
- decodes the complete primary audio stream,
- parses every VTT caption cue and complete transcript,
- counts strategy evidence by topic for every video,
- writes `analysis/video-re-audit-report.json`.

Raw videos and generated analysis remain local and are excluded from Git.

Latest repeat audit result: 73/73 videos passed with zero decode, audio, transcript, caption, or frame-tolerance failures.
