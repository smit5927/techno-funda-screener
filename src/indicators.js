const DAY_MS = 24 * 60 * 60 * 1000;

export function calculateRsi(candles, length = 14) {
  const output = Array(candles.length).fill(null);
  if (candles.length <= length) return output;

  let gainSum = 0;
  let lossSum = 0;

  for (let index = 1; index <= length; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let averageGain = gainSum / length;
  let averageLoss = lossSum / length;
  output[length] = rsiFromAverages(averageGain, averageLoss);

  for (let index = length + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (length - 1) + gain) / length;
    averageLoss = (averageLoss * (length - 1) + loss) / length;
    output[index] = rsiFromAverages(averageGain, averageLoss);
  }

  return output;
}

export function calculateRelativeStrength(stockCandles, benchmarkCandles, period) {
  const aligned = alignWithBenchmark(stockCandles, benchmarkCandles);
  const output = Array(aligned.length).fill(null);

  for (let index = period; index < aligned.length; index += 1) {
    const current = aligned[index];
    const previous = aligned[index - period];
    if (!current?.benchmarkClose || !previous?.benchmarkClose) continue;
    if (!current.close || !previous.close) continue;

    const stockReturn = current.close / previous.close;
    const benchmarkReturn = current.benchmarkClose / previous.benchmarkClose;
    if (!Number.isFinite(stockReturn) || !Number.isFinite(benchmarkReturn)) continue;
    output[index] = stockReturn / benchmarkReturn - 1;
  }

  return output;
}

export function calculateSupertrend(candles, length = 10, multiplier = 3) {
  const output = Array(candles.length).fill(null);
  const atr = calculateAtr(candles, length);
  const finalUpper = Array(candles.length).fill(null);
  const finalLower = Array(candles.length).fill(null);

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const atrValue = atr[index];
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || !Number.isFinite(atrValue)) {
      continue;
    }

    const hl2 = (candle.high + candle.low) / 2;
    const basicUpper = hl2 + multiplier * atrValue;
    const basicLower = hl2 - multiplier * atrValue;
    const previousUpper = finalUpper[index - 1];
    const previousLower = finalLower[index - 1];
    const previousClose = candles[index - 1]?.close;

    finalUpper[index] =
      !Number.isFinite(previousUpper) ||
      basicUpper < previousUpper ||
      previousClose > previousUpper
        ? basicUpper
        : previousUpper;
    finalLower[index] =
      !Number.isFinite(previousLower) ||
      basicLower > previousLower ||
      previousClose < previousLower
        ? basicLower
        : previousLower;

    const previousSupertrend = output[index - 1];
    if (!Number.isFinite(previousSupertrend)) {
      output[index] = candle.close >= finalUpper[index] ? finalLower[index] : finalUpper[index];
    } else if (previousSupertrend === previousUpper) {
      output[index] = candle.close <= finalUpper[index] ? finalUpper[index] : finalLower[index];
    } else {
      output[index] = candle.close >= finalLower[index] ? finalLower[index] : finalUpper[index];
    }
  }

  return output;
}

export function calculateAtr(candles, length = 10) {
  const output = Array(candles.length).fill(null);
  if (candles.length <= length) return output;

  const trueRanges = candles.map((candle, index) => {
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) return null;
    if (index === 0 || !Number.isFinite(candles[index - 1]?.close)) {
      return candle.high - candle.low;
    }
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });

  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    if (!Number.isFinite(trueRanges[index])) return output;
    sum += trueRanges[index];
  }

  let atr = sum / length;
  output[length - 1] = atr;

  for (let index = length; index < candles.length; index += 1) {
    if (!Number.isFinite(trueRanges[index])) continue;
    atr = (atr * (length - 1) + trueRanges[index]) / length;
    output[index] = atr;
  }

  return output;
}

export function simpleMovingAverage(candles, period) {
  const output = Array(candles.length).fill(null);
  let sum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close;
    if (index >= period) sum -= candles[index - period].close;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

export function exponentialMovingAverage(candles, period) {
  const output = Array(candles.length).fill(null);
  if (candles.length < period || period < 1) return output;
  let seed = 0;
  for (let index = 0; index < period; index += 1) seed += candles[index].close;
  let value = seed / period;
  output[period - 1] = value;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < candles.length; index += 1) {
    value = (candles[index].close - value) * multiplier + value;
    output[index] = value;
  }
  return output;
}

export function calculateMacd(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = exponentialMovingAverage(candles, fastPeriod);
  const slow = exponentialMovingAverage(candles, slowPeriod);
  const macd = candles.map((_, index) =>
    Number.isFinite(fast[index]) && Number.isFinite(slow[index])
      ? fast[index] - slow[index]
      : null
  );
  const signal = emaValues(macd, signalPeriod);
  const histogram = macd.map((value, index) =>
    Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null
  );
  return { macd, signal, histogram };
}

export function calculateObv(candles) {
  const output = Array(candles.length).fill(null);
  if (!candles.length) return output;
  output[0] = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const volume = Number(candles[index].volume) || 0;
    const direction = Math.sign(candles[index].close - candles[index - 1].close);
    output[index] = output[index - 1] + direction * volume;
  }
  return output;
}

export function latestValue(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function latestIndex(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return index;
  }
  return -1;
}

export function priceAboveSma(candles, period) {
  const sma = simpleMovingAverage(candles, period);
  const index = latestIndex(sma);
  if (index < 0) return null;
  return candles[index].close > sma[index];
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function emaValues(values, period) {
  const output = Array(values.length).fill(null);
  const finiteIndexes = [];
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(values[index])) finiteIndexes.push(index);
    if (finiteIndexes.length < period) continue;
    if (finiteIndexes.length === period) {
      output[index] = finiteIndexes.reduce((sum, valueIndex) => sum + values[valueIndex], 0) / period;
      continue;
    }
    const previousIndex = finiteIndexes[finiteIndexes.length - 2];
    output[index] = (values[index] - output[previousIndex]) * (2 / (period + 1)) + output[previousIndex];
  }
  return output;
}

function alignWithBenchmark(stockCandles, benchmarkCandles) {
  const sortedBenchmark = [...benchmarkCandles].sort((a, b) => a.time - b.time);
  let benchmarkIndex = 0;
  let latestBenchmark = null;

  return [...stockCandles]
    .sort((a, b) => a.time - b.time)
    .map((stockCandle) => {
      while (
        benchmarkIndex < sortedBenchmark.length &&
        sortedBenchmark[benchmarkIndex].time <= stockCandle.time + DAY_MS / 2
      ) {
        latestBenchmark = sortedBenchmark[benchmarkIndex];
        benchmarkIndex += 1;
      }

      return {
        ...stockCandle,
        benchmarkClose: latestBenchmark?.close ?? null
      };
    });
}
