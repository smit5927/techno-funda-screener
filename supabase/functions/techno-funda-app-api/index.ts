import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.4";
import { calculatePositionMtm, summarizeLivePositions } from "./live-mtm.js";
import { sessionActivationUpdates, sessionIsRejected } from "./session-policy.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-device-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store"
};

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ACTIVE_TRADE_STATUSES = new Set(["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"]);

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(request.url);
    if (request.method === "GET") return await handleGet(request, url);
    if (request.method === "POST") return await handlePost(request);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error(error);
    return json({ error: error?.message || String(error) }, Number(error?.status) || 500);
  }
});

async function handleGet(request: Request, url: URL) {
  const context = await requireUser(request, { activeSession: true });
  const view = String(url.searchParams.get("view") || "state");

  if (view === "live-mtm") return json(await liveMtm(context.user.id));
  if (view === "meta") return json(await metadata(context));
  if (view === "admin-users") {
    requireAdmin(context);
    return json({ ok: true, users: await listUsers() });
  }

  const payload = await userPayload(context);
  return json({ ok: true, ...payload });
}

async function handlePost(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || "");

  if (action === "bootstrap-owner") return json(await bootstrapOwner(body));
  if (action === "login") return json(await passwordLogin(body));
  if (action === "ingest-market-state") return json(await ingestMarketState(body));
  if (action === "get-runtime-users") return json(await runtimeUsers(body));
  if (action === "save-user-state") return json(await saveRuntimeUserState(body));

  const context = await requireUser(request, { activeSession: action !== "activate-session" });

  if (action === "activate-session") return json(await activateSession(context, request));
  if (action === "save-custom-list") return json(await saveCustomList(context, body));
  if (action === "save-trade-settings") return json(await saveTradeSettings(context, body));
  if (action === "save-telegram-config") return json(await saveTelegram(context, body));
  if (action === "admin-create-user") {
    requireAdmin(context);
    return json(await createMember(context, body));
  }
  if (action === "admin-update-user") {
    requireAdmin(context);
    return json(await updateMember(context, body));
  }
  if (action === "admin-reset-session") {
    requireAdmin(context);
    return json(await resetMemberSession(context, body));
  }
  if (action === "admin-set-password") {
    requireAdmin(context);
    return json(await setMemberPassword(context, body));
  }
  if (action === "admin-list-users") {
    requireAdmin(context);
    return json({ ok: true, users: await listUsers() });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
}

async function bootstrapOwner(body: any) {
  const bootstrapCode = String(body.bootstrapCode || "");
  if (!(await verifySecret("owner_bootstrap", bootstrapCode, true))) {
    throw httpError("Invalid or already-used setup code", 401);
  }

  const { count, error: countError } = await admin()
    .from("app_profiles")
    .select("user_id", { count: "exact", head: true });
  if (countError) throw countError;
  if ((count || 0) > 0) throw httpError("Owner setup is already complete", 409);

  const input = normalizeNewUser(body, "admin");
  const { data, error } = await admin().auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    app_metadata: { role: "admin" },
    user_metadata: { display_name: input.displayName }
  });
  if (error || !data.user) throw error || new Error("Could not create owner account");

  try {
    await createUserRows(data.user.id, input, null, "admin");
    await admin().from("app_secrets").update({ used_at: new Date().toISOString() }).eq("name", "owner_bootstrap");
    await audit(null, data.user.id, "OWNER_BOOTSTRAPPED", { username: input.username });
  } catch (error) {
    await admin().auth.admin.deleteUser(data.user.id);
    throw error;
  }

  const session = await signIn(input.email, input.password);
  return { ok: true, session, requiresMfa: true };
}

async function passwordLogin(body: any) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  if (!username || !password) throw httpError("Invalid ID or password", 401);

  const { data: profile } = await admin()
    .from("app_profiles")
    .select("user_id, auth_email, status, mfa_required")
    .eq("username", username)
    .maybeSingle();
  if (!profile || profile.status !== "active") throw httpError("Invalid ID or password", 401);

  try {
    const session = await signIn(profile.auth_email, password);
    return { ok: true, session, requiresMfa: profile.mfa_required !== false };
  } catch {
    throw httpError("Invalid ID or password", 401);
  }
}

async function signIn(email: string, password: string) {
  const { data, error } = await publicClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error || new Error("Login did not create a session");
  return data.session;
}

async function activateSession(context: any, request: Request) {
  if (context.profile.mfa_required !== false && context.claims.aal !== "aal2") {
    throw httpError("Authenticator OTP verification is required", 403);
  }
  const sessionId = String(context.claims.session_id || "");
  if (!isUuid(sessionId)) throw httpError("Session identifier is missing", 401);
  const deviceId = context.profile.role === "admin" ? context.deviceId : requireDeviceId(request);

  const now = new Date().toISOString();
  const sessionUpdates = sessionActivationUpdates(context.profile, sessionId, deviceId, now);
  const { error } = await admin()
    .from("app_profiles")
    .update(sessionUpdates)
    .eq("user_id", context.user.id)
    .eq("status", "active");
  if (error) throw error;
  await audit(context.user.id, context.user.id, "SESSION_ACTIVATED", {
    sessionId,
    deviceId: context.profile.role === "admin" ? null : deviceId,
    userAgent: request.headers.get("user-agent") || ""
  });
  return { ok: true, profile: publicProfile({ ...context.profile, ...sessionUpdates }) };
}

async function createMember(context: any, body: any) {
  const input = normalizeNewUser(body, "member");
  const { data, error } = await admin().auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    app_metadata: { role: "member" },
    user_metadata: { display_name: input.displayName }
  });
  if (error || !data.user) throw error || new Error("Could not create user");
  try {
    await createUserRows(data.user.id, input, context.user.id, "member");
    await audit(context.user.id, data.user.id, "USER_CREATED", { username: input.username });
  } catch (error) {
    await admin().auth.admin.deleteUser(data.user.id);
    throw error;
  }
  return { ok: true, userId: data.user.id };
}

async function createUserRows(userId: string, input: any, createdBy: string | null, role: string) {
  const profile = {
    user_id: userId,
    username: input.username,
    auth_email: input.email,
    display_name: input.displayName,
    contact_email: input.email,
    mobile_number: input.mobileNumber || null,
    role,
    status: "active",
    mfa_required: true,
    created_by: createdBy
  };
  const settings = { user_id: userId, ...input.settings };
  const { error } = await admin().from("app_profiles").insert(profile);
  if (error) throw error;
  const results = await Promise.all([
    admin().from("app_user_settings").insert(settings),
    admin().from("app_watchlists").insert({ user_id: userId, symbols: [] }),
    admin().from("app_user_states").insert({ user_id: userId, state: {} })
  ]);
  const failure = results.find((result) => result.error)?.error;
  if (failure) throw failure;
}

async function updateMember(context: any, body: any) {
  const userId = requireUuid(body.userId);
  if (userId === context.user.id && body.status === "suspended") {
    throw httpError("Owner cannot suspend the active owner account", 400);
  }
  const updates: Record<string, unknown> = {};
  if (["active", "suspended"].includes(String(body.status))) updates.status = String(body.status);
  if (typeof body.displayName === "string" && body.displayName.trim()) updates.display_name = body.displayName.trim();
  if (typeof body.mobileNumber === "string") updates.mobile_number = body.mobileNumber.trim() || null;
  if (typeof body.contactEmail === "string" && body.contactEmail.includes("@")) updates.contact_email = body.contactEmail.trim().toLowerCase();
  if (updates.status === "suspended") {
    updates.active_session_id = null;
    updates.active_device_id = null;
  }
  if (Object.keys(updates).length) {
    const { error } = await admin().from("app_profiles").update(updates).eq("user_id", userId);
    if (error) throw error;
  }

  if (body.settings && typeof body.settings === "object") {
    const settings = normalizeSettings(body.settings);
    const { error } = await admin().from("app_user_settings").update(settings).eq("user_id", userId);
    if (error) throw error;
  }
  await audit(context.user.id, userId, "USER_UPDATED", { fields: Object.keys(updates) });
  return { ok: true };
}

async function resetMemberSession(context: any, body: any) {
  const userId = requireUuid(body.userId);
  const { error } = await admin().from("app_profiles").update({ active_session_id: null, active_device_id: null }).eq("user_id", userId);
  if (error) throw error;
  await audit(context.user.id, userId, "SESSION_REVOKED", {});
  return { ok: true };
}

async function setMemberPassword(context: any, body: any) {
  const userId = requireUuid(body.userId);
  const password = validatePassword(body.password);
  const { error } = await admin().auth.admin.updateUserById(userId, { password });
  if (error) throw error;
  await admin().from("app_profiles").update({ active_session_id: null, active_device_id: null }).eq("user_id", userId);
  await audit(context.user.id, userId, "PASSWORD_RESET_BY_ADMIN", {});
  return { ok: true };
}

async function listUsers() {
  const { data: profiles, error } = await admin()
    .from("app_profiles")
    .select("user_id, username, display_name, contact_email, mobile_number, role, status, active_session_id, active_device_id, last_login_at, created_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const { data: settings } = await admin().from("app_user_settings").select("*");
  const settingsByUser = new Map((settings || []).map((row: any) => [row.user_id, publicSettings(row)]));
  return (profiles || []).map((profile: any) => ({
    ...publicProfile(profile),
    settings: settingsByUser.get(profile.user_id) || null
  }));
}

async function saveCustomList(context: any, body: any) {
  const symbols = normalizeSymbols(body.symbols).slice(0, 5000);
  const { error } = await admin().from("app_watchlists").upsert({ user_id: context.user.id, symbols });
  if (error) throw error;
  await audit(context.user.id, context.user.id, "WATCHLIST_SAVED", { count: symbols.length });
  return { ok: true, count: symbols.length, updatedAt: new Date().toISOString() };
}

async function saveTradeSettings(context: any, body: any) {
  const current = await readSettings(context.user.id);
  const requested = normalizeSettings({ ...publicSettings(current), ...body });
  const previousCapital = Number(current.total_capital || 1000000);
  const addCapital = Math.max(0, Number(body.addCapital) || 0);
  const requestedCapital = Number(body.totalCapital);
  const totalCapital = addCapital > 0
    ? previousCapital + addCapital
    : Number.isFinite(requestedCapital) ? requestedCapital : previousCapital;
  requested.total_capital = clamp(totalCapital, 10000, 1000000000);
  const history = Array.isArray(current.capital_history) ? current.capital_history.slice(-99) : [];
  if (requested.total_capital !== previousCapital) {
    history.push({
      date: new Date().toISOString(),
      type: addCapital > 0 ? "CAPITAL_ADDED" : "CAPITAL_SET",
      amount: Math.abs(requested.total_capital - previousCapital),
      previousCapital,
      newCapital: requested.total_capital
    });
  }
  requested.capital_history = history;
  const { data, error } = await admin()
    .from("app_user_settings")
    .update(requested)
    .eq("user_id", context.user.id)
    .select("*")
    .single();
  if (error) throw error;
  await audit(context.user.id, context.user.id, "TRADE_SETTINGS_SAVED", publicSettings(data));
  return { ok: true, tradeSettings: publicSettings(data) };
}

async function saveTelegram(context: any, body: any) {
  const existing = await admin().from("app_telegram_configs").select("*").eq("user_id", context.user.id).maybeSingle();
  const row = {
    user_id: context.user.id,
    bot_token: String(body.botToken || existing.data?.bot_token || "").trim() || null,
    chat_id: String(body.chatId || existing.data?.chat_id || "").trim() || null,
    enabled: body.enabled !== false
  };
  const { error } = await admin().from("app_telegram_configs").upsert(row);
  if (error) throw error;
  await audit(context.user.id, context.user.id, "TELEGRAM_SAVED", { configured: Boolean(row.bot_token && row.chat_id) });
  return { ok: true, telegram: publicTelegram(row) };
}

async function metadata(context: any) {
  const [settings, watchlist, telegram] = await Promise.all([
    readSettings(context.user.id),
    readWatchlist(context.user.id),
    readTelegram(context.user.id)
  ]);
  return {
    ok: true,
    profile: publicProfile(context.profile),
    tradeSettings: publicSettings(settings),
    customList: { count: watchlist.length },
    telegram: publicTelegram(telegram)
  };
}

async function userPayload(context: any) {
  const [marketResult, stateResult, settings, symbols, telegram] = await Promise.all([
    admin().from("app_market_state").select("*").eq("singleton", true).maybeSingle(),
    admin().from("app_user_states").select("*").eq("user_id", context.user.id).maybeSingle(),
    readSettings(context.user.id),
    readWatchlist(context.user.id),
    readTelegram(context.user.id)
  ]);
  if (marketResult.error) throw marketResult.error;
  if (stateResult.error) throw stateResult.error;
  const market = marketResult.data?.payload || {};
  const userState = stateResult.data?.state || {};
  const lists = withCustomList(market.lists || {}, symbols);
  const state = {
    ...market,
    ...userState,
    lists,
    tradeSettings: publicSettings(settings)
  };
  return {
    state,
    profile: publicProfile(context.profile),
    tradeSettings: publicSettings(settings),
    customList: { count: symbols.length },
    telegram: publicTelegram(telegram)
  };
}

async function ingestMarketState(body: any) {
  await requireInternal(body);
  const state = body.state && typeof body.state === "object" ? body.state : null;
  if (!state?.lists) throw httpError("Market state with scanned lists is required", 400);
  const row = {
    singleton: true,
    strategy_version: String(body.strategyVersion || "unknown"),
    scan_at: state.scannedAt || new Date().toISOString(),
    payload: state
  };
  const { error } = await admin().from("app_market_state").upsert(row);
  if (error) throw error;
  return { ok: true, scanAt: row.scan_at };
}

async function runtimeUsers(body: any) {
  await requireInternal(body);
  const [{ data: profiles, error }, { data: settings }, { data: watchlists }, { data: states }, { data: telegram }] = await Promise.all([
    admin().from("app_profiles").select("user_id, username").eq("status", "active"),
    admin().from("app_user_settings").select("*"),
    admin().from("app_watchlists").select("*"),
    admin().from("app_user_states").select("*"),
    admin().from("app_telegram_configs").select("*")
  ]);
  if (error) throw error;
  const byUser = (rows: any[] | null) => new Map((rows || []).map((row: any) => [row.user_id, row]));
  const settingsMap = byUser(settings);
  const watchlistMap = byUser(watchlists);
  const stateMap = byUser(states);
  const telegramMap = byUser(telegram);
  return {
    ok: true,
    users: (profiles || []).map((profile: any) => ({
      userId: profile.user_id,
      username: profile.username,
      settings: publicSettings(settingsMap.get(profile.user_id) || {}),
      symbols: watchlistMap.get(profile.user_id)?.symbols || [],
      journal: stateMap.get(profile.user_id)?.state?.journal || {},
      telegram: telegramMap.get(profile.user_id) || null
    }))
  };
}

async function saveRuntimeUserState(body: any) {
  await requireInternal(body);
  const userId = requireUuid(body.userId);
  const state = body.state && typeof body.state === "object" ? body.state : {};
  const row = {
    user_id: userId,
    strategy_version: String(body.strategyVersion || "unknown"),
    scan_at: state.scannedAt || new Date().toISOString(),
    state
  };
  const { error } = await admin().from("app_user_states").upsert(row);
  if (error) throw error;
  return { ok: true };
}

async function liveMtm(userId: string) {
  const [{ data: stateRow }, settings] = await Promise.all([
    admin().from("app_user_states").select("state").eq("user_id", userId).maybeSingle(),
    readSettings(userId)
  ]);
  const trades = (Array.isArray(stateRow?.state?.trades) ? stateRow.state.trades : [])
    .filter((trade: any) => ACTIVE_TRADE_STATUSES.has(String(trade?.status || "")));
  const symbols = [...new Set(trades.map((trade: any) => String(trade.yahooSymbol || `${trade.symbol}.NS`)).filter(Boolean))];
  const quotes = new Map(await Promise.all(symbols.map(async (symbol) => [symbol, await fetchQuote(symbol)] as const)));
  const marketStatus = marketStatusIst([...quotes.values()]);
  const positions = trades.map((trade: any) => {
    const symbol = String(trade.yahooSymbol || `${trade.symbol}.NS`);
    const quote = quotes.get(symbol) || { ltp: Number(trade.lastPrice) || null, isLive: false, source: "EOD fallback" };
    return calculatePositionMtm(trade, { ...quote, isLive: marketStatus === "OPEN" && isFreshQuote(quote.asOf) });
  });
  return {
    ok: true,
    mode: "POSITIONAL_MTM_ONLY",
    generatedAt: new Date().toISOString(),
    source: "Yahoo Finance intraday chart",
    feedType: "FREE_NEAR_LIVE",
    marketStatus,
    positions,
    summary: summarizeLivePositions(positions, Number(settings.total_capital) || 0)
  };
}

async function fetchQuote(symbol: string) {
  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("range", "1d");
    url.searchParams.set("interval", "1m");
    const response = await fetch(url, { headers: { "User-Agent": "Techno-Funda-Mobile/1.0" } });
    if (!response.ok) throw new Error(String(response.status));
    const result = (await response.json())?.chart?.result?.[0];
    const times = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    for (let index = closes.length - 1; index >= 0; index -= 1) {
      const ltp = Number(closes[index]);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      return {
        ltp,
        asOf: Number.isFinite(Number(times[index])) ? new Date(Number(times[index]) * 1000).toISOString() : null,
        marketState: result?.meta?.marketState || "",
        source: "Yahoo 1m"
      };
    }
  } catch (error) {
    console.warn(`Quote unavailable for ${symbol}: ${error?.message || error}`);
  }
  return { ltp: null, asOf: null, marketState: "", source: "EOD fallback" };
}

async function requireUser(request: Request, options: { activeSession: boolean }) {
  const token = bearerToken(request);
  if (!token) throw httpError("Login required", 401);
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw httpError("Session expired", 401);
  const claims = decodeJwt(token);
  const { data: profile, error: profileError } = await admin()
    .from("app_profiles")
    .select("*")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.status !== "active") throw httpError("Account is not active", 403);
  const deviceId = readDeviceId(request);
  if (sessionIsRejected(profile, claims, options.activeSession, deviceId)) {
    throw httpError("This account is active on another device. Please log in again here to transfer access.", 409);
  }
  return { token, user: data.user, profile, claims, deviceId };
}

function requireAdmin(context: any) {
  if (context.profile.role !== "admin" || context.claims?.app_metadata?.role !== "admin") {
    throw httpError("Administrator access required", 403);
  }
  if (context.claims.aal !== "aal2") throw httpError("Administrator OTP verification required", 403);
}

async function requireInternal(body: any) {
  if (!(await verifySecret("workflow_ingest", String(body.internalKey || ""), false))) {
    throw httpError("Invalid workflow key", 401);
  }
}

async function verifySecret(name: string, value: string, unusedOnly: boolean) {
  if (!value) return false;
  const { data, error } = await admin().from("app_secrets").select("sha256, used_at").eq("name", name).maybeSingle();
  if (error || !data || (unusedOnly && data.used_at)) return false;
  return constantTimeEqual(await sha256(value), String(data.sha256));
}

async function readSettings(userId: string) {
  const { data, error } = await admin().from("app_user_settings").select("*").eq("user_id", userId).single();
  if (error) throw error;
  return data;
}

async function readWatchlist(userId: string) {
  const { data, error } = await admin().from("app_watchlists").select("symbols").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return normalizeSymbols(data?.symbols || []);
}

async function readTelegram(userId: string) {
  const { data, error } = await admin().from("app_telegram_configs").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data || {};
}

function withCustomList(lists: any, symbols: string[]) {
  const allMarket = lists["all-market"] || { results: [] };
  const allRows = Array.isArray(allMarket.results) ? allMarket.results : [];
  const defaultList = lists.default || { id: "default", label: "Nifty 500", symbols: [] };
  const defaultSymbols = new Set(normalizeSymbols(defaultList.symbols || []));
  const wanted = new Set(symbols.map(normalizeSymbol));
  const defaultResults = allRows
    .filter((row: any) => defaultSymbols.has(normalizeSymbol(row.symbol || row.yahooSymbol)))
    .map((row: any) => ({ ...row, listLabel: defaultList.label || "Nifty 500" }));
  const results = allRows
    .filter((row: any) => wanted.has(normalizeSymbol(row.symbol || row.yahooSymbol)))
    .map((row: any) => ({ ...row, listLabel: "My List" }));
  return {
    ...lists,
    "all-market": {
      ...allMarket,
      results: allRows.map((row: any) => ({ ...row, listLabel: allMarket.label || "All NSE Market" }))
    },
    default: {
      ...defaultList,
      results: defaultResults
    },
    custom: {
      id: "custom",
      label: "My Custom List",
      editable: true,
      summary: summarizeRows(results),
      results
    }
  };
}

function summarizeRows(rows: any[]) {
  const output: any = { total: rows.length, entry: 0, exit: 0, watch: 0, dataGap: 0, error: 0 };
  for (const row of rows) {
    const key = String(row.status || "").toLowerCase().replace("_", "");
    if (key in output) output[key] += 1;
  }
  return output;
}

function normalizeNewUser(body: any, role: string) {
  const username = normalizeUsername(body.username);
  if (!USERNAME_PATTERN.test(username)) throw httpError("User ID must be 3-32 lowercase letters, numbers, dot, dash or underscore", 400);
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError("Valid email is required", 400);
  const displayName = String(body.displayName || username).trim().slice(0, 80);
  const password = validatePassword(body.password);
  return {
    username,
    email,
    displayName,
    password,
    mobileNumber: String(body.mobileNumber || "").trim().slice(0, 24),
    role,
    settings: normalizeSettings(body.settings || body)
  };
}

function normalizeSettings(input: any) {
  const scope = ["all-market", "default", "custom"].includes(String(input.scopeListId)) ? String(input.scopeListId) : "all-market";
  const quality = ["BEST_ONLY", "STRONG_OR_BETTER", "ALL_ENTRIES"].includes(String(input.qualityMode)) ? String(input.qualityMode) : "BEST_ONLY";
  return {
    total_capital: clamp(Number(input.totalCapital ?? input.total_capital) || 1000000, 10000, 1000000000),
    scope_list_id: scope,
    quality_mode: quality,
    max_open_positions: Math.round(clamp(Number(input.maxOpenPositions ?? input.max_open_positions) || 15, 1, 100)),
    risk_per_trade_pct: clamp(Number(input.riskPerTradePct ?? input.risk_per_trade_pct) || 1, 0.1, 10),
    max_portfolio_risk_pct: clamp(Number(input.maxPortfolioRiskPct ?? input.max_portfolio_risk_pct) || 6, 0.1, 50),
    max_position_pct: clamp(Number(input.maxPositionPct ?? input.max_position_pct) || 10, 0.1, 100),
    max_sector_exposure_pct: clamp(Number(input.maxSectorExposurePct ?? input.max_sector_exposure_pct) || 25, 0.1, 100),
    pyramiding_enabled: input.pyramidingEnabled ?? input.pyramiding_enabled ?? true
  };
}

function publicSettings(row: any) {
  return {
    scopeListId: row.scope_list_id || "all-market",
    scopeLabel: { "all-market": "All NSE Market", default: "Nifty 500", custom: "My List" }[row.scope_list_id] || "All NSE Market",
    qualityMode: row.quality_mode || "BEST_ONLY",
    qualityLabel: { BEST_ONLY: "Best only (A+/A)", STRONG_OR_BETTER: "Strong and best (A+/A/B)", ALL_ENTRIES: "All entry signals" }[row.quality_mode] || "Best only (A+/A)",
    totalCapital: Number(row.total_capital) || 1000000,
    maxOpenPositions: Number(row.max_open_positions) || 15,
    riskPerTradePct: Number(row.risk_per_trade_pct) || 1,
    maxPortfolioRiskPct: Number(row.max_portfolio_risk_pct) || 6,
    maxPositionPct: Number(row.max_position_pct) || 10,
    maxSectorExposurePct: Number(row.max_sector_exposure_pct) || 25,
    pyramidingEnabled: row.pyramiding_enabled !== false,
    capitalHistory: Array.isArray(row.capital_history) ? row.capital_history : [],
    updatedAt: row.updated_at || null
  };
}

function publicProfile(profile: any) {
  return {
    userId: profile.user_id,
    username: profile.username,
    displayName: profile.display_name,
    contactEmail: profile.contact_email,
    mobileNumber: profile.mobile_number,
    role: profile.role,
    status: profile.status,
    hasActiveSession: Boolean(profile.active_device_id || profile.active_session_id),
    lastLoginAt: profile.last_login_at,
    createdAt: profile.created_at
  };
}

function publicTelegram(row: any) {
  return {
    configured: Boolean(row?.bot_token && row?.chat_id && row?.enabled !== false),
    enabled: row?.enabled !== false,
    updatedAt: row?.updated_at || null
  };
}

async function audit(actorUserId: string | null, subjectUserId: string | null, action: string, details: any) {
  const { error } = await admin().from("app_audit_log").insert({
    actor_user_id: actorUserId,
    subject_user_id: subjectUserId,
    action,
    details: details || {}
  });
  if (error) console.warn(`Audit write failed: ${error.message}`);
}

function admin() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredSecretKey(), { auth: { persistSession: false } });
}

function publicClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), { auth: { persistSession: false } });
}

function requiredSecretKey() {
  return requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function bearerToken(request: Request) {
  const value = String(request.headers.get("authorization") || "");
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function decodeJwt(token: string) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
  } catch {
    throw httpError("Invalid session token", 401);
  }
}

function normalizeSymbols(input: any) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\s,;|]+/);
  return [...new Set(values.map((value) => normalizeSymbol(value)).filter(Boolean))];
}

function normalizeSymbol(value: any) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^(NSE:)/, "")
    .replace(/\.(NS|BO)$/i, "")
    .replace(/[^A-Z0-9&_-]/g, "");
}

function normalizeUsername(value: any) {
  return String(value || "").trim().toLowerCase();
}

function validatePassword(value: any) {
  const password = String(value || "");
  if (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    throw httpError("Password must have at least 10 characters with upper, lower and number", 400);
  }
  return password;
}

function requireUuid(value: any) {
  const id = String(value || "");
  if (!isUuid(id)) throw httpError("Valid user ID is required", 400);
  return id;
}

function requireDeviceId(request: Request) {
  const deviceId = readDeviceId(request);
  if (!isUuid(deviceId)) throw httpError("This device could not be identified. Reload the application.", 400);
  return deviceId;
}

function readDeviceId(request: Request) {
  const deviceId = String(request.headers.get("x-device-id") || "");
  return isUuid(deviceId) ? deviceId : "";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function marketStatusIst(quotes: any[]) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const open = !["Sat", "Sun"].includes(parts.weekday) && minute >= 555 && minute <= 930;
  return open && quotes.some((quote) => isFreshQuote(quote?.asOf)) ? "OPEN" : "CLOSED";
}

function isFreshQuote(asOf: any) {
  const time = Date.parse(String(asOf || ""));
  return Number.isFinite(time) && Date.now() - time <= 10 * 60 * 1000;
}

function httpError(message: string, status: number) {
  const error: any = new Error(message);
  error.status = status;
  return error;
}

function json(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
  });
}
