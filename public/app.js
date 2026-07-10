const state = {
  payload: null,
  rows: [],
  currentList: "all-market",
  filter: "ALL",
  search: "",
  minScore: 0,
  displayLimit: 250,
  cloudTradeSettings: null,
  cloudTelegram: null
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
  pendingTradesCount: document.querySelector("#pendingTradesCount"),
  closedTradesCount: document.querySelector("#closedTradesCount"),
  realizedPnl: document.querySelector("#realizedPnl"),
  unrealizedPnl: document.querySelector("#unrealizedPnl"),
  tradeScopeText: document.querySelector("#tradeScopeText"),
  tradeQualityText: document.querySelector("#tradeQualityText"),
  positionsBody: document.querySelector("#positionsBody"),
  positionsEmpty: document.querySelector("#positionsEmpty"),
  resultsBody: document.querySelector("#resultsBody"),
  emptyState: document.querySelector("#emptyState"),
  refreshButton: document.querySelector("#refreshButton"),
  scanButton: document.querySelector("#scanButton"),
  searchInput: document.querySelector("#searchInput"),
  resultCount: document.querySelector("#resultCount"),
  scoreFilter: document.querySelector("#scoreFilter"),
  exportButton: document.querySelector("#exportButton"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  editListButton: document.querySelector("#editListButton"),
  tradeSettingsButton: document.querySelector("#tradeSettingsButton"),
  telegramSettingsButton: document.querySelector("#telegramSettingsButton"),
  customListPanel: document.querySelector("#customListPanel"),
  tradeSettingsPanel: document.querySelector("#tradeSettingsPanel"),
  telegramPanel: document.querySelector("#telegramPanel"),
  accessRow: document.querySelector(".accessRow"),
  customFileInput: document.querySelector("#customFileInput"),
  importCustomFileButton: document.querySelector("#importCustomFileButton"),
  accessCodeInput: document.querySelector("#accessCodeInput"),
  customSymbolsInput: document.querySelector("#customSymbolsInput"),
  saveCustomListButton: document.querySelector("#saveCustomListButton"),
  scanCustomListButton: document.querySelector("#scanCustomListButton"),
  customListStatus: document.querySelector("#customListStatus"),
  tradeAccessCodeInput: document.querySelector("#tradeAccessCodeInput"),
  tradeScopeSelect: document.querySelector("#tradeScopeSelect"),
  tradeQualitySelect: document.querySelector("#tradeQualitySelect"),
  saveTradeSettingsButton: document.querySelector("#saveTradeSettingsButton"),
  tradeSettingsStatus: document.querySelector("#tradeSettingsStatus"),
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
  state.displayLimit = 250;
  renderRows();
});
elements.scoreFilter.addEventListener("change", (event) => {
  state.minScore = Number(event.target.value);
  state.displayLimit = 250;
  renderRows();
});
elements.exportButton.addEventListener("click", exportCsv);
elements.loadMoreButton.addEventListener("click", () => {
  state.displayLimit += 250;
  renderRows();
});
elements.editListButton.addEventListener("click", async () => {
  elements.customListPanel.hidden = !elements.customListPanel.hidden;
  if (!elements.customListPanel.hidden) await loadCustomList();
});
elements.telegramSettingsButton.addEventListener("click", () => {
  elements.telegramPanel.hidden = !elements.telegramPanel.hidden;
  if (!elements.telegramPanel.hidden) {
    elements.telegramAccessCodeInput.value = getAccessCode();
    renderTelegramStatus(state.cloudTelegram || state.payload?.telegram);
    if (state.cloudTelegram?.configured) {
      elements.telegramBotTokenInput.placeholder = "Saved bot token - leave blank";
      elements.telegramChatIdInput.placeholder = "Saved chat ID - leave blank";
    }
  }
});
elements.tradeSettingsButton.addEventListener("click", () => {
  elements.tradeSettingsPanel.hidden = !elements.tradeSettingsPanel.hidden;
  if (!elements.tradeSettingsPanel.hidden) {
    elements.tradeAccessCodeInput.value = getAccessCode();
    renderTradeSettings(state.cloudTradeSettings || state.payload?.tradeSettings);
  }
});
elements.saveCustomListButton.addEventListener("click", saveCustomList);
elements.scanCustomListButton.addEventListener("click", () => runScan("custom"));
elements.importCustomFileButton.addEventListener("click", importCustomFile);
elements.saveTradeSettingsButton.addEventListener("click", saveTradeSettings);
elements.saveTelegramButton.addEventListener("click", saveTelegramSettings);

document.querySelectorAll(".listTab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".listTab").forEach((tab) => tab.classList.remove("active"));
    button.classList.add("active");
    state.currentList = button.dataset.list;
    state.displayLimit = 250;
    applyPayload(state.payload);
  });
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    state.displayLimit = 250;
    renderRows();
  });
});

await loadResults();
configureMode();

async function loadResults() {
  if (staticMode) {
    const response = await fetch(`data/results.json?v=${Date.now()}`, { cache: "reload" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Static results failed");
    applyPayload(payload);

    if (cloudMode) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const metaUrl = new URL(cloudApiUrl);
        metaUrl.searchParams.set("view", "meta");
        const metaResponse = await fetch(metaUrl, {
          cache: "no-store",
          signal: controller.signal
        });
        const meta = await metaResponse.json();
        if (metaResponse.ok && !meta.error) {
          if (meta.customList?.count != null) {
            elements.customListStatus.textContent = `${meta.customList.count} cloud stocks`;
          }
          if (meta.tradeSettings) {
            state.cloudTradeSettings = meta.tradeSettings;
            renderTradeSettings(meta.tradeSettings, { updateBadges: false });
          }
          if (meta.telegram) {
            state.cloudTelegram = meta.telegram;
          }
          renderTelegramStatus(meta.telegram);
        }
      } catch {
        elements.scanMeta.textContent += " | Cloud settings temporarily unavailable";
      } finally {
        clearTimeout(timeout);
      }
    }
    return;
  }

  if (cloudMode) {
    try {
      const response = await fetch(cloudApiUrl, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.error || !payload.state) {
        throw new Error(payload.error || "Cloud results unavailable");
      }
      applyPayload(payload.state);
      if (payload.customList?.count != null) {
        elements.customListStatus.textContent = `${payload.customList.count} cloud stocks`;
      }
      if (payload.telegram || payload.state?.telegram) {
        state.cloudTelegram = payload.telegram || state.cloudTelegram;
        renderTelegramStatus(payload.telegram, payload.state?.telegram);
      }
      if (payload.tradeSettings || payload.state?.tradeSettings) {
        state.cloudTradeSettings = payload.tradeSettings || payload.state?.tradeSettings;
        renderTradeSettings(state.cloudTradeSettings, { updateBadges: false });
      }
      return;
    } catch (error) {
      throw error;
    }
    return;
  }

  const response = await fetch("/api/results", { cache: "no-store" });
  const payload = await response.json();
  applyPayload(payload);
}

async function runScan(listId = state.currentList) {
  if (staticMode) {
    elements.scanMeta.textContent = "Checking latest published cloud scan...";
    await loadResults();
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
  renderTradeSettings(state.payload.tradeSettings);
  updateDownloadLinks(state.payload);
  renderPositions(state.payload);
  renderRows();
}

function rowsForCurrentList(payload) {
  if (state.currentList === "all") {
    if (Array.isArray(payload?.results)) return payload.results;
    const seen = new Set();
    return Object.values(payload?.lists || {}).flatMap((list) =>
      (list.results || []).filter((row) => {
        const key = row.yahooSymbol || row.symbol;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    );
  }
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
  elements.pendingTradesCount.textContent =
    (payload.tradeSummary?.pendingEntry || 0) + (payload.tradeSummary?.pendingExit || 0);
  elements.closedTradesCount.textContent = payload.tradeSummary?.closed || 0;
  elements.realizedPnl.textContent = compact(payload.tradeSummary?.realizedPnl || 0);
  elements.unrealizedPnl.textContent = compact(payload.tradeSummary?.unrealizedPnl || 0);
  elements.tradeScopeText.textContent = payload.tradeSettings?.scopeLabel || "All NSE Market";
  elements.tradeQualityText.textContent = payload.tradeSettings?.qualityLabel || "Best only";
  const listLabel = state.currentList === "all" ? "All Lists" : listPayload?.label || state.currentList;
  const benchmarkLabel = payload.benchmarkLabel || payload.rules?.benchmarkLabel || payload.benchmark;
  const staleText = payload.scannedAt && isStaleScan(payload.scannedAt) ? " | Stale: waiting for next cloud scan" : "";
  elements.scanMeta.textContent = payload.scannedAt
    ? `Last scan ${formatDateTime(payload.scannedAt)} | ${listLabel} | Benchmark ${benchmarkLabel}${staleText}`
    : "Waiting for first scan";
}

function renderPositions(payload) {
  const trades = (payload?.trades || []).filter((trade) =>
    ["PENDING_ENTRY", "OPEN", "PENDING_EXIT"].includes(trade.status)
  );
  elements.positionsBody.innerHTML = trades
    .map((trade) => {
      const pnl = trade.unrealizedPnl;
      const pnlClass = Number(pnl) > 0 ? "good" : Number(pnl) < 0 ? "bad" : "neutral";
      const signalDate = trade.exitSignalDate || trade.entrySignalDate || "";
      const reason =
        trade.status === "PENDING_EXIT" ? trade.exitReason || [] : trade.entryReason || [];
      return `
        <tr>
          <td><span class="pill ${escapeHtml(trade.status)}">${escapeHtml(trade.status.replace("_", " "))}</span></td>
          <td class="symbolCell"><strong>${escapeHtml(trade.symbol)}</strong><span>${escapeHtml(trade.listLabel || "")}</span></td>
          <td>${escapeHtml(signalDate)}</td>
          <td>${escapeHtml(trade.entryDate || "Waiting")}</td>
          <td>${fmt(trade.entryPrice)}</td>
          <td>${trade.quantity ?? "NA"}</td>
          <td>${fmt(trade.lastPrice)}</td>
          <td class="${pnlClass}">${compact(pnl)}${Number.isFinite(trade.unrealizedPnlPct) ? ` (${compact(trade.unrealizedPnlPct)}%)` : ""}</td>
          <td class="reasonCell">${escapeHtml(reason.join(" "))}</td>
        </tr>
      `;
    })
    .join("");
  elements.positionsEmpty.classList.toggle("visible", trades.length === 0);
}

function renderRows() {
  const filtered = filteredRows();
  const rows = filtered.slice(0, state.displayLimit);
  elements.resultsBody.innerHTML = rows.map(rowHtml).join("");
  elements.emptyState.classList.toggle("visible", rows.length === 0);
  elements.resultCount.textContent = `${rows.length} / ${filtered.length}`;
  elements.loadMoreButton.hidden = rows.length >= filtered.length;

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
      <td><strong>${escapeHtml(row.setupGrade || "")} ${row.score || 0}</strong></td>
      <td class="reasonCell">${escapeHtml((row.signalReason || []).join(" "))}</td>
    </tr>
  `;
}

function renderDetail(row) {
  const checks = row.fundamental?.checks || {};
  const setup = row.setupStrength || {};
  const setupChecks = setup.checks || {};
  const setupValues = setup.values || {};
  const sector = row.sectorStrength || {};
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
    <div class="reasonBlock">
      <strong>Video RS Strength</strong>
      <p>${escapeHtml(strengthReasons(row).join(" "))}</p>
    </div>
    <div class="checkGrid">
      ${setupCheckHtml("55D breakout", setupChecks.recentHighBreakout, setupValues.priorRecentHigh)}
      ${setupCheckHtml("52W high zone", setupChecks.nearYearHigh, setupValues.priorYearHigh)}
      ${setupCheckHtml("Volume shocker", setupChecks.volumeExpansion, setupValues.volumeRatio, "x")}
      ${setupCheckHtml("RS55 rising", setupChecks.dailyLongRsRising)}
      ${setupCheckHtml("50/200 DMA", setupChecks.smaFastAboveSlow)}
      ${setupCheckHtml("Risk to ST", setupChecks.favorableRiskToSupertrend, setupValues.riskToSupertrendPct, "%")}
      ${setupCheckHtml("ATR control", setupChecks.controlledVolatility, setupValues.atrPct, "%")}
      ${setupCheckHtml("Liquidity", setupChecks.liquidEnough, setupValues.averageTurnover)}
      ${setupCheckHtml("Candle", setupChecks.bullishCandleConfirmation || setupChecks.bullishEngulfing || setupChecks.hammer)}
      ${setupCheckHtml("Market regime", setupChecks.marketRegimeStrong)}
      ${setupCheckHtml("Sector breadth", sector.ok, sector.breadthPct, "%")}
      ${setupCheckHtml("Prev candle low", Number.isFinite(setupValues.previousLow), setupValues.previousLow)}
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

async function saveTradeSettings() {
  if (!cloudMode) {
    elements.tradeSettingsStatus.textContent = "Trade settings cloud setup is not active";
    return;
  }

  const accessCode = getAccessCode();
  if (!accessCode) {
    elements.tradeSettingsStatus.textContent = "Enter access code first";
    return;
  }

  elements.saveTradeSettingsButton.disabled = true;
  elements.tradeSettingsStatus.textContent = "Saving trade settings...";
  try {
    const response = await fetch(cloudApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save-trade-settings",
        accessCode,
        scopeListId: elements.tradeScopeSelect.value,
        qualityMode: elements.tradeQualitySelect.value
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error || "Trade settings save failed");
    localStorage.setItem("tfAccessCode", accessCode);
    syncAccessCodeInputs(accessCode);
    state.cloudTradeSettings = payload.tradeSettings || state.cloudTradeSettings;
    renderTradeSettings(payload.tradeSettings, { updateBadges: false });
    elements.tradeSettingsStatus.textContent = "Saved in cloud. Next scheduled scan will use this selection.";
  } catch (error) {
    elements.tradeSettingsStatus.textContent = `Trade settings save failed: ${error.message}`;
  } finally {
    elements.saveTradeSettingsButton.disabled = false;
  }
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
  if ((!botToken || !chatId) && !state.cloudTelegram?.configured) {
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
    state.cloudTelegram = payload.telegram || state.cloudTelegram || { configured: true };
    elements.telegramBotTokenInput.value = "";
    elements.telegramChatIdInput.value = "";
    elements.telegramBotTokenInput.placeholder = "Saved bot token - leave blank";
    elements.telegramChatIdInput.placeholder = "Saved chat ID - leave blank";
    renderTelegramStatus(payload.telegram || { configured: true });
  } catch (error) {
    elements.telegramStatus.textContent = `Telegram save failed: ${error.message}`;
  } finally {
    elements.saveTelegramButton.disabled = false;
  }
}

function renderTelegramStatus(status, latestStatus = null) {
  if (!elements.telegramStatus) return;
  const latestReason = String(latestStatus?.reason || "");
  if (latestStatus && latestStatus.sent === false && !["disabled", "no new entry/exit trade events"].some((text) => latestReason.includes(text))) {
    elements.telegramStatus.textContent = `Telegram configured, latest alert failed: ${latestReason}`;
    return;
  }
  elements.telegramStatus.textContent = status?.configured ? "Telegram configured" : "Telegram not configured";
}

function renderTradeSettings(settings, options = {}) {
  if (!settings) return;
  const updateBadges = options.updateBadges !== false;
  if (elements.tradeScopeSelect && settings.scopeListId) {
    elements.tradeScopeSelect.value = settings.scopeListId;
  }
  if (elements.tradeQualitySelect && settings.qualityMode) {
    elements.tradeQualitySelect.value = settings.qualityMode;
  }
  if (updateBadges && elements.tradeScopeText) {
    elements.tradeScopeText.textContent = settings.scopeLabel || "All NSE Market";
  }
  if (updateBadges && elements.tradeQualityText) {
    elements.tradeQualityText.textContent = settings.qualityLabel || "Best only";
  }
  if (elements.tradeSettingsStatus) {
    const updated = settings.updatedAt ? ` | saved ${formatDateTime(settings.updatedAt)}` : "";
    elements.tradeSettingsStatus.textContent =
      `${settings.scopeLabel || "All NSE Market"} | ${settings.qualityLabel || "Best only"}${updated}`;
  }
}

function updateDownloadLinks(payload) {
  if (!staticMode) return;
  const version = encodeURIComponent(payload?.scannedAt || Date.now());
  elements.excelDownloadLink.href = `data/techno-funda-trade-sheet.xlsx?v=${version}`;
  elements.csvDownloadLink.href = `data/techno-funda-trade-sheet.csv?v=${version}`;
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

function setupCheckHtml(label, ok, value, suffix = "") {
  const css = ok === true ? "good" : ok === false ? "bad" : "neutral";
  const status = ok === true ? "Good" : ok === false ? "Weak" : "NA";
  const number = Number.isFinite(value) ? `${compact(value)}${suffix}` : "";
  return `
    <div class="check">
      <span>${escapeHtml(label)}</span>
      <strong class="${css}">${status}</strong>
      <span>${escapeHtml(number)}</span>
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
    "setupStrengthScore",
    "sectorBreadth",
    "near52WeekHigh",
    "recentHighBreakout",
    "volumeRatio",
    "riskToSupertrendPct",
    "previousLow",
    "score",
    "reason"
  ];
  const lines = [headers.join(",")];
  filteredRows().forEach((row) => {
    const exportRow = {
      ...row,
      list: row.listLabel,
      sectorBreadth: Number.isFinite(row.sectorStrength?.breadthPct)
        ? `${compact(row.sectorStrength.breadthPct)}%`
        : "",
      near52WeekHigh: row.setupStrength?.checks?.nearYearHigh ? "Yes" : "No",
      recentHighBreakout: row.setupStrength?.checks?.recentHighBreakout ? "Yes" : "No",
      volumeRatio: Number.isFinite(row.setupStrength?.values?.volumeRatio)
        ? compact(row.setupStrength.values.volumeRatio)
        : "",
      riskToSupertrendPct: Number.isFinite(row.setupStrength?.values?.riskToSupertrendPct)
        ? compact(row.setupStrength.values.riskToSupertrendPct)
        : "",
      previousLow: Number.isFinite(row.setupStrength?.values?.previousLow)
        ? compact(row.setupStrength.values.previousLow)
        : "",
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
    elements.tradeSettingsButton.hidden = true;
    elements.tradeSettingsPanel.hidden = true;
  }
  if (!staticMode) return;
  elements.scanButton.textContent = "Refresh Latest";
  elements.scanButton.title = "Free cloud scan runs automatically at 08:00 and 09:25 IST";
  if (!cloudMode) elements.editListButton.hidden = true;
  if (elements.accessCodeInput) {
    elements.accessCodeInput.value = localStorage.getItem("tfAccessCode") || "";
  }
  if (elements.tradeAccessCodeInput) {
    elements.tradeAccessCodeInput.value = localStorage.getItem("tfAccessCode") || "";
  }
  if (elements.telegramAccessCodeInput) {
    elements.telegramAccessCodeInput.value = localStorage.getItem("tfAccessCode") || "";
  }
  updateDownloadLinks(state.payload);
}

function classForAbove(value, threshold) {
  if (!Number.isFinite(value)) return "neutral";
  return value > threshold ? "good" : "bad";
}

function strengthReasons(row) {
  const prefixes = [
    "Price action",
    "52-week",
    "Volume",
    "RS trend",
    "Trend strength",
    "Risk reference",
    "Price confirmation",
    "Volatility",
    "Liquidity",
    "Market regime",
    "Sector breadth"
  ];
  return (row.signalReason || []).filter((reason) =>
    prefixes.some((prefix) => reason.startsWith(prefix))
  );
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

function isStaleScan(value) {
  const scanTime = new Date(value).getTime();
  if (!Number.isFinite(scanTime)) return false;
  return Date.now() - scanTime > 26 * 60 * 60 * 1000;
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
      elements.tradeAccessCodeInput?.value ||
      elements.telegramAccessCodeInput?.value ||
      localStorage.getItem("tfAccessCode") ||
      ""
  ).trim();
}

function syncAccessCodeInputs(accessCode) {
  if (elements.accessCodeInput) elements.accessCodeInput.value = accessCode;
  if (elements.tradeAccessCodeInput) elements.tradeAccessCodeInput.value = accessCode;
  if (elements.telegramAccessCodeInput) elements.telegramAccessCodeInput.value = accessCode;
}
