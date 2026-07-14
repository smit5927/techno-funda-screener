const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const FUNDAMENTAL_TYPES = [
  "annualNetIncome",
  "annualOperatingIncome",
  "annualNormalizedEBITDA",
  "annualTotalRevenue",
  "annualBasicEPS",
  "annualDilutedEPS",
  "quarterlyNormalizedEBITDA",
  "quarterlyTotalRevenue",
  "trailingPeRatio"
];

export async function fetchCandles(symbol, interval, yearsBack) {
  const period2 = Math.floor(Date.now() / 1000) + DAY_MS / 1000;
  const period1Date = new Date();
  period1Date.setUTCFullYear(period1Date.getUTCFullYear() - yearsBack);
  const period1 = Math.floor(period1Date.getTime() / 1000);
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  );
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", interval);
  url.searchParams.set("events", "history");

  const response = await fetchJson(url);
  const result = response?.chart?.result?.[0];
  const error = response?.chart?.error;
  if (error) throw new Error(error.description || error.code || "Yahoo chart error");
  if (!result) throw new Error("Yahoo chart returned no data");

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const candles = timestamps
    .map((timestamp, index) => {
      const date = new Date(timestamp * 1000);
      return {
        date: toYmd(date),
        time: date.getTime(),
        open: numberOrNull(quote.open?.[index]),
        high: numberOrNull(quote.high?.[index]),
        low: numberOrNull(quote.low?.[index]),
        close: numberOrNull(quote.close?.[index]),
        volume: numberOrNull(quote.volume?.[index])
      };
    })
    .filter((candle) => Number.isFinite(candle.close))
    .sort((a, b) => a.time - b.time);

  return dropIncompleteCandles(candles, interval);
}

export async function fetchExecutionPrice(symbol, afterDate) {
  const period2 = Math.floor(Date.now() / 1000) + DAY_MS / 1000;
  const period1 = Math.floor((Date.now() - 7 * DAY_MS) / 1000);
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  );
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", "1m");
  url.searchParams.set("events", "history");
  url.searchParams.set("includePrePost", "false");

  const response = await fetchJson(url);
  const result = response?.chart?.result?.[0];
  const error = response?.chart?.error;
  if (error) throw new Error(error.description || error.code || "Yahoo intraday chart error");
  if (!result) throw new Error("Yahoo intraday chart returned no data");

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const candidates = timestamps
    .map((timestamp, index) => {
      const date = new Date(timestamp * 1000);
      const ist = istParts(date);
      return {
        date: ist.ymd,
        time: date.getTime(),
        minutes: ist.minutes,
        open: numberOrNull(quote.open?.[index]),
        high: numberOrNull(quote.high?.[index]),
        low: numberOrNull(quote.low?.[index]),
        close: numberOrNull(quote.close?.[index])
      };
    })
    .filter((candle) => Number.isFinite(candle.open));

  const candle = selectNextTradingSessionExecutionCandle(candidates, afterDate);
  if (!candle) return null;
  const actualTimeLabel = minuteLabel(candle.minutes);
  const exact = candle.minutes === 9 * 60 + 17;
  return {
    date: candle.date,
    time: candle.time,
    price: candle.open,
    timeLabel: "09:17 IST",
    actualTimeLabel: `${actualTimeLabel} IST`,
    source: exact
      ? "09:17 one-minute candle open"
      : `09:17 market order; first actual traded candle at ${actualTimeLabel} IST`,
    window: exact ? "09:17 IST" : `09:17 order / ${actualTimeLabel} actual fill`,
    candle
  };
}

export function selectNextTradingSessionExecutionCandle(candles, afterDate) {
  const eligible = [...(candles || [])]
    .filter((candle) => candle.date > String(afterDate || "") && Number.isFinite(candle.open))
    .sort((a, b) => a.time - b.time);
  const nextSessionDate = eligible[0]?.date;
  if (!nextSessionDate) return null;
  return eligible.find((candle) =>
    candle.date === nextSessionDate &&
    candle.minutes >= 9 * 60 + 17 &&
    candle.minutes <= 9 * 60 + 30
  ) || null;
}

function minuteLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Compatibility aliases for callers that have not yet adopted the clearer execution naming.
export const fetchOpeningWindowPrice = fetchExecutionPrice;
export const selectNextTradingSessionOpeningCandle = selectNextTradingSessionExecutionCandle;

export function aggregateDailyToCompletedWeeks(candles, now = new Date()) {
  const nowParts = istParts(now);
  const currentWeekStart = weekStartYmd(nowParts.ymd);
  const currentWeekClosed =
    nowParts.weekday === 0 ||
    nowParts.weekday === 6 ||
    (nowParts.weekday === 5 && nowParts.minutes >= 16 * 60);
  const groups = new Map();

  for (const candle of candles || []) {
    const weekStart = weekStartYmd(candle.date);
    if (weekStart === currentWeekStart && !currentWeekClosed) continue;
    if (!groups.has(weekStart)) {
      groups.set(weekStart, {
        date: weekStart,
        time: new Date(`${weekStart}T00:00:00Z`).getTime(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume) || 0
      });
      continue;
    }

    const weekly = groups.get(weekStart);
    if (Number.isFinite(candle.high)) {
      weekly.high = Number.isFinite(weekly.high) ? Math.max(weekly.high, candle.high) : candle.high;
    }
    if (Number.isFinite(candle.low)) {
      weekly.low = Number.isFinite(weekly.low) ? Math.min(weekly.low, candle.low) : candle.low;
    }
    if (Number.isFinite(candle.close)) weekly.close = candle.close;
    if (Number.isFinite(candle.volume)) weekly.volume += candle.volume;
  }

  return [...groups.values()].sort((a, b) => a.time - b.time);
}

export async function fetchFundamentalTimeSeries(symbol) {
  const period2 = Math.floor(Date.now() / 1000) + DAY_MS / 1000;
  const period1 = Math.floor(new Date("2016-01-01T00:00:00Z").getTime() / 1000);
  const url = new URL(
    `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`
  );
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("type", FUNDAMENTAL_TYPES.join(","));
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));

  const response = await fetchJson(url);
  const error = response?.timeseries?.error;
  if (error) throw new Error(error.description || error.code || "Yahoo fundamentals error");
  return response?.timeseries?.result || [];
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchJson(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json,text/plain,*/*"
        }
      });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts) {
        const error = new Error(`Yahoo request failed ${response.status} ${response.statusText}`);
        error.retryable = retryable;
        throw error;
      }
      lastError = new Error(`Yahoo request failed ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) throw error;
      if (attempt === attempts) break;
    } finally {
      clearTimeout(timer);
    }
    await delay(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
  }
  throw lastError || new Error("Yahoo request failed");
}

function dropIncompleteCandles(candles, interval) {
  if (candles.length === 0) return candles;
  const latest = candles[candles.length - 1];
  const now = istParts(new Date());

  if (interval === "1d" && latest.date === now.ymd && !isAfterDailyClose(now)) {
    return candles.slice(0, -1);
  }

  if (interval === "1wk") {
    const currentWeekStart = weekStartYmd(now.ymd);
    const latestWeekStart = weekStartYmd(latest.date);
    if (currentWeekStart === latestWeekStart && !isAfterWeeklyClose(now)) {
      return candles.slice(0, -1);
    }
  }

  return candles;
}

function istParts(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const day = ist.getUTCDate();
  const weekday = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return {
    year,
    month,
    day,
    weekday,
    minutes,
    ymd: [
      year,
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-")
  };
}

function isAfterDailyClose(parts) {
  if (parts.weekday === 0 || parts.weekday === 6) return true;
  return parts.minutes >= 16 * 60;
}

function isAfterWeeklyClose(parts) {
  if (parts.weekday === 0 || parts.weekday === 6) return true;
  if (parts.weekday > 5) return true;
  return parts.weekday === 5 && parts.minutes >= 16 * 60;
}

function weekStartYmd(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  const monday = new Date(date.getTime() - (weekday - 1) * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
