export function buildIndianEquityUniverse(nseRecords = [], bseRecords = [], niftyIndustries = new Map()) {
  const rows = [];
  const seenIsins = new Set();
  const seenYahooSymbols = new Set();
  const rowByIsin = new Map();

  for (const record of nseRecords) {
    const symbol = clean(record.symbol);
    if (!symbol) continue;
    const isin = clean(record.isin_number || record.isin);
    const yahooSymbol = `${symbol}.NS`;
    if (seenYahooSymbols.has(yahooSymbol)) continue;
    seenYahooSymbols.add(yahooSymbol);
    if (isin) seenIsins.add(isin);
    const row = {
      symbol,
      name: record.name_of_company || record.name || symbol,
      industry: niftyIndustries.get(symbol) || record.industry || "NSE Equity",
      series: record.series || "",
      isin,
      exchange: "NSE",
      trading_symbol: symbol,
      scrip_code: "",
      search_aliases: uniqueText([symbol, isin]),
      enabled: "true"
    };
    rows.push(row);
    if (isin) rowByIsin.set(isin, row);
  }

  for (const record of bseRecords) {
    if (clean(record.Status || record.status) !== "ACTIVE") continue;
    if (clean(record.Segment || record.segment) !== "EQUITY") continue;
    const code = clean(record.SCRIP_CD || record.scrip_cd || record.scrip_code);
    if (!code) continue;
    const isin = clean(record.ISIN_NUMBER || record.isin_number || record.isin);
    const tradingSymbol = clean(record.scrip_id || record.instrument_code);
    const name = record.Scrip_Name || record.scrip_name || record.Issuer_Name || record.issuer_name || tradingSymbol || code;
    if (isin && seenIsins.has(isin)) {
      const primary = rowByIsin.get(isin);
      if (primary) primary.search_aliases = uniqueText([primary.search_aliases, code, tradingSymbol, name]);
      continue;
    }
    const yahooSymbol = `${code}.BO`;
    if (seenYahooSymbols.has(yahooSymbol)) continue;
    seenYahooSymbols.add(yahooSymbol);
    if (isin) seenIsins.add(isin);
    rows.push({
      symbol: `BSE:${code}`,
      name,
      industry: record.INDUSTRY || record.industry || "BSE Equity",
      series: record.GROUP || record.group || "",
      isin,
      exchange: "BSE",
      trading_symbol: tradingSymbol,
      scrip_code: code,
      search_aliases: uniqueText([code, tradingSymbol, isin, name]),
      enabled: "true"
    });
  }

  return rows.sort((left, right) => left.symbol.localeCompare(right.symbol, "en"));
}

function clean(value) {
  return String(value || "").trim().toUpperCase();
}

function uniqueText(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].join(" ");
}
