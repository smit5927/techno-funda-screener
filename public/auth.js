import { resolveRequestUrl } from "./auth-request.js?v=20260714-url-auth-fix";

const config = window.TF_MOBILE_CONFIG;
if (!config?.supabaseUrl || !config?.publishableKey || !config?.apiUrl || !window.supabase?.createClient) {
  throw new Error("Secure application configuration is unavailable.");
}

const client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "techno-funda-secure-session"
  }
});

const nativeFetch = window.fetch.bind(window);
const DEVICE_STORAGE_KEY = "techno-funda-device-id";
const PROFILE_STORAGE_KEY = "techno-funda-profile";
const deviceId = readOrCreateDeviceId();
let currentProfile = null;
let pendingFactorId = null;
let appLoaded = false;
let installPrompt = null;

const elements = {
  authGate: document.querySelector("#authGate"),
  appRoot: document.querySelector("#appRoot"),
  loginForm: document.querySelector("#loginForm"),
  bootstrapForm: document.querySelector("#bootstrapForm"),
  mfaPanel: document.querySelector("#mfaPanel"),
  mfaForm: document.querySelector("#mfaForm"),
  mfaEnrollment: document.querySelector("#mfaEnrollment"),
  mfaQrCode: document.querySelector("#mfaQrCode"),
  mfaSecret: document.querySelector("#mfaSecret"),
  mfaTitle: document.querySelector("#mfaTitle"),
  mfaDescription: document.querySelector("#mfaDescription"),
  mfaCode: document.querySelector("#mfaCode"),
  authStatus: document.querySelector("#authStatus"),
  showBootstrapButton: document.querySelector("#showBootstrapButton"),
  backToLoginButton: document.querySelector("#backToLoginButton"),
  logoutButton: document.querySelector("#logoutButton"),
  accountName: document.querySelector("#accountName"),
  installAppButton: document.querySelector("#installAppButton"),
  installHelpDialog: document.querySelector("#installHelpDialog"),
  adminNavButton: document.querySelector("#adminNavButton"),
  openCreateUserButton: document.querySelector("#openCreateUserButton"),
  cancelCreateUserButton: document.querySelector("#cancelCreateUserButton"),
  createUserForm: document.querySelector("#createUserForm"),
  adminUsersBody: document.querySelector("#adminUsersBody"),
  adminUsersEmpty: document.querySelector("#adminUsersEmpty"),
  adminStatus: document.querySelector("#adminStatus")
};

window.TF_STATIC_MODE = true;
window.TF_SUPABASE = client;
window.fetch = async (input, options = {}) => {
  const requestUrl = resolveRequestUrl(input, window.location.href);
  if (requestUrl.href.startsWith(config.apiUrl)) {
    const headers = new Headers(options.headers || (typeof input !== "string" ? input.headers : undefined));
    const accessToken = await currentAccessToken();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("X-Device-ID", deviceId);
    return nativeFetch(input, { ...options, headers });
  }
  return nativeFetch(input, options);
};

elements.showBootstrapButton.addEventListener("click", () => showAuthPanel("bootstrap"));
elements.backToLoginButton.addEventListener("click", () => showAuthPanel("login"));
elements.loginForm.addEventListener("submit", login);
elements.bootstrapForm.addEventListener("submit", bootstrapOwner);
elements.mfaForm.addEventListener("submit", verifyMfa);
elements.logoutButton.addEventListener("click", logout);
elements.openCreateUserButton.addEventListener("click", () => {
  elements.createUserForm.hidden = !elements.createUserForm.hidden;
});
elements.cancelCreateUserButton.addEventListener("click", () => {
  elements.createUserForm.hidden = true;
  elements.createUserForm.reset();
});
elements.createUserForm.addEventListener("submit", createUser);
elements.adminUsersBody.addEventListener("click", handleAdminAction);
elements.adminNavButton.addEventListener("click", loadUsers);
elements.installAppButton.addEventListener("click", installApp);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  updateInstallButton();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  updateInstallButton();
});

client.auth.onAuthStateChange((_event, session) => {
  window.TF_ACCESS_TOKEN = session?.access_token || "";
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
}

wireDownloads();
await resumeSession();

async function login(event) {
  event.preventDefault();
  setAuthBusy(true, "Checking credentials...");
  try {
    const payload = await apiPost({
      action: "login",
      username: document.querySelector("#loginUsername").value,
      password: document.querySelector("#loginPassword").value
    }, false);
    await client.auth.setSession({
      access_token: payload.session.access_token,
      refresh_token: payload.session.refresh_token
    });
    window.TF_ACCESS_TOKEN = payload.session.access_token;
    await prepareMfa();
  } catch (error) {
    setAuthStatus(error.message, true);
  } finally {
    setAuthBusy(false);
  }
}

async function bootstrapOwner(event) {
  event.preventDefault();
  setAuthBusy(true, "Creating isolated owner account...");
  try {
    const payload = await apiPost({
      action: "bootstrap-owner",
      bootstrapCode: document.querySelector("#bootstrapCode").value,
      username: document.querySelector("#bootstrapUsername").value,
      displayName: document.querySelector("#bootstrapName").value,
      email: document.querySelector("#bootstrapEmail").value,
      mobileNumber: document.querySelector("#bootstrapMobile").value,
      password: document.querySelector("#bootstrapPassword").value,
      totalCapital: 1000000
    }, false);
    await client.auth.setSession({
      access_token: payload.session.access_token,
      refresh_token: payload.session.refresh_token
    });
    window.TF_ACCESS_TOKEN = payload.session.access_token;
    await prepareMfa();
  } catch (error) {
    setAuthStatus(error.message, true);
  } finally {
    setAuthBusy(false);
  }
}

async function prepareMfa() {
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) throw error;
  const verified = (data?.totp || []).find((factor) => factor.status === "verified");
  if (verified) {
    pendingFactorId = verified.id;
    elements.mfaEnrollment.hidden = true;
    elements.mfaTitle.textContent = "Verify this device";
    elements.mfaDescription.textContent = "Enter the current 6-digit code from your authenticator app.";
  } else {
    const { data: enrollment, error: enrollError } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Techno Funda Mobile"
    });
    if (enrollError) throw enrollError;
    pendingFactorId = enrollment.id;
    elements.mfaEnrollment.hidden = false;
    elements.mfaQrCode.src = enrollment.totp.qr_code;
    elements.mfaSecret.textContent = enrollment.totp.secret;
    elements.mfaTitle.textContent = "Secure your account";
    elements.mfaDescription.textContent = "Add this account in Google or Microsoft Authenticator, then enter its 6-digit code.";
  }
  showAuthPanel("mfa");
  elements.mfaCode.focus();
}

async function verifyMfa(event) {
  event.preventDefault();
  setAuthBusy(true, "Verifying device...");
  try {
    if (!pendingFactorId) throw new Error("Authenticator setup is missing");
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId: pendingFactorId,
      code: elements.mfaCode.value
    });
    if (error) throw error;
    const { data, error: refreshError } = await client.auth.refreshSession();
    if (refreshError || !data.session) throw refreshError || new Error("Secure session refresh failed");
    window.TF_ACCESS_TOKEN = data.session.access_token;
    const activated = await apiPost({ action: "activate-session" });
    await showApplication(activated.profile);
  } catch (error) {
    setAuthStatus(error.message, true);
  } finally {
    elements.mfaCode.value = "";
    setAuthBusy(false);
  }
}

async function resumeSession() {
  const { data: stored, error: sessionError } = await client.auth.getSession();
  if (!stored.session) {
    showAuthPanel("login");
    if (sessionError) setAuthStatus("Saved login could not be restored. Please sign in once more.", true);
    return;
  }

  window.TF_ACCESS_TOKEN = stored.session.access_token;
  try {
    const response = await apiGetWithRetry("meta");
    await showApplication(response.profile);
  } catch (error) {
    if (Number(error?.status) === 409) {
      await client.auth.signOut({ scope: "local" });
      window.TF_ACCESS_TOKEN = "";
      localStorage.removeItem(PROFILE_STORAGE_KEY);
      showAuthPanel("login");
      setAuthStatus("This client account was opened on another device. Sign in here to transfer access.", true);
      return;
    }
    const cachedProfile = readCachedProfile();
    if (cachedProfile) {
      await showApplication(cachedProfile);
      const scanMeta = document.querySelector("#scanMeta");
      if (scanMeta) scanMeta.textContent = "Login saved | Reconnecting to latest data...";
      return;
    }
    showAuthPanel("login");
    setAuthStatus("Your login is still saved. Check the internet connection and reload; no settings were deleted.", true);
  }
}

async function showApplication(profile) {
  currentProfile = profile;
  cacheProfile(profile);
  elements.authGate.hidden = true;
  elements.appRoot.hidden = false;
  elements.accountName.textContent = profile.displayName || profile.username;
  elements.adminNavButton.hidden = profile.role !== "admin";
  updateInstallButton();
  document.querySelector(".accessRow")?.setAttribute("hidden", "");
  ["tradeAccessCodeInput", "telegramAccessCodeInput"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.hidden = true;
  });
  if (!appLoaded) {
    appLoaded = true;
    await import("./app.js?v=20260715-decision-desk");
  }
}

async function logout() {
  await client.auth.signOut({ scope: "local" });
  window.TF_ACCESS_TOKEN = "";
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  window.location.reload();
}

async function createUser(event) {
  event.preventDefault();
  setAdminStatus("Creating user...");
  try {
    await apiPost({
      action: "admin-create-user",
      username: document.querySelector("#newUserUsername").value,
      displayName: document.querySelector("#newUserName").value,
      email: document.querySelector("#newUserEmail").value,
      mobileNumber: document.querySelector("#newUserMobile").value,
      password: document.querySelector("#newUserPassword").value,
      totalCapital: Number(document.querySelector("#newUserCapital").value)
    });
    elements.createUserForm.reset();
    document.querySelector("#newUserCapital").value = 1000000;
    elements.createUserForm.hidden = true;
    setAdminStatus("User created. Give the ID and initial password directly to the user.");
    await loadUsers();
  } catch (error) {
    setAdminStatus(error.message, true);
  }
}

async function loadUsers() {
  if (currentProfile?.role !== "admin") return;
  setAdminStatus("Loading users...");
  try {
    const payload = await apiPost({ action: "admin-list-users" });
    renderUsers(payload.users || []);
    setAdminStatus(`${payload.users?.length || 0} accounts`);
  } catch (error) {
    setAdminStatus(error.message, true);
  }
}

function renderUsers(users) {
  elements.adminUsersBody.innerHTML = users.map((user) => `
    <tr>
      <td><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)}${user.role === "admin" ? " | OWNER" : ""}</small></td>
      <td>${escapeHtml(user.contactEmail)}<small>${escapeHtml(user.mobileNumber || "No mobile")}</small></td>
      <td>Rs ${formatNumber(user.settings?.totalCapital)}</td>
      <td><span class="adminState ${escapeHtml(user.status)}">${escapeHtml(user.status)}</span></td>
      <td>${formatDate(user.lastLoginAt)}</td>
      <td>${user.hasActiveSession ? "Active device" : "Signed out"}</td>
      <td class="adminActions">
        ${user.role === "admin" ? "" : `<button data-admin-action="toggle" data-user-id="${user.userId}" data-status="${user.status}">${user.status === "active" ? "Suspend" : "Activate"}</button>`}
        <button data-admin-action="revoke" data-user-id="${user.userId}">Log out</button>
        ${user.role === "admin" ? "" : `<button data-admin-action="password" data-user-id="${user.userId}">Password</button>`}
      </td>
    </tr>
  `).join("");
  elements.adminUsersEmpty.classList.toggle("visible", users.length === 0);
}

async function handleAdminAction(event) {
  const button = event.target.closest("button[data-admin-action]");
  if (!button) return;
  button.disabled = true;
  try {
    const userId = button.dataset.userId;
    if (button.dataset.adminAction === "toggle") {
      await apiPost({ action: "admin-update-user", userId, status: button.dataset.status === "active" ? "suspended" : "active" });
    } else if (button.dataset.adminAction === "revoke") {
      await apiPost({ action: "admin-reset-session", userId });
    } else if (button.dataset.adminAction === "password") {
      const password = window.prompt("Enter a new temporary password (10+ characters, upper/lower/number)");
      if (!password) return;
      await apiPost({ action: "admin-set-password", userId, password });
    }
    await loadUsers();
  } catch (error) {
    setAdminStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function wireDownloads() {
  const excelIds = ["topExcelDownloadLink", "excelDownloadLink", "dashboardExcelDownloadLink"];
  const csvIds = ["topCsvDownloadLink", "csvDownloadLink", "dashboardCsvDownloadLink"];
  excelIds.forEach((id) => document.getElementById(id)?.addEventListener("click", (event) => downloadTradeSheet(event, "xlsx")));
  csvIds.forEach((id) => document.getElementById(id)?.addEventListener("click", (event) => downloadTradeSheet(event, "csv")));
}

async function downloadTradeSheet(event, format) {
  event.preventDefault();
  try {
    const payload = await apiGet("state");
    const state = payload.state || {};
    const trades = Array.isArray(state.trades) ? state.trades : [];
    const tradeRows = trades.map(tradeSheetRow);
    if (format === "csv") {
      const headers = tradeSheetColumns().map(({ header }) => header);
      const rows = tradeRows.map((row) => tradeSheetColumns().map(({ key }) => row[key]));
      saveBlob(csvBlob([headers, ...rows]), "techno-funda-trade-sheet.csv");
      return;
    }
    if (!window.ExcelJS) throw new Error("Excel generator is not ready");
    const workbook = new window.ExcelJS.Workbook();
    workbook.creator = "Techno Funda Institutional System";
    const summary = workbook.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
    summary.columns = [{ header: "Metric", key: "metric", width: 34 }, { header: "Value", key: "value", width: 28 }];
    tradeSheetSummary(state).forEach(([metric, value]) => summary.addRow({ metric, value }));
    styleTradeSheet(summary, "B1");

    const sheet = workbook.addWorksheet("Trades", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = tradeSheetColumns();
    tradeRows.forEach((trade) => sheet.addRow(trade));
    styleTradeSheet(sheet, `${sheet.getColumn(sheet.columnCount).letter}1`);
    const capital = workbook.addWorksheet("Capital History");
    capital.columns = ["Date", "Type", "Amount", "Previous Capital", "New Capital"].map((header) => ({ header, key: header.toLowerCase().replaceAll(" ", "_"), width: 22 }));
    (state.tradeSettings?.capitalHistory || []).forEach((item) => capital.addRow({ date: item.date, type: item.type, amount: item.amount, previous_capital: item.previousCapital, new_capital: item.newCapital }));
    styleTradeSheet(capital, "E1");
    const buffer = await workbook.xlsx.writeBuffer();
    saveBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "techno-funda-trade-sheet.xlsx");
  } catch (error) {
    window.alert(`Trade sheet download failed: ${error.message}`);
  }
}

function tradeSheetColumns() {
  return [
    ["Status", "status", 22], ["Symbol", "symbol", 18], ["List", "listLabel", 20],
    ["Signal Date", "entrySignalDate", 16], ["Entry Date", "entryDate", 16], ["Entry Time", "entryTime", 14],
    ["Entry Price", "entryPrice", 14], ["Quantity", "quantity", 12], ["Original Quantity", "originalQuantity", 16],
    ["Exit Date", "exitDate", 16], ["Exit Price", "exitPrice", 14], ["Invested Value", "investedValue", 17],
    ["Current Value", "currentValue", 17], ["Last Price", "lastPrice", 14], ["Unrealized P&L", "unrealizedPnl", 18],
    ["Unrealized P&L %", "unrealizedPnlPct", 18], ["Partial Realized P&L", "partialRealizedPnl", 21],
    ["Final Realized P&L", "finalRealizedPnl", 20], ["Booked P&L Contribution", "bookedPnlContribution", 23],
    ["Total Position P&L", "totalPositionPnl", 20], ["Trailing Stop", "trailingStopPrice", 15],
    ["Management Decision", "managementDecision", 22], ["Reason", "reason", 80]
  ].map(([header, key, width]) => ({ header, key, width }));
}

function tradeSheetRow(trade) {
  const closed = trade.status === "CLOSED";
  const partialRealizedPnl = Number(trade.realizedPnlToDate || 0);
  const finalRealizedPnl = closed ? Number(trade.pnl || 0) : null;
  const bookedPnlContribution = closed ? finalRealizedPnl : partialRealizedPnl;
  const unrealizedPnl = closed ? 0 : Number(trade.unrealizedPnl || 0);
  return {
    ...trade,
    partialRealizedPnl,
    finalRealizedPnl,
    bookedPnlContribution,
    totalPositionPnl: bookedPnlContribution + unrealizedPnl,
    managementDecision: trade.latestManagementDecision?.action || "",
    reason: tradeSheetReason(trade)
  };
}

function tradeSheetReason(trade) {
  const values = [
    ...(Array.isArray(trade.latestManagementDecision?.reasons) ? trade.latestManagementDecision.reasons : []),
    ...(Array.isArray(trade.signalReason) ? trade.signalReason : []),
    ...(Array.isArray(trade.entryReason) ? trade.entryReason : []),
    ...(Array.isArray(trade.exitReason) ? trade.exitReason : [])
  ];
  return [...new Set(values.filter(Boolean).map(String))].join(" | ");
}

function tradeSheetSummary(state) {
  const trades = state.tradeSummary || {};
  const portfolio = state.portfolioSummary || {};
  const settings = state.tradeSettings || {};
  return [
    ["Updated At", state.scannedAt || state.executionPassAt || ""],
    ["Trade Scope", settings.scopeLabel || settings.scopeListId || ""],
    ["Trade Quality", settings.qualityLabel || settings.qualityMode || ""],
    ["Total Capital", portfolio.totalCapital], ["Total Equity", portfolio.totalEquity],
    ["Invested Capital", portfolio.investedCapital], ["Available Cash", portfolio.availableCash],
    ["Open Positions", trades.open || 0], ["Pending Entry", trades.pendingEntry || 0],
    ["Pending Full Exit", trades.pendingExit || 0], ["Pending Partial Exit", trades.pendingPartialExit || 0],
    ["Closed Trades", trades.closed || 0], ["Realized P&L", trades.realizedPnl || 0],
    ["Unrealized P&L", trades.unrealizedPnl || 0], ["Unrealized P&L %", portfolio.unrealizedPnlPct || 0],
    ["Portfolio Risk", portfolio.portfolioRisk], ["Portfolio Risk %", portfolio.portfolioRiskPct]
  ];
}

function styleTradeSheet(sheet, filterTo) {
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF20252B" } };
  sheet.autoFilter = { from: "A1", to: filterTo };
}

function csvBlob(rows) {
  const csv = rows.map((row) => row.map((value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",")).join("\n");
  return new Blob([`${csv}\n`], { type: "text/csv;charset=utf-8" });
}

function saveBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function installApp() {
  if (!installPrompt) {
    elements.installHelpDialog?.showModal();
    return;
  }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  updateInstallButton();
}

function updateInstallButton() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  elements.installAppButton.hidden = standalone;
}

async function apiGet(view) {
  const url = new URL(config.apiUrl);
  if (view) url.searchParams.set("view", view);
  const response = await window.fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function apiGetWithRetry(view, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await apiGet(view);
    } catch (error) {
      lastError = error;
      if ([401, 403, 409].includes(Number(error?.status)) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function apiPost(body, authenticated = true) {
  const headers = { "Content-Type": "application/json", "X-Device-ID": deviceId };
  const accessToken = authenticated ? await currentAccessToken() : "";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await nativeFetch(config.apiUrl, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function currentAccessToken() {
  const { data } = await client.auth.getSession();
  window.TF_ACCESS_TOKEN = data.session?.access_token || "";
  return window.TF_ACCESS_TOKEN;
}

function readOrCreateDeviceId() {
  const saved = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved || "")) return saved;
  const id = crypto.randomUUID ? crypto.randomUUID() : fallbackUuid();
  localStorage.setItem(DEVICE_STORAGE_KEY, id);
  return id;
}

function fallbackUuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function cacheProfile(profile) {
  const safeProfile = {
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
    role: profile.role,
    status: profile.status
  };
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(safeProfile));
}

function readCachedProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    return profile?.userId && profile?.role ? profile : null;
  } catch {
    return null;
  }
}

function showAuthPanel(panel) {
  elements.authGate.hidden = false;
  elements.appRoot.hidden = true;
  elements.loginForm.hidden = panel !== "login";
  elements.bootstrapForm.hidden = panel !== "bootstrap";
  elements.mfaPanel.hidden = panel !== "mfa";
  setAuthStatus("");
}

function setAuthBusy(busy, message = "") {
  elements.authGate.querySelectorAll("button, input").forEach((control) => { control.disabled = busy; });
  if (message) setAuthStatus(message);
}

function setAuthStatus(message, error = false) {
  elements.authStatus.textContent = message || "";
  elements.authStatus.classList.toggle("error", error);
}

function setAdminStatus(message, error = false) {
  elements.adminStatus.textContent = message || "";
  elements.adminStatus.classList.toggle("error", error);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
