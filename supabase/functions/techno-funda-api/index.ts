import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

type JsonRecord = Record<string, unknown>;

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
      if (new URL(request.url).searchParams.get("view") === "meta") {
        return json(await getPublicMetadata());
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

      const botToken = String(body.botToken || "").trim();
      const chatId = String(body.chatId || "").trim();
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

      const settings = {
        ...normalizeTradeSettings(body),
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
    qualityLabel: quality.label
  };
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
