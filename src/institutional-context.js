import {
  calculateAtr,
  calculateRelativeStrength,
  calculateRsi,
  latestValue,
  simpleMovingAverage
} from "./indicators.js";
import { parseCsv } from "./csv.js";
import { fetchCandles } from "./yahoo.js";

const DEFAULT_INDEX_SYMBOLS = [
  { id: "nifty500", label: "NIFTY 500", symbol: "^CRSLDX", primary: true },
  { id: "nifty50", label: "NIFTY 50", symbol: "^NSEI" },
  { id: "banknifty", label: "BANK NIFTY", symbol: "^NSEBANK" }
];

const DEFAULT_COMMODITY_SYMBOLS = [
  { id: "gold", label: "Gold", symbol: "GC=F", group: "precious_metals" },
  { id: "silver", label: "Silver", symbol: "SI=F", group: "precious_metals" },
  { id: "copper", label: "Copper", symbol: "HG=F", group: "base_metals" },
  { id: "crude", label: "Crude Oil", symbol: "CL=F", group: "energy" },
  { id: "usdinr", label: "USD/INR", symbol: "INR=X", group: "currency" }
];

const DEFAULT_OPTION_CHAIN_SYMBOLS = ["NIFTY", "BANKNIFTY"];
const DEFAULT_FNO_LOTS_URL = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv";
const DEFAULT_OI_SPURTS_URL = "https://www.nseindia.com/api/live-analysis-oi-spurts-underlyings";

export async function buildInstitutionalContext(config, benchmarkDaily, marketContext) {
  const rules = config.rules?.institutionalContext || {};
  if (rules.enabled === false) {
    return {
      generatedAt: new Date().toISOString(),
      enabled: false,
      index: emptyLayer("Index context disabled"),
      derivatives: emptyDerivativesLayer("Derivatives context disabled"),
      options: emptyLayer("Option-chain context disabled"),
      commodity: emptyLayer("Commodity context disabled"),
      fnoBySymbol: new Map(),
      oiBySymbol: new Map()
    };
  }

  const [index, commodity, derivatives, options] = await Promise.all([
    buildIndexLayer(rules, benchmarkDaily, marketContext),
    buildCommodityLayer(rules),
    buildDerivativesLayer(rules),
    buildOptionsLayer(rules)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    enabled: true,
    index,
    derivatives: derivatives.summary,
    options,
    commodity,
    fnoBySymbol: derivatives.fnoBySymbol,
    oiBySymbol: derivatives.oiBySymbol
  };
}

export function institutionalContextForPayload(context) {
  const { fnoBySymbol, oiBySymbol, ...payload } = context || {};
  return payload;
}

export function buildSymbolInstitutionalContext(item, marketContext) {
  const symbol = normalizeSymbol(item.symbol);
  const fno = marketContext?.fnoBySymbol?.get(symbol) || null;
  const oi = marketContext?.oiBySymbol?.get(symbol) || null;
  const sectorLink = inferSectorProxy(item.industry);
  const index = buildSymbolIndexLayer(item, marketContext?.index, sectorLink);
  const commodity = buildSymbolCommodityLayer(sectorLink, marketContext?.commodity);
  const options = buildSymbolOptionsLayer(marketContext?.options, sectorLink);
  const derivatives = {
    dataAvailable: marketContext?.derivatives?.dataAvailable === true,
    fnoEligible: Boolean(fno),
    oiAvailable: Boolean(oi),
    oiChangePct: oi?.changeInOiPct ?? null,
    oiVolume: oi?.volume ?? null,
    optionValue: oi?.optValue ?? null,
    futureValue: oi?.futValue ?? null,
    participation: Boolean(oi && Number(oi.changeInOiPct) > 0),
    lotSize: fno?.lotSize ?? null,
    underlying: fno?.underlying || "",
    reason: fno
      ? `F&O listed with lot size ${fno.lotSize || "NA"}; ${
          oi
            ? `OI participation ${fmt(oi.changeInOiPct)}%, volume ${fmt(oi.volume)}.`
            : "OI spurt snapshot not available for this symbol."
        }`
      : marketContext?.derivatives?.dataAvailable
        ? "Not present in NSE F&O lot-size master; treat as cash-equity only."
        : "F&O lot-size master unavailable in this scan."
  };
  const score = [
    index.supportsLongs,
    derivatives.fnoEligible,
    options.supportsLongs,
    commodity.supportsSector
  ].filter(Boolean).length;
  const dataGaps = [
    !index.dataAvailable,
    !derivatives.dataAvailable,
    !options.dataAvailable,
    !commodity.dataAvailable
  ].filter(Boolean).length;

  return {
    score,
    maxScore: 4,
    grade: score >= 4 ? "Institutional A" : score >= 3 ? "Institutional B" : score >= 2 ? "Institutional C" : "Context weak",
    dataGaps,
    index,
    derivatives,
    options,
    commodity
  };
}

export function buildInstitutionalReasons(context) {
  if (!context) return [];
  return [
    `Index context: ${context.index.reason}`,
    `Derivatives context: ${context.derivatives.reason}`,
    `Options context: ${context.options.reason}`,
    `Commodity/currency context: ${context.commodity.reason}`,
    `Institutional confluence score ${context.score}/${context.maxScore} (${context.grade}).`
  ];
}

async function buildIndexLayer(rules, benchmarkDaily, marketContext) {
  const symbols = rules.indexSymbols || DEFAULT_INDEX_SYMBOLS;
  const contexts = await Promise.all(symbols.map((item) => safeInstrumentContext(item, benchmarkDaily)));
  const valid = contexts.filter((item) => item.dataAvailable);
  const primary =
    valid.find((item) => item.primary) ||
    valid.find((item) => item.id === "nifty500") ||
    valid[0] ||
    null;
  const bullish = valid.filter((item) => item.bias === "BULLISH").length;
  const bearish = valid.filter((item) => item.bias === "BEARISH").length;
  const supportsLongs =
    marketContext?.strong === true ||
    primary?.bias === "BULLISH" ||
    (valid.length > 0 && bullish >= bearish && primary?.bias !== "BEARISH");

  return {
    dataAvailable: valid.length > 0,
    supportsLongs,
    primaryId: primary?.id || "",
    primaryLabel: primary?.label || "",
    primaryBias: primary?.bias || "UNKNOWN",
    bullish,
    bearish,
    total: contexts.length,
    contexts,
    reason: primary
      ? `${primary.label} is ${primary.bias}; ${bullish}/${valid.length} tracked indices are bullish.`
      : "Index proxy candles unavailable."
  };
}

async function buildCommodityLayer(rules) {
  const symbols = rules.commoditySymbols || DEFAULT_COMMODITY_SYMBOLS;
  const contexts = await Promise.all(symbols.map((item) => safeInstrumentContext(item)));
  const valid = contexts.filter((item) => item.dataAvailable);
  const bullish = valid.filter((item) => item.bias === "BULLISH").length;
  const bearish = valid.filter((item) => item.bias === "BEARISH").length;
  const byGroup = Object.fromEntries(valid.map((item) => [item.group || item.id, item]));

  return {
    dataAvailable: valid.length > 0,
    riskMode: bullish >= bearish ? "RISK_ON_OR_NEUTRAL" : "COMMODITY_RISK",
    bullish,
    bearish,
    total: contexts.length,
    contexts,
    byGroup,
    reason:
      valid.length > 0
        ? `${bullish}/${valid.length} commodity/currency proxies are bullish; ${bearish} bearish.`
        : "Commodity/currency proxy candles unavailable."
  };
}

async function buildDerivativesLayer(rules) {
  const url = rules.fnoLotSizeUrl || DEFAULT_FNO_LOTS_URL;
  const oiUrl = rules.oiSpurtsUrl || DEFAULT_OI_SPURTS_URL;
  let fnoBySymbol = new Map();
  let oiBySymbol = new Map();
  let lotReason = "";
  let oiReason = "";

  try {
    const text = await fetchText(url, {
      Referer: "https://www.nseindia.com/",
      Accept: "text/csv,*/*"
    });
    const rows = parseCsv(text);
    for (const record of rows) {
      const symbol = normalizeSymbol(record.symbol);
      if (!symbol) continue;
      const lotSize = firstNumericValue(record);
      fnoBySymbol.set(symbol, {
        symbol,
        underlying: String(record.underlying || "").trim(),
        lotSize
      });
    }
    lotReason = `NSE F&O lot-size master loaded with ${fnoBySymbol.size} symbols.`;
  } catch (error) {
    lotReason = `F&O lot-size master unavailable: ${error.message || String(error)}`;
  }

  try {
    const data = await fetchNseJsonDirect(oiUrl, {
      Referer: "https://www.nseindia.com/market-data/oi-spurts"
    });
    for (const row of data?.data || []) {
      const symbol = normalizeSymbol(row.symbol);
      if (!symbol) continue;
      oiBySymbol.set(symbol, {
        symbol,
        latestOi: numberOrNull(row.latestOI),
        previousOi: numberOrNull(row.prevOI),
        changeInOi: numberOrNull(row.changeInOI),
        changeInOiPct: numberOrNull(row.avgInOI),
        volume: numberOrNull(row.volume),
        futValue: numberOrNull(row.futValue),
        optValue: numberOrNull(row.optValue),
        totalValue: numberOrNull(row.total)
      });
    }
    oiReason = `NSE OI-spurts snapshot loaded with ${oiBySymbol.size} underlyings.`;
  } catch (error) {
    oiReason = `OI-spurts snapshot unavailable: ${error.message || String(error)}`;
  }

  const dataAvailable = fnoBySymbol.size > 0 || oiBySymbol.size > 0;
  return {
    fnoBySymbol,
    oiBySymbol,
    summary: {
      dataAvailable,
      source: url,
      oiSource: oiUrl,
      fnoSymbolCount: fnoBySymbol.size,
      oiSymbolCount: oiBySymbol.size,
      reason: `${lotReason} ${oiReason}`.trim()
    }
  };
}

async function buildOptionsLayer(rules) {
  if (rules.optionChainEnabled === false) return emptyLayer("Option-chain context disabled");
  const symbols = rules.optionChainSymbols || DEFAULT_OPTION_CHAIN_SYMBOLS;
  const chains = await Promise.all(symbols.map((symbol) => safeOptionChain(symbol)));
  const valid = chains.filter((item) => item.dataAvailable);
  const bullish = valid.filter((item) => item.bias === "BULLISH").length;
  const bearish = valid.filter((item) => item.bias === "BEARISH").length;

  return {
    dataAvailable: valid.length > 0,
    supportsLongs: valid.length > 0 && bullish >= bearish,
    bullish,
    bearish,
    total: chains.length,
    chains,
    reason:
      valid.length > 0
        ? `${bullish}/${valid.length} option-chain snapshots support longs; ${bearish} bearish.`
        : "NSE option-chain snapshot unavailable; mark this as data gap, not as bearish."
  };
}

async function safeInstrumentContext(item, benchmarkDaily = null) {
  try {
    const candles = await fetchCandles(item.symbol, "1d", 2);
    return instrumentContext(item, candles, benchmarkDaily);
  } catch (error) {
    return {
      id: item.id,
      label: item.label,
      symbol: item.symbol,
      group: item.group || "",
      primary: Boolean(item.primary),
      dataAvailable: false,
      bias: "UNKNOWN",
      reason: error.message || String(error)
    };
  }
}

function instrumentContext(item, candles, benchmarkDaily) {
  const latest = candles[candles.length - 1] || {};
  const rsi = latestValue(calculateRsi(candles, 14));
  const sma50 = latestValue(simpleMovingAverage(candles, 50));
  const sma200 = latestValue(simpleMovingAverage(candles, 200));
  const atr = latestValue(calculateAtr(candles, 14));
  const close = latest.close;
  const rs55 = benchmarkDaily ? latestValue(calculateRelativeStrength(candles, benchmarkDaily, 55)) : null;
  const ret21 = trailingReturn(candles, 21);
  const ret55 = trailingReturn(candles, 55);
  const above50 = Number.isFinite(close) && Number.isFinite(sma50) && close > sma50;
  const above200 = Number.isFinite(close) && Number.isFinite(sma200) && close > sma200;
  const fastAboveSlow = Number.isFinite(sma50) && Number.isFinite(sma200) && sma50 > sma200;
  const bullish = rsi > 50 && above50 && (above200 || fastAboveSlow);
  const bearish = rsi < 45 && !above50 && !above200;
  const bias = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";

  return {
    id: item.id,
    label: item.label,
    symbol: item.symbol,
    group: item.group || "",
    primary: Boolean(item.primary),
    dataAvailable: true,
    asOf: latest.date || "",
    close,
    rsi,
    sma50,
    sma200,
    atrPct: Number.isFinite(atr) && Number.isFinite(close) && close !== 0 ? (atr / close) * 100 : null,
    ret21,
    ret55,
    rs55,
    above50,
    above200,
    fastAboveSlow,
    bias,
    reason: `${item.label} ${bias}: RSI ${fmt(rsi)}, 21D ${fmtPct(ret21)}, 55D ${fmtPct(ret55)}.`
  };
}

async function safeOptionChain(symbol) {
  try {
    const data = await fetchNseJson(`https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`);
    return analyzeOptionChain(symbol, data);
  } catch (error) {
    return {
      symbol,
      dataAvailable: false,
      bias: "UNKNOWN",
      reason: error.message || String(error)
    };
  }
}

function analyzeOptionChain(symbol, data) {
  const records = data?.records || {};
  const expiry = records.expiryDates?.[0] || "";
  const underlyingValue = Number(records.underlyingValue);
  const rows = (records.data || []).filter((row) => !expiry || row.expiryDate === expiry);
  let callOi = 0;
  let putOi = 0;
  const callStrikes = [];
  const putStrikes = [];

  for (const row of rows) {
    const ceOi = Number(row.CE?.openInterest);
    const peOi = Number(row.PE?.openInterest);
    if (Number.isFinite(ceOi)) {
      callOi += ceOi;
      callStrikes.push({ strike: Number(row.strikePrice), oi: ceOi });
    }
    if (Number.isFinite(peOi)) {
      putOi += peOi;
      putStrikes.push({ strike: Number(row.strikePrice), oi: peOi });
    }
  }

  const pcr = callOi > 0 ? putOi / callOi : null;
  const maxCall = maxOiStrike(callStrikes);
  const maxPut = maxOiStrike(putStrikes);
  const bias = pcr == null ? "UNKNOWN" : pcr >= 1.1 ? "BULLISH" : pcr <= 0.8 ? "BEARISH" : "NEUTRAL";

  return {
    symbol,
    dataAvailable: rows.length > 0,
    expiry,
    underlyingValue,
    totalCallOi: callOi,
    totalPutOi: putOi,
    pcr,
    maxCallOiStrike: maxCall?.strike ?? null,
    maxPutOiStrike: maxPut?.strike ?? null,
    bias,
    reason: `${symbol} option chain ${bias}: PCR ${fmt(pcr)}, max PE OI ${maxPut?.strike ?? "NA"}, max CE OI ${maxCall?.strike ?? "NA"}.`
  };
}

function buildSymbolIndexLayer(item, indexLayer, sectorLink) {
  const bank = indexLayer?.contexts?.find((context) => context.id === "banknifty");
  const primary = indexLayer?.contexts?.find((context) => context.id === indexLayer.primaryId);
  const sectorProxy =
    sectorLink.indexProxy === "banknifty" && bank?.dataAvailable ? bank : primary;
  const supportsLongs = sectorProxy?.bias !== "BEARISH" && indexLayer?.supportsLongs === true;
  return {
    dataAvailable: indexLayer?.dataAvailable === true,
    supportsLongs,
    primaryBias: indexLayer?.primaryBias || "UNKNOWN",
    sectorProxy: sectorProxy?.label || indexLayer?.primaryLabel || "",
    sectorProxyBias: sectorProxy?.bias || "UNKNOWN",
    reason: sectorProxy
      ? `${sectorProxy.label} proxy is ${sectorProxy.bias}; broad index support is ${indexLayer.supportsLongs ? "positive" : "weak"}.`
      : indexLayer?.reason || "Index context unavailable."
  };
}

function buildSymbolOptionsLayer(optionsLayer, sectorLink) {
  const preferred = sectorLink.indexProxy === "banknifty" ? "BANKNIFTY" : "NIFTY";
  const chain =
    optionsLayer?.chains?.find((item) => item.symbol === preferred && item.dataAvailable) ||
    optionsLayer?.chains?.find((item) => item.dataAvailable);
  const supportsLongs = chain?.bias !== "BEARISH" && optionsLayer?.supportsLongs === true;
  return {
    dataAvailable: optionsLayer?.dataAvailable === true,
    supportsLongs,
    symbol: chain?.symbol || preferred,
    pcr: chain?.pcr ?? null,
    maxPutOiStrike: chain?.maxPutOiStrike ?? null,
    maxCallOiStrike: chain?.maxCallOiStrike ?? null,
    bias: chain?.bias || "UNKNOWN",
    reason: chain?.reason || optionsLayer?.reason || "Option-chain context unavailable."
  };
}

function buildSymbolCommodityLayer(sectorLink, commodityLayer) {
  const context = sectorLink.commodityGroup
    ? commodityLayer?.byGroup?.[sectorLink.commodityGroup] || null
    : null;
  const dataAvailable = commodityLayer?.dataAvailable === true;
  const supportsSector =
    !context || context.bias !== (sectorLink.commodityBearishIsGood ? "BULLISH" : "BEARISH");
  return {
    dataAvailable,
    supportsSector: dataAvailable ? supportsSector : false,
    exposure: sectorLink.commodityLabel || "Broad macro",
    proxy: context?.label || "",
    proxyBias: context?.bias || "UNKNOWN",
    reason: context
      ? `${sectorLink.commodityLabel}: ${context.reason}`
      : commodityLayer?.reason || "Commodity/currency context unavailable."
  };
}

function inferSectorProxy(industry) {
  const text = String(industry || "").toLowerCase();
  if (/bank|financial|finance|nbfc|insurance/.test(text)) {
    return { indexProxy: "banknifty", commodityLabel: "Rate/currency sensitive" };
  }
  if (/metal|mining|steel|copper|aluminium|zinc/.test(text)) {
    return { indexProxy: "nifty500", commodityGroup: "base_metals", commodityLabel: "Base-metal sensitive" };
  }
  if (/oil|gas|energy|power|refiner|petroleum/.test(text)) {
    return { indexProxy: "nifty500", commodityGroup: "energy", commodityLabel: "Energy sensitive" };
  }
  if (/jewel|gold|silver|precious/.test(text)) {
    return { indexProxy: "nifty500", commodityGroup: "precious_metals", commodityLabel: "Precious-metal sensitive" };
  }
  if (/paint|chemical|aviation|tyre|cement/.test(text)) {
    return {
      indexProxy: "nifty500",
      commodityGroup: "energy",
      commodityLabel: "Input-cost sensitive",
      commodityBearishIsGood: true
    };
  }
  if (/information technology|it |software|pharma|export/.test(text)) {
    return { indexProxy: "nifty500", commodityGroup: "currency", commodityLabel: "USD/INR sensitive" };
  }
  return { indexProxy: "nifty500", commodityLabel: "Broad macro" };
}

function emptyLayer(reason) {
  return {
    dataAvailable: false,
    supportsLongs: false,
    bullish: 0,
    bearish: 0,
    total: 0,
    contexts: [],
    chains: [],
    reason
  };
}

function emptyDerivativesLayer(reason) {
  return {
    dataAvailable: false,
    source: "",
    fnoSymbolCount: 0,
    reason
  };
}

async function fetchText(url, headers = {}) {
  const response = await fetchWithTimeout(url, { headers: nseHeaders(headers) });
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchNseJson(url) {
  const landing = await fetchWithTimeout("https://www.nseindia.com/option-chain", {
    headers: nseHeaders({ Accept: "text/html,*/*" })
  });
  const cookie = cookieHeader(landing.headers);
  const response = await fetchWithTimeout(url, {
    headers: nseHeaders({
      Accept: "application/json,text/plain,*/*",
      Referer: "https://www.nseindia.com/option-chain",
      ...(cookie ? { Cookie: cookie } : {})
    })
  });
  if (!response.ok) throw new Error(`NSE option-chain request failed ${response.status}`);
  return response.json();
}

async function fetchNseJsonDirect(url, headers = {}) {
  const response = await fetchWithTimeout(url, {
    headers: nseHeaders({
      Accept: "application/json,text/plain,*/*",
      ...headers
    })
  });
  if (!response.ok) throw new Error(`NSE request failed ${response.status}`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function nseHeaders(headers = {}) {
  return {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.9",
    ...headers
  };
}

function cookieHeader(headers) {
  const raw = headers.get("set-cookie");
  if (!raw) return "";
  return raw
    .split(/,(?=[^;]+?=)/)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function firstNumericValue(record) {
  for (const [key, value] of Object.entries(record)) {
    if (key === "underlying" || key === "symbol") continue;
    const number = Number(String(value || "").trim());
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function maxOiStrike(items) {
  return items
    .filter((item) => Number.isFinite(item.strike) && Number.isFinite(item.oi))
    .sort((a, b) => b.oi - a.oi)[0] || null;
}

function trailingReturn(candles, period) {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 1 - period];
  if (!Number.isFinite(latest?.close) || !Number.isFinite(previous?.close) || previous.close === 0) return null;
  return latest.close / previous.close - 1;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .replace(/\.(NS|BO)$/i, "")
    .trim()
    .toUpperCase();
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "NA";
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "NA";
}
