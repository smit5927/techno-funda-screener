# Video Strategy Ingestion

The 73 raw Learn2Trade videos contain several trading styles: positional equity, intraday, derivatives, options, commodities, currency, operator/open-interest analysis, psychology, and risk management. The screener keeps the user-defined equity entry/exit rules compulsory, then adds the other video concepts as institutional context and confluence layers wherever free repeatable data is available.

## Rule Precedence

1. The user's six compulsory entry checks decide whether an entry exists.
2. The user's closed-week weekly-RS-below-zero rule decides the compulsory exit.
3. Video-derived price, volume, trend, sector, volatility, candle, market-regime, derivative, option-chain, commodity/currency, and fundamental evidence ranks signal quality and explains risk.
4. Optional evidence never converts a failed compulsory setup into an entry.
5. The separate GTF strategy is an additional location/zone factor; it does not replace the Techno Funda entry gate.

## Ingested Technical Evidence

- Multi-timeframe structure: weekly defines relative leadership; daily confirms timing and trend.
- RS55: roughly a three-month relative return comparison against the benchmark.
- RS21: shorter relative momentum and early deterioration context. It is a dimensionless zero-line value, not a percentage.
- Breakout confirmation: a strong stock is preferred when price confirms through a prior range/high.
- Base continuation: a 20-session closing breakout is stronger when the recent base forms a higher low than the preceding base.
- Retracement entry: a strong RS leader is preferred when it pulls back into Supertrend, 50-DMA, or breakout-retest support, volume contracts on the fall or expands on reclaim, and a bullish candle confirms the turn.
- Volume shocker: unusual volume supports participation and follow-through.
- MACD above signal and zero supports a swing-high break; rising OBV and official NSE delivery expansion confirm participation instead of replacing price action.
- Trend context: Supertrend and 50/200-DMA structure distinguish healthy trends from weak ones.
- Sector context: strong stocks are preferred when their industry group has broad participation.
- Candle IPC principle: identification, placement, and confirmation; bullish engulfing, hammer, and previous-high confirmation are recorded.
- Volatility and liquidity: ATR percentage and average traded value expose unstable or hard-to-execute setups.
- Risk references: Supertrend distance, previous candle low, two-candle low, and four-candle low are recorded without overriding the compulsory exit.
- Winner scaling: the RS Setup Session 1 discussion at 29:01-32:17 explicitly says to scale up the right rally, participate on each new breakout while RS and the rest of the setup remain favorable, and avoid adding after price damage/RS deterioration.
- The HUDCO/MCX RS case-study transcript makes the continuation sequence explicit: the position is already profitable, the strong stock advances and pulls back, and each later previous-swing-high break is another position-building opportunity while RSI remains above 50 and RS remains strong. The automated rule uses the stricter completed-daily close confirmation for that sequence.
- Stop intent: the same session at 24:15-26:21 explains that a trail should preserve room for the trend, not force an early booking, and recommends booking 50% after the reward objective while trailing the balance.
- Pullback risk: retracement support distance is recorded so the system can separate healthy buyable pullbacks from deep damage.
- Fibonacci retracement: 38.2%, 50%, and 61.8% supports from the recent swing are recorded as pullback confluence, never as a standalone buy.
- Bollinger/range context: 20-session bands and bandwidth distinguish trending participation from compressed/range-bound conditions.
- Market regime: NIFTY 500 RSI and 50/200-DMA context show whether the broad market supports long trades.
- Range/crash control: mixed, compressed/range-bound and weak benchmark states reduce new deployment while existing trades remain governed by their own exits.

## Ingested Index, Derivatives, Options, And Commodity Evidence

- Index regime: NIFTY 500, NIFTY 50, and BANK NIFTY are tracked as institutional trend proxies using RSI, 21/55-day returns, 50/200-DMA structure, ATR percentage, and RS where applicable.
- Sector-index alignment: financial stocks use BANK NIFTY as the closer proxy; other stocks use the broad NIFTY 500/NIFTY 50 context.
- F&O eligibility and participation: the NSE F&O lot-size master is downloaded automatically. Each stock is tagged as F&O-listed or cash-only, with lot size where available. NSE OI-spurts underlyings are also attempted to capture change-in-OI participation, volume, futures value, and options value.
- Cash-market operator participation: official NSE full bhavcopy/security-deliverable files compare current traded quantity, delivery quantity, delivery percentage and average price with the prior five sessions.
- Option-chain positioning: NIFTY and BANK NIFTY option-chain snapshots are attempted automatically. When NSE allows the public endpoint, the scanner records PCR, max put OI strike, max call OI strike, expiry, and bullish/neutral/bearish option bias.
- Commodity/currency context: Gold, silver, copper, crude oil, and USD/INR Yahoo proxies are tracked. Sector sensitivity maps metals to copper/base metals, energy to crude, exporters to USD/INR, precious-metal businesses to gold/silver, and input-cost sectors to crude risk.
- Data gaps are explicit. If NSE option-chain, OI-spurts, or another free endpoint is unavailable during a GitHub run, the website and trade sheet show a data gap instead of pretending the confirmation exists.
- News/event context is explicitly marked as a data gap until a reliable free repeatable feed is available. Pair-trading, short-selling, option-premium execution, intraday scalping, and manual terminal/charting lessons are represented as excluded playbooks because they are different execution systems, not missing equity-long confirmations.

## Ingested Fundamental Evidence

- Compare current performance with the same period last year.
- Prefer rising annual net income and operating income.
- Prefer quarterly sales, EPS and EBITDA growth versus the same quarter last year.
- Prefer improving EBITDA margin quarter-on-quarter and year-on-year.
- Track P/E trend as optional market-rating context, not as a compulsory trigger.
- Fundamentals improve confidence/grade but price action remains the actual trade trigger.

## Execution Discipline

- A candle-based signal is known only after the candle closes.
- The system therefore records the close date as the signal date and uses the next trading session for execution.
- "Next trading session" is data-confirmed: weekends and NSE holidays are skipped, and a pending order cannot fill until the exact 09:17 one-minute exchange candle is available.
- Entry, winner add-on, full-exit, and partial-exit fills use the exact 09:17 one-minute candle open.
- Whole-share quantity is recalculated from the actual fill using available cash, the per-position cap, structural-stop distance, and portfolio risk limits, not from the signal-day close.

## Merged Entry, Exit, And Money Management

- The six user-defined weekly/daily RS, RSI, and Supertrend checks remain the compulsory entry gate.
- Breakout, retracement, momentum, candle, volume, DMA, Fibonacci, Bollinger, sector, market, F&O/OI, option-chain, commodity/currency, liquidity, volatility, and fundamental evidence ranks valid entries instead of overriding the gate.
- Video exit methods are separated into protective structural stops, confirmed partial risk/profit exits, confirmed daily trend exits, and the completed-week RS final exit. Early-risk partials require two independent primary weaknesses across two completed closes; grade, GTF and fundamentals remain confirmations only.
- Healthy leaders receive Trend Ride Protection: strong weekly/daily leadership and intact Supertrend/50/200-DMA structure trail upward instead of taking a routine partial. Profit locking at 2R requires exhaustion evidence rather than profit alone.
- Position size is risk-derived from a Rs. 10 lakh editable portfolio, 1% per-trade risk, 6% aggregate risk, 10% per-stock exposure, 25% sector exposure, and actual available cash.
- Video-derived pyramiding is a stateful continuation setup: after the latest entry/add fill, price must advance, form a confirmed daily swing high, pull back 2%-15% without invalidating the original structure, and then freshly close above that swing high. A generic 20-day/55-day/52-week breakout alone cannot add. The setup must remain A+/A, every compulsory entry rule must still pass, weekly RS and daily RS55 must be rising, profit must be at least 1R, official delivery must not be distributing, and the current ratcheted stop must already protect average cost. Averaging down is prohibited.
- Each add-on is capped at 2.5% of portfolio capital and 0.5% incremental risk. At most two add-ons are allowed, with a 15% total winner exposure cap; the 1% total position-risk, 6% portfolio-risk and 25% sector caps still apply at the actual 09:17 fill.
- Add-on signals are based only on a new false-to-true swing-high close-break after feature go-live. After every add, the anchor resets to that actual fill and old swing points cannot be reused, so old breakouts are not backfilled and consecutive scans cannot duplicate an order.
- Valid signals that cannot receive capital remain in a ranked queue, but are fully rechecked before later use. Signal age/run-up are warnings; latest ENTRY validity, structure, rank, delivery and exact 09:17 risk decide whether freed cash may enter. Quality rotation additionally needs two-close confirmation in both the challenger and the weakest position, and replacement preflight must pass before the optional sell. Compulsory full exits and valid partial exits remain independent risk actions.
- Portfolio breadth adapts to total capital, and NIFTY 500 regime plus 5%/8% portfolio-loss guards throttle only new deployment.

## GTF Vault Ingestion

The implementation was cross-checked against the GTF vault's strategy notes, corrections, scenario matrix and production scanner/decision-service rules. The integrated EOD subset includes:

- DBR/RBR demand and RBD/DBD supply structure.
- Body-to-wick proximal/distal marking, 49.5% base guard, maximum three base candles and dirty-wick rejection.
- Freshness tests, 7-point zone score, significant-gap/two-exciting/achievement-close departure quality and at least 1R achievement evidence.
- Daily and completed-week demand support, 50-SMA slope, opposing supply, demand retest and 2R feasibility.
- Demand/supply and 2R runway as secondary rank/risk confirmation only. GTF cannot select the primary entry style, structural stop, partial exit, full exit, or rotation by itself.

Intraday HIT/DIT execution, live quote zone activation, short-side supply trades and unvalidated LOTL distance rules are not silently approximated inside this closing-basis long-equity system. Their useful higher-level evidence is retained without changing the main strategy.

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
