import { appConfig } from "./config.js";
import { readFundamentalsCache, saveFundamentalsCache } from "./storage.js";
import { fetchFundamentalTimeSeries } from "./yahoo.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createFundamentalsService(config = appConfig) {
  const cache = readFundamentalsCache();
  let changed = false;

  return {
    async get(symbol, candles) {
      if (!config.fundamentals.enabled) return emptyFundamentals("disabled");

      const cached = cache[symbol];
      if (cached && isFresh(cached.updatedAt, config.fundamentals.cacheDays)) {
        return { ...cached.value, cacheHit: true };
      }

      try {
        const series = await fetchFundamentalTimeSeries(symbol);
        const value = analyseFundamentals(series, candles);
        cache[symbol] = {
          updatedAt: new Date().toISOString(),
          value
        };
        changed = true;
        return { ...value, cacheHit: false };
      } catch (error) {
        return emptyFundamentals(error.message || "fundamentals unavailable");
      }
    },
    save() {
      if (changed) saveFundamentalsCache(cache);
    }
  };
}

export function analyseFundamentals(series, candles) {
  const data = normalizeTimeSeries(series);
  const annual = mergeStatements(data, "annual");
  const quarterly = mergeStatements(data, "quarterly");

  const latestAnnual = annual[0];
  const previousAnnual = annual[1];
  const latestQuarter = quarterly[0];
  const previousQuarter = quarterly[1];
  const sameQuarterLastYear = quarterly[4];

  const netIncomeYoYUp = compareMetric(latestAnnual, previousAnnual, ["netIncome"]);
  const operatingIncomeYoYUp = compareMetric(latestAnnual, previousAnnual, [
    "operatingIncome"
  ]);
  const revenueQuarterYoYUp = compareMetric(latestQuarter, sameQuarterLastYear, ["totalRevenue"]);
  const epsQuarterYoYUp = compareMetric(latestQuarter, sameQuarterLastYear, ["dilutedEPS", "basicEPS"]);
  const ebitdaQuarterYoYUp = compareMetric(latestQuarter, sameQuarterLastYear, ["ebitda"]);
  const ebitdaMarginQoQUp = compareMargin(latestQuarter, previousQuarter);
  const ebitdaMarginYoYUp = compareMargin(latestQuarter, sameQuarterLastYear);
  const peCheck = calculatePeTrend(annual, candles, data);

  const checks = {
    netIncomeYoYUp,
    operatingIncomeYoYUp,
    revenueQuarterYoYUp,
    epsQuarterYoYUp,
    ebitdaQuarterYoYUp,
    ebitdaMarginQoQUp,
    ebitdaMarginYoYUp,
    peRising: peCheck
  };

  const score = Object.values(checks).filter((check) => check.ok === true).length;

  return {
    available: true,
    score,
    maxScore: Object.keys(checks).length,
    currentPe: latestSeriesValue(data.trailingPeRatio),
    ebitdaMargin: ebitdaMargin(latestQuarter),
    checks
  };
}

export function emptyFundamentals(reason) {
  return {
    available: false,
    reason,
    score: 0,
    maxScore: 8,
    checks: {
      netIncomeYoYUp: unknownCheck(),
      operatingIncomeYoYUp: unknownCheck(),
      revenueQuarterYoYUp: unknownCheck(),
      epsQuarterYoYUp: unknownCheck(),
      ebitdaQuarterYoYUp: unknownCheck(),
      ebitdaMarginQoQUp: unknownCheck(),
      ebitdaMarginYoYUp: unknownCheck(),
      peRising: unknownCheck()
    }
  };
}

function unknownCheck() {
  return { ok: null, latest: null, previous: null };
}

function compareMetric(latest, previous, keys) {
  const latestValue = firstNumber(latest, keys);
  const previousValue = firstNumber(previous, keys);
  if (!Number.isFinite(latestValue) || !Number.isFinite(previousValue)) return unknownCheck();
  return {
    ok: latestValue > previousValue,
    latest: latestValue,
    previous: previousValue
  };
}

function compareMargin(latest, previous) {
  const latestMargin = ebitdaMargin(latest);
  const previousMargin = ebitdaMargin(previous);
  if (!Number.isFinite(latestMargin) || !Number.isFinite(previousMargin)) return unknownCheck();
  return {
    ok: latestMargin > previousMargin,
    latest: latestMargin,
    previous: previousMargin
  };
}

function calculatePeTrend(annual, candles, data) {
  const latest = annual.find((statement) => Number.isFinite(firstNumber(statement, ["dilutedEPS", "basicEPS"])));
  const previous = annual
    .slice(annual.indexOf(latest) + 1)
    .find((statement) => Number.isFinite(firstNumber(statement, ["dilutedEPS", "basicEPS"])));

  if (!latest || !previous) {
    const trailingPe = latestSeriesValue(data.trailingPeRatio);
    return Number.isFinite(trailingPe)
      ? { ok: null, latest: trailingPe, previous: null }
      : unknownCheck();
  }

  const latestPe = peAtStatement(latest, candles);
  const previousPe = peAtStatement(previous, candles);
  if (!Number.isFinite(latestPe) || !Number.isFinite(previousPe)) return unknownCheck();

  return {
    ok: latestPe > previousPe,
    latest: latestPe,
    previous: previousPe
  };
}

function peAtStatement(statement, candles) {
  const eps = firstNumber(statement, ["dilutedEPS", "basicEPS"]);
  if (!Number.isFinite(eps) || eps <= 0) return null;
  const close = closeAtOrBefore(candles, statement.endDate);
  return Number.isFinite(close) ? close / eps : null;
}

function closeAtOrBefore(candles, dateValue) {
  const target = new Date(dateValue).getTime();
  if (!Number.isFinite(target)) return null;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (candles[index].time <= target + DAY_MS) return candles[index].close;
  }
  return null;
}

function ebitdaMargin(statement) {
  const ebitda = firstNumber(statement, ["ebitda"]);
  const revenue = firstNumber(statement, ["totalRevenue"]);
  if (!Number.isFinite(ebitda) || !Number.isFinite(revenue) || revenue === 0) return null;
  return ebitda / revenue;
}

function firstNumber(object, keys) {
  for (const key of keys) {
    const value = rawNumber(object?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function rawNumber(value) {
  if (Number.isFinite(value)) return Number(value);
  if (Number.isFinite(value?.raw)) return Number(value.raw);
  if (Number.isFinite(value?.reportedValue?.raw)) return Number(value.reportedValue.raw);
  return null;
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (Number.isFinite(value?.raw)) return new Date(value.raw * 1000).toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeTimeSeries(series) {
  const output = {};
  for (const item of series || []) {
    const type = item?.meta?.type?.[0];
    if (!type || !Array.isArray(item[type])) continue;
    output[type] = item[type]
      .map((point) => ({
        endDate: normalizeDate(point.asOfDate),
        value: rawNumber(point)
      }))
      .filter((point) => point.endDate && Number.isFinite(point.value))
      .sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime());
  }
  return output;
}

function mergeStatements(data, period) {
  const prefix = period === "annual" ? "annual" : "quarterly";
  const fieldMap = {
    [`${prefix}NetIncome`]: "netIncome",
    [`${prefix}OperatingIncome`]: "operatingIncome",
    [`${prefix}NormalizedEBITDA`]: "ebitda",
    [`${prefix}TotalRevenue`]: "totalRevenue",
    [`${prefix}BasicEPS`]: "basicEPS",
    [`${prefix}DilutedEPS`]: "dilutedEPS"
  };
  const byDate = new Map();

  for (const [seriesName, fieldName] of Object.entries(fieldMap)) {
    for (const point of data[seriesName] || []) {
      if (!byDate.has(point.endDate)) byDate.set(point.endDate, { endDate: point.endDate });
      byDate.get(point.endDate)[fieldName] = point.value;
    }
  }

  return [...byDate.values()].sort(
    (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime()
  );
}

function latestSeriesValue(series) {
  return Array.isArray(series) && series.length > 0 ? series[0].value : null;
}

function isFresh(updatedAt, cacheDays) {
  if (cacheDays <= 0) return false;
  const updated = new Date(updatedAt).getTime();
  if (!Number.isFinite(updated)) return false;
  return Date.now() - updated < cacheDays * DAY_MS;
}
