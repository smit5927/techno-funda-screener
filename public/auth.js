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
  const requestUrl = new URL(typeof input === "string" ? input : input.url, window.location.href);
  if (requestUrl.href.startsWith(config.apiUrl)) {
    const headers = new Headers(options.headers || (typeof input !== "string" ? input.headers : undefined));
    if (window.TF_ACCESS_TOKEN) headers.set("Authorization", `Bearer ${window.TF_ACCESS_TOKEN}`);
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
  elements.installAppButton.hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  elements.installAppButton.hidden = true;
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
  const { data } = await client.auth.getSession();
  if (!data.session) {
    showAuthPanel("login");
    return;
  }
  window.TF_ACCESS_TOKEN = data.session.access_token;
  try {
    const response = await apiGet("meta");
    await showApplication(response.profile);
  } catch {
    await client.auth.signOut({ scope: "local" });
    window.TF_ACCESS_TOKEN = "";
    showAuthPanel("login");
    setAuthStatus("Please verify ID, password and OTP again.");
  }
}

async function showApplication(profile) {
  currentProfile = profile;
  elements.authGate.hidden = true;
  elements.appRoot.hidden = false;
  elements.accountName.textContent = profile.displayName || profile.username;
  elements.adminNavButton.hidden = profile.role !== "admin";
  document.querySelector(".accessRow")?.setAttribute("hidden", "");
  ["tradeAccessCodeInput", "telegramAccessCodeInput"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.hidden = true;
  });
  if (!appLoaded) {
    appLoaded = true;
    await import("./app.js?v=20260714-mobile-auth");
  }
}

async function logout() {
  await client.auth.signOut({ scope: "local" });
  window.TF_ACCESS_TOKEN = "";
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
    if (format === "csv") {
      const headers = ["Status", "Symbol", "Signal Date", "Entry Date", "Entry Price", "Quantity", "Exit Date", "Exit Price", "Invested Value", "Current Value", "P&L", "P&L %", "Reason"];
      const rows = trades.map((trade) => [trade.status, trade.symbol, trade.entrySignalDate, trade.entryDate, trade.entryPrice, trade.quantity, trade.exitDate, trade.exitPrice, trade.investedValue, trade.currentValue, trade.pnl ?? trade.unrealizedPnl, trade.pnlPct ?? trade.unrealizedPnlPct, (trade.signalReason || trade.entryReason || []).join(" | ")]);
      saveBlob(csvBlob([headers, ...rows]), "techno-funda-trade-sheet.csv");
      return;
    }
    if (!window.ExcelJS) throw new Error("Excel generator is not ready");
    const workbook = new window.ExcelJS.Workbook();
    workbook.creator = "Techno Funda Institutional System";
    const sheet = workbook.addWorksheet("Trades", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = [
      ["Status", "status", 22], ["Symbol", "symbol", 18], ["Signal Date", "entrySignalDate", 16],
      ["Entry Date", "entryDate", 16], ["Entry Price", "entryPrice", 14], ["Quantity", "quantity", 12],
      ["Exit Date", "exitDate", 16], ["Exit Price", "exitPrice", 14], ["P&L", "pnl", 14],
      ["Unrealized P&L", "unrealizedPnl", 18], ["Stop", "trailingStopPrice", 14], ["Reason", "reason", 70]
    ].map(([header, key, width]) => ({ header, key, width }));
    trades.forEach((trade) => sheet.addRow({ ...trade, reason: (trade.signalReason || trade.entryReason || []).join(" | ") }));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF20252B" } };
    sheet.autoFilter = { from: "A1", to: "L1" };
    const capital = workbook.addWorksheet("Capital History");
    capital.columns = ["Date", "Type", "Amount", "Previous Capital", "New Capital"].map((header) => ({ header, key: header.toLowerCase().replaceAll(" ", "_"), width: 22 }));
    (state.tradeSettings?.capitalHistory || []).forEach((item) => capital.addRow({ date: item.date, type: item.type, amount: item.amount, previous_capital: item.previousCapital, new_capital: item.newCapital }));
    const buffer = await workbook.xlsx.writeBuffer();
    saveBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "techno-funda-trade-sheet.xlsx");
  } catch (error) {
    window.alert(`Trade sheet download failed: ${error.message}`);
  }
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
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  elements.installAppButton.hidden = true;
}

async function apiGet(view) {
  const url = new URL(config.apiUrl);
  if (view) url.searchParams.set("view", view);
  const response = await window.fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function apiPost(body, authenticated = true) {
  const headers = { "Content-Type": "application/json" };
  if (authenticated && window.TF_ACCESS_TOKEN) headers.Authorization = `Bearer ${window.TF_ACCESS_TOKEN}`;
  const response = await nativeFetch(config.apiUrl, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
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
