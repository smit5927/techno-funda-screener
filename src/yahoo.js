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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json,text/plain,*/*"
    }
  });
  if (!response.ok) {
    throw new Error(`Yahoo request failed ${response.status} ${response.statusText}`);
  }
  return response.json();
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
