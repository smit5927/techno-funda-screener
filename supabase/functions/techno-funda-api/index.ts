import { createClient } from "npm:@supabase/supabase-js@2";
import { calculatePositionMtm, summarizeLivePositions } from "./live-mtm.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

type JsonRecord = Record<string, unknown>;

const LIVE_MTM_CACHE_MS = 45_000;
let liveMtmCache: { expiresAt: number; payload: unknown } = { expiresAt: 0, payload: null };

const TRADE_SCOPE_OPTIONS = [
  { id: "all-market", label: "All NSE Market" },
  { id: "default", label: "Nifty 500" },
  { id: "custom", label: "My List" }
];

const TRADE_QUALITY_OPTIONS = [
  { id: "BEST_ONLY", label: "Best only (A+/A)" },
  { id: "STRONG_OR_BETTER", label: "Strong and best (A+/A/B)" },
  { id: "ALL_ENTRIES", label: "All entry signals" }
];

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    if (request.method === "GET") {
      const view = new URL(request.url).searchParams.get("view");
      if (view === "meta") {
        return json(await getPublicMetadata());
      }
      if (view === "live-mtm") {
        return json(await getLiveMtm());
      }
      return json(await getState());
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "get-state");

    if (action === "get-state") {
      return json(await getState());
    }

    if (action === "save-custom-list") {
      const accessCode = String(body.accessCode || "");
      if (!(await verifyCode("access_hash", accessCode))) {
        return json({ error: "Invalid access code" }, 401);
      }

      const symbols = normalizeSymbols(body.symbols);
      await upsertValue("custom_list", {
        symbols,
        updatedAt: new Date().toISOString(),
        source: "website"
      });
      return json({ ok: true, count: symbols.length, symbols });
    }

    if (action === "save-telegram-config") {
      const accessCode = String(body.accessCode || "");
      if (!(await verifyCode("access_hash", accessCode))) {
        return json({ error: "Invalid access code" }, 401);
      }

      const existingConfig = await readValue("telegram_config", {});
      const botToken =
        String(body.botToken || "").trim() ||
        (typeof existingConfig.botToken === "string" ? existingConfig.botToken : "");
      const chatId =
        String(body.chatId || "").trim() ||
        (typeof existingConfig.chatId === "string" ? existingConfig.chatId : "");
      if (!botToken || !chatId) {
        return json({ error: "Bot token and chat ID are required" }, 400);
      }

      const config = {
        botToken,
        chatId,
        enabled: body.enabled !== false,
        updatedAt: new Date().toISOString(),
        source: "website"
      };
      await upsertValue("telegram_config", config);
      return json({
        ok: true,
        telegram: publicTelegramStatus(config)
      });
    }

    if (action === "save-trade-settings") {
      const accessCode = String(body.accessCode || "");
      if (!(await verifyCode("access_hash", accessCode))) {
        return json({ error: "Invalid access code" }, 401);
      }

      const existingSettings = await readValue("trade_settings", {});
      const requestedCapital = Number(body.totalCapital);
      const baseCapital =
        Number.isFinite(requestedCapital) && requestedCapital >= 10000
          ? requestedCapital
          : Number(existingSettings.totalCapital) || 1000000;
      const addCapital = Math.max(0, Number(body.addCapital) || 0);
      const totalCapital = normalizeCapital(baseCapital + addCapital);
      const capitalHistory = Array.isArray(existingSettings.capitalHistory)
        ? existingSettings.capitalHistory.slice(-49)
        : [];
      if (addCapital > 0 || totalCapital !== Number(existingSettings.totalCapital || 1000000)) {
        capitalHistory.push({
          date: new Date().toISOString(),
          type: addCapital > 0 ? "CAPITAL_ADDED" : "CAPITAL_SET",
          amount: addCapital > 0 ? addCapital : Math.abs(totalCapital - Number(existingSettings.totalCapital || 1000000)),
          previousCapital: Number(existingSettings.totalCapital) || 1000000,
          newCapital: totalCapital
        });
      }
      const settings = {
        ...normalizeTradeSettings({ ...existingSettings, ...body, totalCapital }),
        capitalHistory,
        updatedAt: new Date().toISOString(),
        source: "website"
      };
      await upsertValue("trade_settings", settings);
      return json({
        ok: true,
        tradeSettings: publicTradeSettings(settings)
      });
    }

    if (action === "get-custom-list") {
      const internalKey = String(body.internalKey || "");
      if (!(await verifyCode("internal_hash", internalKey))) {
        return json({ error: "Invalid internal key" }, 401);
      }
      const customList = await readValue("custom_list", { symbols: [] });
      return json({ ok: true, symbols: Array.isArray(customList.symbols) ? customList.symbols : [] });
    }

    if (action === "get-telegram-config") {
      const internalKey = String(body.internalKey || "");
      if (!(await verifyCode("internal_hash", internalKey))) {
        return json({ error: "Invalid internal key" }, 401);
      }
      const config = await readValue("telegram_config", {});
      return json({
        ok: true,
        telegram: {
          botToken: typeof config.botToken === "string" ? config.botToken : "",
          chatId: typeof config.chatId === "string" ? config.chatId : "",
          enabled: config.enabled !== false
        }
      });
    }

    if (action === "get-trade-settings") {
      const internalKey = String(body.internalKey || "");
      if (!(await verifyCode("internal_hash", internalKey))) {
        return json({ error: "Invalid internal key" }, 401);
      }
      const settings = await readValue("trade_settings", {});
      return json({
        ok: true,
        tradeSettings: publicTradeSettings(settings)
      });
    }

    if (action === "save-state") {
      const internalKey = String(body.internalKey || "");
      if (!(await verifyCode("internal_hash", internalKey))) {
        return json({ error: "Invalid internal key" }, 401);
      }
      const state = typeof body.state === "object" && body.state ? body.state : {};
      await upsertValue("latest_state", {
        ...(state as JsonRecord),
        cloudUpdatedAt: new Date().toISOString()
      });
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error?.message || String(error) }, 500);
  }
});

async function getState() {
  const [state, customList, telegramConfig, tradeSettings] = await Promise.all([
    readValue("latest_state", null),
    readValue("custom_list", { symbols: [] }),
    readValue("telegram_config", {}),
    readValue("trade_settings", {})
  ]);
  return {
    ok: true,
    state,
    customList: {
      count: Array.isArray(customList.symbols) ? customList.symbols.length : 0,
      updatedAt: customList.updatedAt || null
    },
    telegram: publicTelegramStatus(telegramConfig),
    tradeSettings: publicTradeSettings(tradeSettings)
  };
}

async function getPublicMetadata() {
  const [customList, telegramConfig, tradeSettings] = await Promise.all([
    readValue("custom_list", { symbols: [] }),
    readValue("telegram_config", {}),
    readValue("trade_settings", {})
  ]);
  return {
    ok: true,
    customList: {
      count: Array.isArray(customList.symbols) ? customList.symbols.length : 0,
      updatedAt: customList.updatedAt || null
    },
    telegram: publicTelegramStatus(telegramConfig),
    tradeSettings: publicTradeSettings(tradeSettings)
  };
}

async function getLiveMtm() {
  const now = Date.now();
  if (liveMtmCache.payload && liveMtmCache.expiresAt > now) {
    return liveMtmCache.payload;
  }

  const state = await readValue("latest_state", {});
  const trades = (Array.isArray(state?.trades) ? state.trades : []).filter((trade: any) =>
    ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(String(trade?.status || ""))
  );
  const totalCapital =
    Number(state?.portfolioSummary?.totalCapital) ||
    Number(state?.tradeSettings?.totalCapital) ||
    1000000;

  const symbols = [...new Set(
    trades
      .map((trade: any) => String(trade?.yahooSymbol || `${trade?.symbol || ""}.NS`).trim())
      .filter(Boolean)
  )];
  const rawQuotes = new Map(
    await Promise.all(symbols.map(async (symbol) => [symbol, await fetchNearLiveQuote(symbol)] as const))
  );
  const marketStatus = marketStatusIst([...rawQuotes.values()]);
  const quotes = new Map(
    [...rawQuotes.entries()].map(([symbol, quote]) => [
      symbol,
      {
        ...quote,
        isLive: marketStatus === "OPEN" && isFreshQuote(quote?.asOf)
      }
    ])
  );
  const positions = trades.map((trade: any) => {
    const yahooSymbol = String(trade?.yahooSymbol || `${trade?.symbol || ""}.NS`).trim();
    return calculatePositionMtm(
      { ...trade, yahooSymbol },
      quotes.get(yahooSymbol) || fallbackQuote(trade)
    );
  });
  const payload = {
    ok: true,
    mode: "POSITIONAL_MTM_ONLY",
    entryExitMode: "COMPLETED_CANDLE_EOD",
    generatedAt: new Date().toISOString(),
    source: "Yahoo Finance intraday chart",
    feedType: "FREE_NEAR_LIVE",
    quoteInterval: "1m",
    marketStatus,
    positions,
    summary: summarizeLivePositions(positions, totalCapital)
  };

  liveMtmCache = { expiresAt: now + LIVE_MTM_CACHE_MS, payload };
  return payload;
}

async function fetchNearLiveQuote(symbol: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("range", "1d");
    url.searchParams.set("interval", "1m");
    url.searchParams.set("includePrePost", "false");
    url.searchParams.set("events", "history");
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 Techno-Funda-Positional-MTM/1.0"
      }
    });
    if (!response.ok) throw new Error(`Quote ${symbol} returned ${response.status}`);
    const body = await response.json();
    const result = body?.chart?.result?.[0];
    const previousClose = Number(result?.meta?.chartPreviousClose ?? result?.meta?.previousClose ?? result?.meta?.regularMarketPreviousClose);
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
      ? result.indicators.quote[0].close
      : [];
    for (let index = closes.length - 1; index >= 0; index -= 1) {
      const ltp = Number(closes[index]);
      const timestamp = Number(timestamps[index]);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      return {
        ltp,
        previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
        asOf: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
        isLive: false,
        marketState: String(result?.meta?.marketState || ""),
        source: "Yahoo 1m"
      };
    }
    throw new Error(`Quote ${symbol} has no valid minute close`);
  } catch (error) {
    console.warn(`Near-live quote unavailable for ${symbol}:`, error?.message || String(error));
    return { ltp: null, asOf: null, isLive: false, source: "EOD fallback" };
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackQuote(trade: any) {
  return {
    ltp: Number(trade?.lastPrice) || null,
    asOf: null,
    isLive: false,
    source: "EOD fallback"
  };
}

function marketStatusIst(quotes: any[]) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const tradingDay = !["Sat", "Sun"].includes(parts.weekday);
  const scheduledOpen = tradingDay && minuteOfDay >= 555 && minuteOfDay <= 930;
  if (!scheduledOpen) return "CLOSED";
  const hasFreshRegularQuote = quotes.some((quote) =>
    isFreshQuote(quote?.asOf) && ["", "REGULAR"].includes(String(quote?.marketState || "").toUpperCase())
  );
  return hasFreshRegularQuote ? "OPEN" : "CLOSED";
}

function isFreshQuote(asOf: unknown) {
  const timestamp = Date.parse(String(asOf || ""));
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 10 * 60 * 1000;
}

function publicTelegramStatus(config: any) {
  const configured = Boolean(config?.botToken && config?.chatId && config?.enabled !== false);
  return {
    configured,
    enabled: config?.enabled !== false,
    updatedAt: config?.updatedAt || null
  };
}

function publicTradeSettings(settings: any) {
  const normalized = normalizeTradeSettings(settings);
  return {
    ...normalized,
    updatedAt: settings?.updatedAt || null,
    scopeOptions: TRADE_SCOPE_OPTIONS,
    qualityOptions: TRADE_QUALITY_OPTIONS
  };
}

function normalizeTradeSettings(input: any) {
  const requestedScope = String(input?.scopeListId || input?.tradeScope || "").trim();
  const scope =
    TRADE_SCOPE_OPTIONS.find((option) => option.id === requestedScope) || TRADE_SCOPE_OPTIONS[0];
  const requestedQuality = String(input?.qualityMode || "").trim().toUpperCase();
  const quality =
    TRADE_QUALITY_OPTIONS.find((option) => option.id === requestedQuality) ||
    TRADE_QUALITY_OPTIONS[0];
  return {
    scopeListId: scope.id,
    scopeLabel: scope.label,
    qualityMode: quality.id,
    qualityLabel: quality.label,
    totalCapital: normalizeCapital(input?.totalCapital)
  };
}

function normalizeCapital(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 1000000;
  return Math.round(Math.min(1000000000, Math.max(10000, amount)));
}

async function verifyCode(keyName: string, value: string) {
  if (!value) return false;
  const stored = await readValue(keyName, {});
  const expected = typeof stored.sha256 === "string" ? stored.sha256 : "";
  return expected !== "" && (await sha256(value)) === expected;
}

async function readValue(key: string, fallback: any) {
  const { data, error } = await admin()
    .from("techno_funda_kv")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) throw error;
  return data?.value ?? fallback;
}

async function upsertValue(key: string, value: JsonRecord) {
  const { error } = await admin()
    .from("techno_funda_kv")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

  if (error) throw error;
}

function admin() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredSecretKey(), {
    auth: { persistSession: false }
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function requiredSecretKey() {
  const direct =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SERVICE_ROLE_KEY");
  if (direct) return direct;

  const keysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keysJson) {
    const keys = JSON.parse(keysJson);
    for (const item of Object.values(keys)) {
      const keyName = String(item);
      const envValue = Deno.env.get(keyName);
      if (envValue) return envValue;
      if (keyName.startsWith("sb_secret_")) return keyName;
    }
  }

  throw new Error("Missing Supabase secret/service role key");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeSymbols(input: unknown) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\s,;|]+/);
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const symbol = normalizeSymbol(String(value || ""));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    output.push(symbol);
  }

  return output;
}

function normalizeSymbol(value: string) {
  const raw = value.trim().replace(/["'`]/g, "").toUpperCase();
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "");
  const colon = compact.match(/^([A-Z]{2,8}):([A-Z0-9&._-]+)$/);
  if (colon) {
    const exchange = colon[1];
    const symbol = colon[2].replace(/\.(NS|BO)$/i, "");
    return exchange === "NSE" ? symbol : `${exchange}:${symbol}`;
  }

  const suffix = compact.match(/^([A-Z0-9&_-]+)\.(NS|BO)$/);
  if (suffix) {
    return suffix[2] === "NS" ? suffix[1] : `BSE:${suffix[1]}`;
  }

  return compact.replace(/[^A-Z0-9&_-]/g, "");
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS
  });
}
