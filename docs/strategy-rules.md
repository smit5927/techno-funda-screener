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

RS is a dimensionless zero-line oscillator and is displayed directly, for example `0.02` or `-0.02`; it is not labelled or multiplied into a percentage.

## Compulsory Exit

The upgraded portfolio engine merges the video exit playbooks into a hierarchy:

- Full exit when completed-week RS versus NIFTY 500 falls below zero.
- Full exit when daily RS55 is below zero and daily close is below Supertrend.
- Full exit when price breaches the ratcheting structural stop built from Supertrend, recent candle lows, and valid Fibonacci support.
- Full exit when price is below 200-DMA with negative daily RS55.
- Partial 50% early-risk exit requires at least two independent primary technical weaknesses across two distinct completed daily closes. A first or isolated weakness remains `WAIT/WATCH`.
- Setup grade, GTF room/supply and fundamental deterioration are secondary context. They can strengthen an already-confirmed technical decision but cannot originate a partial or full exit.
- A separate one-time 2R profit-lock partial remains allowed because it is profit management rather than a deterioration exit.
- Trend Ride Protection suppresses early-risk and automatic 2R partials while weekly RS, daily RS55, RSI, Supertrend, 50/200-DMA structure, market regime and delivery behavior remain healthy. The ratcheting stop protects the winner. A 2R profit lock is reserved for an exhausted move, currently RSI at least 75 and price at least 3 ATR above the 50-DMA.
- The remaining quantity trails with Supertrend/recent structure. A trailing stop never moves downward.

All exit decisions use completed candles and execute in the next actual market session at exactly 09:17 IST.

## Optional Strength And Institutional Score

These checks do not create or block entry by themselves. They increase setup quality and are saved in the website detail view, CSV export, Telegram alert, and trade sheet:

- Price crosses the previous 55-day high.
- Price closes through a 20-day base while the recent base low is above the preceding base low.
- Price is inside the 52-week high zone or crosses the 52-week high.
- Retracement buy setup: a leader pulls back 2-15% from the recent high, holds/reclaims Supertrend/50-DMA/breakout retest support within 5%, shows dry pullback volume or reclaim volume, closes with a bullish reclaim candle, and keeps support risk within 8%.
- Fibonacci confluence checks whether the pullback is holding near the 38.2%, 50%, or 61.8% level of the recent 55-session swing.
- Bollinger context identifies trend support versus a compressed/range-bound phase from the 20-session middle band and bandwidth.
- Latest volume is at least 1.5x the 50-day average.
- MACD(12,26,9) is above its signal and zero, and OBV is rising, as optional price/participation confirmation.
- Official NSE security-deliverable bhavcopy compares traded quantity and delivery quantity with the prior five-session average; price-up, expanded participation and a close above average traded price confirm operator accumulation.
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
- Quarterly sales, EPS and EBITDA are compared with the same quarter last year alongside the original income, margin and P/E checks.

Candlestick, market regime, derivatives, option-chain, commodity/currency, volatility, liquidity, and fundamental checks rank a valid entry as A+/A/B/C. They never override a failed compulsory entry check.

## GTF Additional Confluence

The separate Obsidian GTF strategy is ingested as an optional institutional-order-location layer. It is never the main strategy and never converts a failed compulsory RS/RSI/Supertrend setup into a buy.

- Detect DBR/RBR demand and RBD/DBD supply from body-to-wick bases using the 49.5% rounding guard and at most three base candles.
- Reject dirty bases above 1.2x adverse-wick/zone-width and departures that fail the GTF closing/achievement concept.
- Score freshness, departure strength and time at base on the GTF 7-point scale; record achievement in R and the departure type.
- Compare daily and completed-week zones, 50-SMA seven-bar slope, demand retests, active opposing supply and available 2R runway.
- Record qualified demand retests and supply runway as additional context only; video-derived price action selects the entry style.
- Add GTF confluence to candidate rank, but do not use a GTF zone to set the structural stop or as a standalone entry/exit trigger.
- Fresh opposing supply can confirm a video-derived weakness or block an optional winner add-on. GTF-only weakness cannot trigger risk reduction or rotation.
- Build completed monthly, quarterly, half-yearly and yearly candles and detect a conservative `Reacting from HTF` demand proxy. A fresh score-7 higher-timeframe demand overlap or recent touch-and-reclaim counts only when daily trend is up and weekly trend is not down.
- `Reacting from HTF` is explicitly labelled `PROXY_UNVALIDATED` and `SECONDARY_CONFLUENCE_ONLY`. It may improve rank and support a 2R-plus-separate-follow-up management note after a valid primary entry; it cannot create a buy, sell, stop, add-on or rotation by itself.
- LOTL is not fabricated from daily closing data. The source has no deterministic numerical distance rule, so connected-zone merging remains excluded until separately validated.

The website detail panel, Telegram trade alert, CSV and Excel workbook expose the selected demand/supply zones, freshness, achievement, GTF score and 2R room.

## Entry Style Classification

Every valid entry is classified so the website, Telegram alert, CSV, and trade sheet show why the buy exists:

- `Retracement buy`: RS leader pulls back to support/retest zone and gives reclaim confirmation.
- `Breakout buy`: price closes through a higher-low 20-day base, recent 55-day high, or 52-week high.
- `Momentum continuation buy`: price remains near high with volume confirmation.
- `Trend continuation buy`: compulsory RS/RSI/Supertrend checks pass, but no breakout/retracement tag is active.

The retracement module is an entry-style and quality module. The stock still must pass the compulsory weekly/daily RSI, weekly RS, daily RS55, daily RS21, and close-above-Supertrend checks.

## Institutional Multi-Market Context

The scanner creates a separate institutional context object for every stock:

- `index`: broad/sector proxy trend support from NIFTY 500, NIFTY 50, and BANK NIFTY.
- `derivatives`: F&O eligibility, lot size, and OI-spurts participation when NSE data is available.
- `options`: NIFTY/BANKNIFTY PCR, max put OI, and max call OI when the public NSE endpoint is available.
- `commodity`: commodity/currency proxy support or risk based on the stock's sector.
- `operator`: official NSE traded/deliverable quantity expansion, delivery percentage, average traded price, accumulation and distribution state.

These modules add confluence, data-gap visibility, and trade-sheet explanation. They do not turn a failed equity RS/RSI/Supertrend setup into a buy.

## Scan Universes

- All NSE Market: official NSE equity master, refreshed before the daily scan.
- Nifty 500: official Nifty 500 constituents.
- My List: TradingView/NSE/BSE symbols uploaded as Excel, CSV, or text.

The same stock in multiple lists is scanned once and creates only one trade. Its source lists remain visible.

## Signal And Execution

- Indicators use only completed daily and weekly closing candles.
- A new entry or compulsory exit signal is executed in the first actual exchange session after the signal date.
- Saturday, Sunday, and NSE market holidays are never treated as execution days. The order remains pending until the next real exchange session reaches the 09:17 execution time.
- The model order time is 09:17 IST. If an illiquid stock has no transaction candle at exactly 09:17, the first real traded candle up to 09:30 on that same intended session is used; order time and actual fill time are stored separately. A later trading session can never substitute for a missed intended-session window.
- Execution price is the exact 09:17 candle open when traded, otherwise the first real one-minute traded candle through 09:30 on that same session; the 09:15 daily/market open is never substituted.
- Trade states are `PENDING_ENTRY`, `OPEN`, `PENDING_EXIT`, and `CLOSED`.
- Existing signals are baselined without old alerts or historical trades.
- The free online workflow runs the full scan at 08:00 IST, then uses staggered lightweight execution retries from 09:21 through 10:10 IST to process 09:17 orders without rescanning the market.
- Execution retries are idempotent: after an order fills or is skipped, later retries cannot duplicate the trade or Telegram alert.

## Final Decision Hierarchy

1. Completed weekly and daily candles are aligned with NIFTY 500 before any decision is made.
2. All six compulsory RS, RSI, and Supertrend checks must pass to create an entry signal.
3. The setup is classified as retracement, breakout, momentum continuation, or trend continuation; retracement is not mandatory.
4. Video-derived evidence grades and ranks the valid signal; optional GTF demand/supply context can add or subtract secondary confluence only.
5. The selected trade universe and quality mode decide whether that signal enters the automated trade sheet.
6. A valid new signal remains pending through weekends and exchange holidays, then uses the next real session's exact 09:17 one-minute candle open.
7. Open-position management applies the video-derived full/partial exit hierarchy and ratcheting structural stop. GTF may confirm, but cannot originate, a sell.

### Completed Weekly EMA13 Momentum Rule

- Weekly EMA13 is calculated only from completed weekly candles. An intraweek wick or temporary trade below EMA13 is ignored.
- A completed weekly candle close below EMA13 is a full momentum-break exit condition. It does not wait for a second weekly close.
- A completed weekly reclaim above EMA13 is supportive re-entry evidence; it cannot replace the six compulsory entry checks.
- A stock below weekly EMA13 cannot become a fresh automated entry or an optional rotation replacement until the completed-week structure reclaims the average.
- Breakout/reclaim entries use the wider valid support of daily Supertrend and weekly EMA13 when both lie inside the configured 1.5%-8% stop band. Position quantity is reduced by the unchanged risk budget instead of using a noisy candle-low stop.

## Trade Selection

The website has a persistent Trade Settings panel. The selected source applies from the next scheduled scan:

- All NSE Market
- Nifty 500
- My List

The default trade quality is `BEST_ONLY`, which opens sheet/Telegram trades only for A+ or A setup-grade entries. The screener table still shows every ENTRY/EXIT/WATCH candidate for research, but the trade sheet, Telegram trade alerts, and open positions use the selected trade source and quality filter.

## Portfolio And Risk Engine

- Every automated initial buy and pyramid add-on must be at least Rs 10,000 by default. Residual cash, sector room or risk room below this floor stays in cash instead of creating an uneconomical tiny position. The owner can change the floor in Trade Settings.
- Liquidity is compulsory for automated execution. A row with failed 20-day turnover liquidity or a requested NSE symbol that only resolves through a BSE fallback cannot be bought or pyramided until reliable exchange-consistent coverage is available.
- Existing legacy positions below the minimum are not force-sold only because of size; normal structural exit and rotation rules continue to manage them so DP charges are not created unnecessarily.

- Starting capital is Rs. 10,00,000 and can be changed or increased from persistent website Trade Settings.
- Portfolio breadth adapts to capital: up to 10 positions below Rs. 10 lakh, 15 at Rs. 10 lakh, 20 at Rs. 25 lakh, 25 at Rs. 50 lakh, 30 at Rs. 1 crore, and 50 at Rs. 5 crore or more. Available cash and risk limits can result in fewer positions.
- Initial capital allocation remains capped at 10% per stock (Rs. 1,00,000 at the default capital).
- Maximum planned loss is 1% of portfolio capital per new trade.
- Maximum aggregate open portfolio risk is 6% of capital.
- Maximum sector exposure is 25% of capital.
- NIFTY 500 `BULL/MIXED/RANGE/WEAK` mode caps new deployment at 100%/50%/25%/25%; this does not force an otherwise invalid exit.
- A portfolio loss of 5% halves new deployment capacity; at 8%, new buys/add-ons freeze until risk recovers. Existing positions continue through the normal exit engine.
- Quantity is the minimum allowed by available cash, per-stock allocation cap, stop distance, risk budget, sector capacity, and remaining portfolio-risk capacity.
- Structural stop distance is kept between 1.5% and 8% so a very tight candle does not create oversized quantity and a very wide setup does not consume excessive risk.
- Every valid new signal receives a comparable portfolio rank from setup grade, RS leadership/trend, entry style, GTF demand/supply confluence, volume, sector, market/index, institutional, fundamental, volatility, liquidity, and concept coverage.
- If capital is unavailable, the signal is retained in Waiting Candidates with the exact skip reason.
- Every waiting candidate is re-underwritten from the latest completed close before freed cash can be used: compulsory ENTRY status, selected grade quality, rank stability, Supertrend/ATR risk distance, delivery behavior, portfolio limits and actual 09:17 execution gap are checked again. A candidate that fails becomes waiting-for-retrace/reconfirmation or expires with an auditable reason; cash may remain idle.
- Waiting age and price advance from the first signal are warning metrics, not automatic rejection. If the latest system ENTRY remains valid and current structure/execution risk is acceptable, a strong stock that has advanced can still be bought.
- Management priority is `compulsory full exit > confirmed partial exit > optional quality rotation > wait/watch/hold`. A full exit executes from its own risk rule; a minor first deterioration close is observed instead of being sold hastily.
- A challenger can replace an existing position only when its rank advantage is material, the current position has at least two weakness factors, the minimum holding rule is satisfied, both weakness and replacement ENTRY have confirmation across two distinct closes, and the broad-market regime supports optional rotation. Sector limits cannot be bypassed.
- Quality rotation is conditional and atomic at execution: before the weak stock is sold, the linked replacement must pass latest-close underwriting and exact 09:17 price preflight. Only then does the weak position sell and the replacement buy in the same slot using immediately released cash. If replacement preflight fails, the optional rotation is cancelled and the current holding remains; no fictional later-session switch is created.
- When capital is manually reduced or the legacy book exceeds limits, weaker-ranked positions are queued for controlled next-session rebalance; no historical fill is fabricated.
- Capital changes are recorded in the Excel Capital Ledger.

### Winner Pyramiding And Trailing Risk

- The video-derived scale-up rule is applied only to an already profitable open position; the system never averages down.
- Each initial entry or filled add-on starts a new independent structure cycle. Price must first advance at least 2%, then make a confirmed two-sided daily swing high, pull back 2%-15% without invalidating the original structure, and finally make a fresh daily close above that swing high while the previous close was at or below it.
- A generic 20-day, 55-day, or 52-week breakout by itself cannot trigger pyramiding. The exact post-entry advance -> controlled pullback -> swing-high closing-break sequence is compulsory, along with current A+/A grade, all compulsory entry checks, rising weekly RS and daily RS55, supportive market regime, no delivery-distribution/GTF supply warning, at least 1R open profit, and a trailing stop at or above the blended entry.
- The initial position remains capped at 10%. Each add-on is capped at 2.5%, with no more than two add-ons and no more than 15% total capital in one winning stock.
- Incremental add-on risk is capped at 0.5% of capital. Total remaining risk in that position cannot exceed 1%, aggregate portfolio risk cannot exceed 6%, and sector exposure cannot exceed 25%.
- A signal is reserved on the swing-high closing breakout and re-sized using actual cash, risk, sector room and the exact next-session 09:17 price. Weekends and exchange holidays are skipped.
- The weighted average price, total quantity, P&L, trailing stop and each add-on lot are recalculated automatically. The stop never moves downward, and any pending sell/risk-reduction action cancels a pending add.
- After an add fills, all pivots before that fill are ineligible and a completely new advance/pullback/swing cycle is required. Existing positions are baselined when this upgraded module goes live; no historical breakout or add-on is fabricated.

## Trade Sheet

The workbook contains Summary, Open Positions, Pending Orders, Closed Trades, All Trades, Waiting Candidates, Candidate Decision Log, and Capital Ledger sheets. It stores signal dates separately from exact 09:17 execution dates/prices, latest management hierarchy, waiting-candidate freshness/extension decisions, entry execution rechecks, rotation confirmations/cancellations, risk-sized quantity, initial/blended entry, add-on count and lot history, initial/trailing stop, planned and current risk, position rank, partial exits, replacement candidate, invested value, realized/unrealized P&L and percentage, market exposure/drawdown controls, entry style, setup grade, GTF additional context, institutional score, index/derivatives/options/commodity/operator reasons, concept coverage, retracement/base/breakout evidence, MACD/OBV, fundamentals, sector breadth, volume, ATR, candle context, and candle-low references.

### Brokerage and statutory charge accounting

- Charges can be switched on or off per user from Trade Settings.
- Brokerage supports either a fixed amount per executed order or a percentage of turnover; the delivery DP charge is independently configurable.
- When enabled, every entry, pyramid add, partial exit and full exit records turnover, brokerage, STT, NSE transaction charge, SEBI turnover charge, stamp duty, IPFT, GST and DP charge.
- Booked realized P&L is net of allocated buy charges and actual sell charges. Open unrealized P&L is net of remaining buy charges and the estimated delivery sell charges at the latest price.
- The workbook includes a Transactions & Charges sheet and keeps gross P&L, net P&L and charge components separate for auditability.

## Forward Evidence And Continuous Improvement Mandate

- Preserve every forward entry, skipped candidate, waiting decision, rotation, add-on, partial/full exit, charge, daily mark-to-market snapshot and benchmark outcome as immutable audit evidence.
- Once a statistically useful live sample exists, audit expectancy, win rate, average win/loss, profit factor, maximum drawdown, MAE/MFE, holding time, capital utilization and returns after all charges.
- Attribute results separately to entry style, exit reason, setup grade, market regime, sector, fundamentals, weekly EMA13 state, GTF confirmation and institutional context so weak and useful rules can be distinguished.
- Specifically review false exits, delayed exits, missed runners, failed breakouts, successful reclaims, premature rotations and waiting candidates that ran without entry.
- Improve thresholds only through chronological walk-forward analysis with separate development, validation and untouched out-of-sample periods. No look-ahead data or retrospective fill fabrication is allowed.
- Compare every proposed upgrade against the unchanged original RS/RSI/Supertrend baseline after brokerage and statutory charges. Adopt it only when robustness, drawdown and expectancy improve across regimes, not merely in one historical sample.
- Record the old rule, proposed rule, evidence window, sample size, before/after metrics and rollback condition before deployment. Strategy changes remain versioned and reversible.
