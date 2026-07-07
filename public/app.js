const state = {
  payload: null,
  rows: [],
  currentList: "default",
  filter: "ALL",
  search: "",
  minScore: 0
};

const staticMode = Boolean(window.TF_STATIC_MODE);
const cloudApiUrl = String(window.TF_CLOUD_API_URL || "");
const cloudMode = Boolean(cloudApiUrl);

const elements = {
  scanMeta: document.querySelector("#scanMeta"),
  totalCount: document.querySelector("#totalCount"),
  entryCount: document.querySelector("#entryCount"),
  exitCount: document.querySelector("#exitCount"),
  watchCount: document.querySelector("#watchCount"),
  errorCount: document.querySelector("#errorCount"),
  openTradesCount: document.querySelector("#openTradesCount"),
  closedTradesCount: document.querySelector("#closedTradesCount"),
  realizedPnl: document.querySelector("#realizedPnl"),
  resultsBody: document.querySelector("#resultsBody"),
  emptyState: document.querySelector("#emptyState"),
  refreshButton: document.querySelector("#refreshButton"),
  scanButton: document.querySelector("#scanButton"),
  searchInput: document.querySelector("#searchInput"),
  scoreFilter: document.querySelector("#scoreFilter"),
  exportButton: document.querySelector("#exportButton"),
  editListButton: document.querySelector("#editListButton"),
  telegramSettingsButton: document.querySelector("#telegramSettingsButton"),
  customListPanel: document.querySelector("#customListPanel"),
  telegramPanel: document.querySelector("#telegramPanel"),
  accessRow: document.querySelector(".accessRow"),
  customFileInput: document.querySelector("#customFileInput"),
  importCustomFileButton: document.querySelector("#importCustomFileButton"),
  accessCodeInput: document.querySelector("#accessCodeInput"),
  customSymbolsInput: document.querySelector("#customSymbolsInput"),
  saveCustomListButton: document.querySelector("#saveCustomListButton"),
  scanCustomListButton: document.querySelector("#scanCustomListButton"),
  customListStatus: document.querySelector("#customListStatus"),
  telegramAccessCodeInput: document.querySelector("#telegramAccessCodeInput"),
  telegramBotTokenInput: document.querySelector("#telegramBotTokenInput"),
  telegramChatIdInput: document.querySelector("#telegramChatIdInput"),
  saveTelegramButton: document.querySelector("#saveTelegramButton"),
  telegramStatus: document.querySelector("#telegramStatus"),
  excelDownloadLink: document.querySelector("#excelDownloadLink"),
  csvDownloadLink: document.querySelector("#csvDownloadLink"),
  detailPanel: document.querySelector("#detailPanel")
};

elements.refreshButton.addEventListener("click", loadResults);
elements.scanButton.addEventListener("click", () => runScan());
elements.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  renderRows();
});
elements.scoreFilter.addEventListener("change", (event) => {
  state.minScore = Number(event.target.value);
  renderRows();
});
elements.exportButton.addEventListener("click", exportCsv);
elements.editListButton.addEventListener("click", async () => {
  elements.customListPanel.hidden = !elements.customListPanel.hidden;
  if (!elements.customListPanel.hidden) await loadCustomList();
});
elements.telegramSettingsButton.addEventListener("click", () => {
  elements.telegramPanel.hidden = !elements.telegramPanel.hidden;
  if (!elements.telegramPanel.hidden) {
    elements.telegramAccessCodeInput.value = getAccessCode();
    elements.telegramStatus.textContent = elements.telegramStatus.textContent || "Telegram not configured";
  }
});
elements.saveCustomListButton.addEventListener("click", saveCustomList);
elements.scanCustomListButton.addEventListener("click", () => runScan("custom"));
elements.importCustomFileButton.addEventListener("click", importCustomFile);
elements.saveTelegramButton.addEventListener("click", saveTelegramSettings);

document.querySelectorAll(".listTab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".listTab").forEach((tab) => tab.classList.remove("active"));
    button.classList.add("active");
    state.currentList = button.dataset.list;
    applyPayload(state.payload);
  });
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    renderRows();
  });
});

await loadResults();
configureMode();

async function loadResults() {
  if (cloudMode) {
    const response = await fetch(cloudApiUrl, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "Cloud results failed");
    applyPayload(payload.state || {});
    if (payload.customList?.count != null) {
      elements.customListStatus.textContent = `${payload.customList.count} cloud stocks`;
    }
    if (payload.telegram) renderTelegramStatus(payload.telegram);
    return;
  }

  const response = await fetch(staticMode ? "data/results.json" : "/api/results", { cache: "no-store" });
  const payload = await response.json();
  applyPayload(payload);
}

async function runScan(listId = state.currentList) {
  if (staticMode) {
    elements.scanMeta.textContent = cloudMode
      ? "Cloud mode updates automatically after the daily scan."
      : "Online free mode updates from GitHub Actions schedule.";
    return;
  }
  setBusy(true);
  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram: false, listId })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    applyPayload(payload);
  } catch (error) {
    elements.scanMeta.textContent = `Scan failed: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

function applyPayload(payload) {
  state.payload = payload || {};
  state.rows = rowsForCurrentList(state.payload);
  renderSummary(state.payload);
  renderRows();
}

function rowsForCurrentList(payload) {
  if (state.currentList === "all") return payload?.results || [];
  return payload?.lists?.[state.currentList]?.results || [];
}

function renderSummary(payload) {
  const listPayload = state.currentList === "all" ? payload : payload?.lists?.[state.currentList];
  const summary = listPayload?.summary || {};
  elements.totalCount.textContent = summary.total || 0;
  elements.entryCount.textContent = summary.entry || 0;
  elements.exitCount.textContent = summary.exit || 0;
  elements.watchCount.textContent = summary.watch || 0;
  elements.errorCount.textContent = summary.error || 0;
  elements.openTradesCount.textContent = payload.tradeSummary?.open || 0;
  elements.closedTradesCount.textContent = payload.tradeSummary?.closed || 0;
  elements.realizedPnl.textContent = compact(payload.tradeSummary?.realizedPnl || 0);
  const listLabel = state.currentList === "all" ? "All Lists" : listPayload?.label || state.currentList;
  const benchmarkLabel = payload.benchmarkLabel || payload.rules?.benchmarkLabel || payload.benchmark;
  elements.scanMeta.textContent = payload.scannedAt
    ? `Last scan ${formatDateTime(payload.scannedAt)} | ${listLabel} | Benchmark ${benchmarkLabel}`
    : "Waiting for first scan";
}

function renderRows() {
  const rows = filteredRows();
  elements.resultsBody.innerHTML = rows.map(rowHtml).join("");
  elements.emptyState.classList.toggle("visible", rows.length === 0);

  elements.resultsBody.querySelectorAll("tr").forEach((rowElement) => {
    rowElement.addEventListener("click", () => {
      const row = rows[Number(rowElement.dataset.index)];
      renderDetail(row);
    });
  });
}

function filteredRows() {
  return state.rows.filter((row) => {
    if (state.filter !== "ALL" && row.status !== state.filter) return false;
    if ((row.score || 0) < state.minScore) return false;
    if (!state.search) return true;
    const haystack = `${row.symbol} ${row.name} ${row.industry}`.toLowerCase();
    return haystack.includes(state.search);
  });
}

function rowHtml(row, index) {
  return `
    <tr data-index="${index}">
      <td><span class="pill ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.listLabel || "")}</td>
      <td class="symbolCell">
        <strong>${escapeHtml(row.symbol)}</strong>
        <span>${escapeHtml(row.name || row.yahooSymbol || "")}</span>
      </td>
      <td>${fmt(row.close)}</td>
      <td class="${row.dailyPriceAboveSupertrend ? "good" : "bad"}">${fmt(row.dailySupertrend)}</td>
      <td class="${classForAbove(row.weeklyRsi, 50)}">${fmt(row.weeklyRsi)}</td>
      <td class="${classForAbove(row.weeklyRs, 0)}">${pct(row.weeklyRs)}</td>
      <td class="${classForAbove(row.dailyLongRs, 0)}">${pct(row.dailyLongRs)}</td>
      <td class="${classForAbove(row.dailyShortRs, 0)}">${pct(row.dailyShortRs)}</td>
      <td class="${classForAbove(row.dailyRsi, 50)}">${fmt(row.dailyRsi)}</td>
      <td>${row.fundamentalScore || 0}/${row.fundamental?.maxScore || 5}</td>
      <td><strong>${row.score || 0}</strong></td>
      <td class="reasonCell">${escapeHtml((row.signalReason || []).join(" "))}</td>
    </tr>
  `;
}

function renderDetail(row) {
  const checks = row.fundamental?.checks || {};
  elements.detailPanel.innerHTML = `
    <div class="detailHeader">
      <div>
        <h2>${escapeHtml(row.symbol)} - ${escapeHtml(row.name || "")}</h2>
        <div class="neutral">${escapeHtml(row.industry || "")} | As of ${escapeHtml(row.asOf || "NA")}</div>
        <div class="neutral">${escapeHtml(row.listLabel || "")}</div>
      </div>
      <span class="pill ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>
    </div>
    <div class="reasonBlock">
      <strong>Signal Reason</strong>
      <p>${escapeHtml((row.signalReason || []).join(" "))}</p>
    </div>
    <div class="checkGrid">
      ${checkHtml("Net income YoY", checks.netIncomeYoYUp)}
      ${checkHtml("Operating income YoY", checks.operatingIncomeYoYUp)}
      ${checkHtml("EBITDA margin QoQ", checks.ebitdaMarginQoQUp, true)}
      ${checkHtml("EBITDA margin YoY", checks.ebitdaMarginYoYUp, true)}
      ${checkHtml("P/E rising", checks.peRising)}
    </div>
  `;
  elements.detailPanel.classList.add("visible");
  elements.detailPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadCustomList() {
  if (cloudMode) {
    elements.customSymbolsInput.value = "";
    elements.customListStatus.textContent = "Upload Excel/CSV to save My List in cloud.";
    return;
  }

  if (staticMode) {
    elements.customSymbolsInput.value = "";
    elements.customListStatus.textContent = "Update config/custom-symbols.xlsx in GitHub.";
    return;
  }
  const response = await fetch("/api/watchlists");
  const payload = await response.json();
  const custom = payload.lists.find((list) => list.id === "custom");
  elements.customSymbolsInput.value = (custom?.symbols || [])
    .map((item) => item.symbol)
    .join("\n");
  elements.customListStatus.textContent = `${custom?.count || 0} stocks`;
}

async function saveCustomList() {
  if (cloudMode) {
    try {
      await saveCloudCustomList(symbolsFromText(elements.customSymbolsInput.value));
    } catch (error) {
      elements.customListStatus.textContent = `Cloud save failed: ${error.message}`;
    }
    return;
  }

  if (staticMode) {
    elements.customListStatus.textContent = "Online free mode is read-only.";
    return;
  }
  elements.customListStatus.textContent = "Saving...";
  const response = await fetch("/api/watchlists/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols: elements.customSymbolsInput.value })
  });
  if (!response.ok) {
    elements.customListStatus.textContent = "Save failed";
    return;
  }
  const payload = await response.json();
  elements.customListStatus.textContent = `${payload.count} stocks saved`;
}

async function importCustomFile() {
  const file = elements.customFileInput.files?.[0];
  if (!file) {
    elements.customListStatus.textContent = "Select .xlsx/.csv file first";
    return;
  }

  setBusy(true);
  elements.importCustomFileButton.disabled = true;
  elements.customListStatus.textContent = "Importing file...";
  try {
    if (cloudMode) {
      const symbols = await parseSymbolsFromFile(file);
      elements.customSymbolsInput.value = symbols.join("\n");
      await saveCloudCustomList(symbols);
      elements.customListStatus.textContent = `${symbols.length} stocks uploaded to cloud`;
      return;
    }

    if (staticMode) {
      elements.customListStatus.textContent = "Upload config/custom-symbols.xlsx in GitHub.";
      return;
    }

    const dataBase64 = await fileToBase64(file);
    elements.customListStatus.textContent = "Saving list and scanning...";
    const response = await fetch("/api/watchlists/custom/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        dataBase64,
        scan: true,
        telegram: false
      })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || (await response.text()));
    }

    const payload = await response.json();
    elements.customSymbolsInput.value = (payload.symbols || []).join("\n");
    elements.customListStatus.textContent = `${payload.count} stocks imported and scanned`;
    state.currentList = "custom";
    document.querySelectorAll(".listTab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.list === "custom");
    });
    applyPayload(payload.scan);
  } catch (error) {
    elements.customListStatus.textContent = `Import failed: ${error.message}`;
  } finally {
    elements.importCustomFileButton.disabled = false;
    setBusy(false);
  }
}

async function saveCloudCustomList(symbols) {
  const accessCode = getAccessCode();
  if (!accessCode) {
    elements.customListStatus.textContent = "Enter access code first";
    return;
  }

  elements.customListStatus.textContent = "Saving to cloud...";
  const response = await fetch(cloudApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "save-custom-list",
      accessCode,
      symbols
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || "Cloud upload failed");
  localStorage.setItem("tfAccessCode", accessCode);
  syncAccessCodeInputs(accessCode);
  elements.customListStatus.textContent = `${payload.count} stocks saved in cloud`;
}

async function saveTelegramSettings() {
  if (!cloudMode) {
    elements.telegramStatus.textContent = "Telegram cloud setup is not active";
    return;
  }

  const accessCode = getAccessCode();
  const botToken = String(elements.telegramBotTokenInput.value || "").trim();
  const chatId = String(elements.telegramChatIdInput.value || "").trim();

  if (!accessCode) {
    elements.telegramStatus.textContent = "Enter access code first";
    return;
  }
  if (!botToken || !chatId) {
    elements.telegramStatus.textContent = "Enter bot token and chat ID";
    return;
  }

  elements.saveTelegramButton.disabled = true;
  elements.telegramStatus.textContent = "Saving Telegram...";
  try {
    const response = await fetch(cloudApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save-telegram-config",
        accessCode,
        botToken,
        chatId
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error || "Telegram save failed");
    localStorage.setItem("tfAccessCode", accessCode);
    syncAccessCodeInputs(accessCode);
    elements.telegramBotTokenInput.value = "";
    renderTelegramStatus(payload.telegram || { configured: true });
  } catch (error) {
    elements.telegramStatus.textContent = `Telegram save failed: ${error.message}`;
  } finally {
    elements.saveTelegramButton.disabled = false;
  }
}

function renderTelegramStatus(status) {
  if (!elements.telegramStatus) return;
  elements.telegramStatus.textContent = status?.configured ? "Telegram configured" : "Telegram not configured";
}

function checkHtml(label, check, asPercent = false) {
  const status = check?.ok === true ? "Good" : check?.ok === false ? "Weak" : "NA";
  const css = check?.ok === true ? "good" : check?.ok === false ? "bad" : "neutral";
  const latest = asPercent ? pct(check?.latest) : compact(check?.latest);
  const previous = asPercent ? pct(check?.previous) : compact(check?.previous);
  return `
    <div class="check">
      <span>${escapeHtml(label)}</span>
      <strong class="${css}">${status}</strong>
      <span>${latest} vs ${previous}</span>
    </div>
  `;
}

function exportCsv() {
  const headers = [
    "status",
    "list",
    "symbol",
    "name",
    "close",
    "dailySupertrend",
    "dailyPriceAboveSupertrend",
    "weeklyRsi",
    "weeklyRs",
    "dailyLongRs",
    "dailyShortRs",
    "dailyRsi",
    "fundamentalScore",
    "score",
    "reason"
  ];
  const lines = [headers.join(",")];
  filteredRows().forEach((row) => {
    const exportRow = {
      ...row,
      list: row.listLabel,
      reason: (row.signalReason || []).join(" ")
    };
    lines.push(headers.map((header) => csvValue(exportRow[header])).join(","));
  });
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "techno-funda-screener.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function setBusy(isBusy) {
  elements.scanButton.disabled = isBusy;
  elements.refreshButton.disabled = isBusy;
  elements.scanButton.textContent = isBusy ? "Scanning" : "Run Scan";
}

function configureMode() {
  if (!cloudMode && elements.accessRow) elements.accessRow.hidden = true;
  if (cloudMode) {
    elements.importCustomFileButton.textContent = "Import Excel & Save";
    elements.scanCustomListButton.hidden = true;
  }
  if (!cloudMode) {
    elements.telegramSettingsButton.hidden = true;
    elements.telegramPanel.hidden = true;
  }
  if (!staticMode) return;
  elements.scanButton.disabled = true;
  elements.scanButton.title = "Scan runs automatically in GitHub Actions";
  if (!cloudMode) elements.editListButton.hidden = true;
  if (elements.accessCodeInput) {
    elements.accessCodeInput.value = localStorage.getItem("tfAccessCode") || "";
  }
  if (elements.telegramAccessCodeInput) {
    elements.telegramAccessCodeInput.value = localStorage.getItem("tfAccessCode") || "";
  }
  elements.excelDownloadLink.href = "data/techno-funda-trade-sheet.xlsx";
  elements.csvDownloadLink.href = "data/techno-funda-trade-sheet.csv";
}

function classForAbove(value, threshold) {
  if (!Number.isFinite(value)) return "neutral";
  return value > threshold ? "good" : "bad";
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "NA";
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "NA";
}

function compact(value) {
  if (!Number.isFinite(value)) return "NA";
  return Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function csvValue(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

async function parseSymbolsFromFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    if (!window.ExcelJS) throw new Error("Excel reader not loaded");
    const buffer = await file.arrayBuffer();
    const workbook = new window.ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return [];

    const candidates = [];
    const headerColumns = findHeaderColumns(worksheet);
    if (headerColumns.length > 0) {
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        headerColumns.forEach((colNumber) => candidates.push(cellText(row.getCell(colNumber))));
      });
    } else {
      worksheet.eachRow((row) => row.eachCell((cell) => candidates.push(cellText(cell))));
    }
    return normalizeCandidates(candidates);
  }

  return normalizeCandidates([await file.text()]);
}

function findHeaderColumns(worksheet) {
  const headerKeys = new Set([
    "symbol",
    "ticker",
    "trading_symbol",
    "tradingview_symbol",
    "trading_view_symbol",
    "tv_symbol",
    "scrip",
    "stock",
    "stocks"
  ]);
  const columns = [];
  worksheet.getRow(1).eachCell((cell, colNumber) => {
    const key = cellText(cell)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (headerKeys.has(key)) columns.push(colNumber);
  });
  return columns;
}

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text) return value.text;
    if (value.result != null) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
  }
  return String(value);
}

function symbolsFromText(text) {
  return normalizeCandidates([text]);
}

function normalizeCandidates(candidates) {
  const seen = new Set();
  const symbols = [];
  for (const candidate of candidates) {
    for (const token of tokenize(candidate)) {
      const symbol = normalizeTradingViewSymbol(token);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      symbols.push(symbol);
    }
  }
  return symbols;
}

function tokenize(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const matches = text.match(/\b(?:NSE|BSE):[A-Z0-9&._-]+\b/gi);
  if (matches?.length) return matches;
  return text.split(/[\s,;|]+/).map((token) => token.trim()).filter(Boolean);
}

function normalizeTradingViewSymbol(value) {
  const raw = String(value || "").trim().replace(/["'`]/g, "").toUpperCase();
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "");
  const colon = compact.match(/^([A-Z]{2,8}):([A-Z0-9&._-]+)$/);
  if (colon) {
    const exchange = colon[1];
    const symbol = colon[2].replace(/\.(NS|BO)$/i, "");
    return exchange === "NSE" ? symbol : `${exchange}:${symbol}`;
  }

  const suffix = compact.match(/^([A-Z0-9&_-]+)\.(NS|BO)$/);
  if (suffix) return suffix[2] === "NS" ? suffix[1] : `BSE:${suffix[1]}`;
  return compact.replace(/[^A-Z0-9&_-]/g, "");
}

function getAccessCode() {
  return String(
    elements.accessCodeInput?.value ||
      elements.telegramAccessCodeInput?.value ||
      localStorage.getItem("tfAccessCode") ||
      ""
  ).trim();
}

function syncAccessCodeInputs(accessCode) {
  if (elements.accessCodeInput) elements.accessCodeInput.value = accessCode;
  if (elements.telegramAccessCodeInput) elements.telegramAccessCodeInput.value = accessCode;
}
