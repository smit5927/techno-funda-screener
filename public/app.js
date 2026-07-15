const state = {
  payload: null,
  rows: [],
  currentView: new URLSearchParams(window.location.search).get("view") || localStorage.getItem("tfMainView") || "dashboard",
  currentList: "all-market",
  filter: "ALL",
  search: "",
  minScore: 0,
  displayLimit: 250,
  cloudTradeSettings: null,
  cloudTelegram: null,
  liveMtm: null,
  liveMtmTimer: null,
  lastPositionPrices: new Map(),
  hasAnimatedCounts: false,
  positionSort: new URLSearchParams(window.location.search).get("sort") || localStorage.getItem("tfPositionSort") || "default",
  positionSortDirection: new URLSearchParams(window.location.search).get("direction") || localStorage.getItem("tfPositionSortDirection") || "desc"
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
  dataGapCount: document.querySelector("#dataGapCount"),
  errorCount: document.querySelector("#errorCount"),
  openTradesCount: document.querySelector("#openTradesCount"),
  pendingTradesCount: document.querySelector("#pendingTradesCount"),
  closedTradesCount: document.querySelector("#closedTradesCount"),
  realizedPnl: document.querySelector("#realizedPnl"),
  unrealizedPnl: document.querySelector("#unrealizedPnl"),
  tradeScopeText: document.querySelector("#tradeScopeText"),
  tradeQualityText: document.querySelector("#tradeQualityText"),
  totalCapital: document.querySelector("#totalCapital"),
  deployedCapital: document.querySelector("#deployedCapital"),
  availableCash: document.querySelector("#availableCash"),
  portfolioRisk: document.querySelector("#portfolioRisk"),
  liveStopRisk: document.querySelector("#liveStopRisk"),
  liveMtmStatus: document.querySelector("#liveMtmStatus"),
  positionsBody: document.querySelector("#positionsBody"),
  positionsEmpty: document.querySelector("#positionsEmpty"),
  dashboardPositionsBody: document.querySelector("#dashboardPositionsBody"),
  dashboardPositionsEmpty: document.querySelector("#dashboardPositionsEmpty"),
  openPositionsViewButton: document.querySelector("#openPositionsViewButton"),
  positionSortSelect: document.querySelector("#positionSortSelect"),
  positionSortDirection: document.querySelector("#positionSortDirection"),
  candidatesBody: document.querySelector("#candidatesBody"),
  candidatesEmpty: document.querySelector("#candidatesEmpty"),
  candidateDecisionsBody: document.querySelector("#candidateDecisionsBody"),
  candidateDecisionsEmpty: document.querySelector("#candidateDecisionsEmpty"),
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
  totalCapitalInput: document.querySelector("#totalCapitalInput"),
  addCapitalInput: document.querySelector("#addCapitalInput"),
  maxOpenPositionsInput: document.querySelector("#maxOpenPositionsInput"),
  riskPerTradeInput: document.querySelector("#riskPerTradeInput"),
  maxPortfolioRiskInput: document.querySelector("#maxPortfolioRiskInput"),
  maxPositionInput: document.querySelector("#maxPositionInput"),
  maxSectorExposureInput: document.querySelector("#maxSectorExposureInput"),
  pyramidingEnabledInput: document.querySelector("#pyramidingEnabledInput"),
  saveTradeSettingsButton: document.querySelector("#saveTradeSettingsButton"),
  tradeSettingsStatus: document.querySelector("#tradeSettingsStatus"),
  telegramAccessCodeInput: document.querySelector("#telegramAccessCodeInput"),
  telegramBotTokenInput: document.querySelector("#telegramBotTokenInput"),
  telegramChatIdInput: document.querySelector("#telegramChatIdInput"),
  saveTelegramButton: document.querySelector("#saveTelegramButton"),
  telegramStatus: document.querySelector("#telegramStatus"),
  excelDownloadLink: document.querySelector("#excelDownloadLink"),
  csvDownloadLink: document.querySelector("#csvDownloadLink"),
  topExcelDownloadLink: document.querySelector("#topExcelDownloadLink"),
  topCsvDownloadLink: document.querySelector("#topCsvDownloadLink"),
  dashboardExcelDownloadLink: document.querySelector("#dashboardExcelDownloadLink"),
  dashboardCsvDownloadLink: document.querySelector("#dashboardCsvDownloadLink"),
  detailPanel: document.querySelector("#detailPanel"),
  detailBackdrop: document.querySelector("#detailBackdrop")
};

elements.refreshButton.addEventListener("click", refreshPublishedData);
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
document.querySelectorAll(".mainNavTab").forEach((button) => {
  button.addEventListener("click", () => setMainView(button.dataset.view));
});
elements.openPositionsViewButton.addEventListener("click", () => setMainView("positions"));
elements.positionSortSelect.addEventListener("change", (event) => {
  state.positionSort = event.target.value;
  state.positionSortDirection = state.positionSort === "symbol" ? "asc" : "desc";
  persistPositionSort();
  updatePositionSortDirection();
  renderPositions(state.payload);
});
elements.positionSortDirection.addEventListener("click", () => {
  state.positionSortDirection = state.positionSortDirection === "desc" ? "asc" : "desc";
  persistPositionSort();
  updatePositionSortDirection();
  renderPositions(state.payload);
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
elements.detailBackdrop.addEventListener("click", closeDetail);

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
    setStatusFilter(button.dataset.filter);
  });
});

document.querySelectorAll(".metric[data-summary-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    setStatusFilter(button.dataset.summaryFilter);
    setMainView("screener");
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetail();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && cloudMode) fetchLiveMtm();
});

configureMode();
setMainView(state.currentView, { persist: false, scroll: false, animate: false });
if (![...elements.positionSortSelect.options].some((option) => option.value === state.positionSort)) state.positionSort = "default";
if (!["asc", "desc"].includes(state.positionSortDirection)) state.positionSortDirection = "desc";
elements.positionSortSelect.value = state.positionSort;
updatePositionSortDirection();
await loadResults();

function setMainView(view, options = {}) {
  const allowedViews = ["dashboard", "positions", "candidates", "screener", "settings", "admin"];
  const nextView = allowedViews.includes(view) ? view : "dashboard";
  const previousView = state.currentView;
  const applyView = () => {
    state.currentView = nextView;
    document.body.dataset.currentView = nextView;
    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== nextView;
    });
    document.querySelectorAll(".mainNavTab").forEach((button) => {
      const active = button.dataset.view === nextView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (options.persist !== false) {
      localStorage.setItem("tfMainView", nextView);
      const url = new URL(window.location.href);
      url.searchParams.set("view", nextView);
      window.history.replaceState({}, "", url);
    }
  };
  const canAnimate = options.animate !== false && previousView !== nextView && typeof document.startViewTransition === "function";
  if (canAnimate) document.startViewTransition(applyView);
  else applyView();
  if (options.scroll !== false) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }
}

async function loadResults() {
  if (cloudMode && window.TF_AUTH_MODE) {
    const response = await fetch(cloudApiUrl, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || payload.error || !payload.state) {
      throw new Error(payload.error || "Secure cloud results unavailable");
    }
    applyPayload(payload.state);
    if (payload.customList?.count != null) {
      elements.customListStatus.textContent = `${payload.customList.count} stocks in My List`;
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
  }

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
  renderCandidates(state.payload);
  renderCandidateDecisions(state.payload);
  renderRows();
  startLiveMtm();
  if (!document.body.classList.contains("appReady")) {
    requestAnimationFrame(() => document.body.classList.add("appReady"));
  }
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
  const summaryCounts = [
    [elements.totalCount, summary.total || 0],
    [elements.entryCount, summary.entry || 0],
    [elements.exitCount, summary.exit || 0],
    [elements.watchCount, summary.watch || 0],
    [elements.dataGapCount, summary.dataGap || 0],
    [elements.errorCount, summary.error || 0]
  ];
  if (!state.hasAnimatedCounts) {
    summaryCounts.forEach(([element, value], index) => animateCount(element, value, index * 45));
    state.hasAnimatedCounts = true;
  } else {
    summaryCounts.forEach(([element, value]) => { element.textContent = value; });
  }
  elements.openTradesCount.textContent = payload.tradeSummary?.open || 0;
  elements.pendingTradesCount.textContent =
    (payload.tradeSummary?.pendingEntry || 0) +
    (payload.tradeSummary?.pendingExit || 0) +
    (payload.tradeSummary?.pendingPartialExit || 0);
  elements.closedTradesCount.textContent = payload.tradeSummary?.closed || 0;
  elements.realizedPnl.textContent = compact(payload.tradeSummary?.realizedPnl || 0);
  const unrealizedPct = payload.portfolioSummary?.unrealizedPnlPct;
  elements.unrealizedPnl.textContent = `${compact(payload.tradeSummary?.unrealizedPnl || 0)}${Number.isFinite(unrealizedPct) ? ` (${compact(unrealizedPct)}%)` : ""}`;
  elements.tradeScopeText.textContent = payload.tradeSettings?.scopeLabel || "All NSE Market";
  elements.tradeQualityText.textContent = payload.tradeSettings?.qualityLabel || "Best only";
  const portfolio = payload.portfolioSummary || {};
  elements.totalCapital.textContent = compact(portfolio.totalCapital || payload.tradeSettings?.totalCapital || 1000000);
  elements.deployedCapital.textContent = compact(portfolio.deployedCapital || 0);
  elements.availableCash.textContent = compact(portfolio.availableCash || 0);
  elements.availableCash.title = `Deployable cash; actual cash ${compact(portfolio.actualCash || portfolio.availableCash || 0)}. Market ${portfolio.marketRiskMode || "NA"}, exposure cap ${compact(portfolio.effectiveExposureCapPct ?? 100)}%.`;
  elements.portfolioRisk.textContent = `${compact(portfolio.portfolioRisk || 0)} (${compact(portfolio.portfolioRiskPct || 0)}%)`;
  const listLabel = state.currentList === "all" ? "All Lists" : listPayload?.label || state.currentList;
  const benchmarkLabel = payload.benchmarkLabel || payload.rules?.benchmarkLabel || payload.benchmark;
  const staleText = payload.scannedAt && isStaleScan(payload.scannedAt) ? " | Stale: waiting for next cloud scan" : "";
  const institutionalText = institutionalMeta(payload.institutionalContext);
  const aiText = aiReviewMeta(payload.aiReview);
  const scanTimestamp = payload.scanMode === "EXECUTION_PASS"
    ? `Execution pass ${formatDateTime(payload.executionPassAt || payload.scannedAt)} | Full scan ${formatDateTime(payload.fullScanAt || payload.scannedAt)}`
    : `Last scan ${formatDateTime(payload.scannedAt)}`;
  elements.scanMeta.textContent = payload.scannedAt
    ? `${scanTimestamp} | ${listLabel} | Benchmark ${benchmarkLabel} | Risk ${payload.marketContext?.riskMode || "NA"}, cap ${compact(payload.marketContext?.exposureCapPct ?? 100)}%${institutionalText}${aiText}${staleText}`
    : "Waiting for first scan";
}

function institutionalMeta(context) {
  if (!context?.enabled) return "";
  const indexBias = context.index?.primaryBias || "NA";
  const fnoCount = context.derivatives?.fnoSymbolCount ?? "NA";
  const optionStatus = context.options?.dataAvailable ? "OK" : "Gap";
  const commodityStatus = context.commodity?.dataAvailable ? context.commodity.riskMode || "OK" : "Gap";
  return ` | Institutional ${indexBias}, F&O ${fnoCount}, Options ${optionStatus}, Commodity ${commodityStatus}`;
}

function renderPositions(payload) {
  const trades = sortPositionTrades((payload?.trades || []).filter((trade) =>
    ["PENDING_ENTRY", "OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status)
  ));
  elements.positionsBody.innerHTML = trades
    .map((trade, index) => {
      const livePosition = findLivePosition(trade);
      const displayPrice = Number.isFinite(livePosition?.ltp) ? livePosition.ltp : trade.lastPrice;
      const pnl = Number.isFinite(livePosition?.unrealizedPnl)
        ? livePosition.unrealizedPnl
        : trade.unrealizedPnl;
      const pnlPct = Number.isFinite(livePosition?.unrealizedPnlPct)
        ? livePosition.unrealizedPnlPct
        : trade.unrealizedPnlPct;
      const investedValue = Number.isFinite(livePosition?.investedValue)
        ? livePosition.investedValue
        : trade.investedValue;
      const currentValue = Number.isFinite(livePosition?.marketValue)
        ? livePosition.marketValue
        : Number.isFinite(trade.currentValue)
          ? trade.currentValue
          : Number.isFinite(displayPrice) && Number.isFinite(trade.quantity)
            ? displayPrice * trade.quantity
            : null;
      const pnlClass = Number(pnl) > 0 ? "good" : Number(pnl) < 0 ? "bad" : "neutral";
      const riskState = livePosition?.riskState || "STALE";
      const rowRiskClass = riskState === "BREACHED" ? "riskBreached" : riskState === "NEAR_STOP" ? "riskNear" : "";
      const quoteLabel = livePosition?.isLive ? "NEAR-LIVE 1M" : "EOD";
      const quoteKey = String(trade.yahooSymbol || trade.symbol || index);
      const previousPrice = state.lastPositionPrices.get(quoteKey);
      const quoteTickClass = Number.isFinite(previousPrice) && Number.isFinite(displayPrice)
        ? displayPrice > previousPrice
          ? "tickUp"
          : displayPrice < previousPrice
            ? "tickDown"
            : ""
        : "";
      if (Number.isFinite(displayPrice)) state.lastPositionPrices.set(quoteKey, displayPrice);
      const stopRiskText = livePosition
        ? `${riskState.replace("_", " ")}${Number.isFinite(livePosition.distanceToStopPct) ? ` ${compact(livePosition.distanceToStopPct)}%` : ""}`
        : "EOD RISK";
      const displayStatus = trade.pendingAdd ? "PENDING_ADD" : trade.status;
      const signalDate = trade.exitSignalDate || trade.pendingAdd?.signalDate || trade.entrySignalDate || "";
      const reason =
        trade.status === "PENDING_ENTRY" && trade.executionError
          ? [trade.executionError, ...(trade.entryReason || [])]
          : trade.status === "PENDING_EXIT"
          ? trade.exitReason || []
          : trade.status === "PENDING_PARTIAL_EXIT"
            ? trade.pendingPartialExitReason || []
            : trade.pendingAdd?.reason || trade.entryReason || [];
      return `
        <tr class="${rowRiskClass}" data-position-index="${index}" title="Open details">
          <td><span class="pill ${escapeHtml(displayStatus)}">${escapeHtml(displayStatus.replaceAll("_", " "))}</span></td>
          <td class="symbolCell"><strong>${escapeHtml(trade.symbol)}</strong><span>${escapeHtml(trade.tradeScopeLabel || trade.listLabel || "")}</span>${trade.addOns?.length ? `<span>${trade.addOns.length} winner add${trade.addOns.length === 1 ? "" : "s"}</span>` : ""}</td>
          <td>${escapeHtml(signalDate)}</td>
          <td>${escapeHtml(trade.entryDate || "Waiting")}</td>
          <td>${fmt(trade.entryPrice)}</td>
          <td>${trade.quantity ?? "NA"}</td>
          <td class="quoteCell ${quoteTickClass}"><strong>${fmt(displayPrice)}</strong><small class="quoteSource">${quoteLabel}</small></td>
          <td>${compact(investedValue)}</td>
          <td><strong>${compact(currentValue)}</strong></td>
          <td class="${pnlClass}">${compact(pnl)}${Number.isFinite(pnlPct) ? ` (${compact(pnlPct)}%)` : ""}</td>
          <td>${fmt(trade.currentRank || trade.positionRank)}</td>
          <td>${fmt(trade.trailingStopPrice || trade.initialStopPrice)}<small class="riskState ${escapeHtml(riskState)}">${escapeHtml(stopRiskText)}</small></td>
          <td>${fmt(trade.currentRewardR)}</td>
          <td class="reasonCell" title="${escapeHtml(reason.join(" "))}"><span class="signalPreview">${escapeHtml(reasonSummary(reason))}</span></td>
        </tr>
      `;
    })
    .join("");
  elements.positionsEmpty.classList.toggle("visible", trades.length === 0);
  elements.positionsBody.querySelectorAll("tr").forEach((rowElement) => {
    rowElement.addEventListener("click", () => {
      const trade = trades[Number(rowElement.dataset.positionIndex)];
      const row = findStockRow(trade?.yahooSymbol || trade?.symbol);
      if (row) renderDetail(row, trade);
    });
  });
  renderDashboardPositions(payload);
}

function aiReviewMeta(review) {
  if (!review) return "";
  if (review.ok) return ` | AI evidence review ${review.reviewed || 0}`;
  return " | AI fallback: deterministic rules";
}

function renderDashboardPositions(payload) {
  const trades = (payload?.trades || []).filter((trade) =>
    ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status)
  );
  elements.dashboardPositionsBody.innerHTML = trades
    .map((trade, index) => {
      const livePosition = findLivePosition(trade);
      const displayPrice = Number.isFinite(livePosition?.ltp) ? livePosition.ltp : trade.lastPrice;
      const pnl = Number.isFinite(livePosition?.unrealizedPnl) ? livePosition.unrealizedPnl : trade.unrealizedPnl;
      const pnlPct = Number.isFinite(livePosition?.unrealizedPnlPct) ? livePosition.unrealizedPnlPct : trade.unrealizedPnlPct;
      const investedValue = Number.isFinite(livePosition?.investedValue) ? livePosition.investedValue : trade.investedValue;
      const currentValue = Number.isFinite(livePosition?.marketValue)
        ? livePosition.marketValue
        : Number.isFinite(trade.currentValue)
          ? trade.currentValue
          : Number.isFinite(displayPrice) && Number.isFinite(trade.quantity)
            ? displayPrice * trade.quantity
            : null;
      const pnlClass = Number(pnl) > 0 ? "good" : Number(pnl) < 0 ? "bad" : "neutral";
      const riskState = livePosition?.riskState || "STALE";
      const rowRiskClass = riskState === "BREACHED" ? "riskBreached" : riskState === "NEAR_STOP" ? "riskNear" : "";
      const quoteLabel = livePosition?.isLive ? "NEAR-LIVE 1M" : "EOD";
      const stopRiskText = livePosition
        ? `${riskState.replace("_", " ")}${Number.isFinite(livePosition.distanceToStopPct) ? ` ${compact(livePosition.distanceToStopPct)}%` : ""}`
        : "EOD RISK";
      return `
        <tr class="${rowRiskClass}" data-dashboard-position-index="${index}" title="Open position details">
          <td><span class="pill ${escapeHtml(trade.status)}">${escapeHtml(trade.status.replaceAll("_", " "))}</span></td>
          <td class="symbolCell"><strong>${escapeHtml(trade.symbol)}</strong><span>${escapeHtml(trade.tradeScopeLabel || trade.listLabel || "")}</span></td>
          <td>${fmt(trade.entryPrice)}</td>
          <td>${trade.quantity ?? "NA"}</td>
          <td><strong>${fmt(displayPrice)}</strong><small class="quoteSource">${quoteLabel}</small></td>
          <td>${compact(investedValue)}</td>
          <td><strong>${compact(currentValue)}</strong></td>
          <td class="${pnlClass}">${compact(pnl)}${Number.isFinite(pnlPct) ? ` (${compact(pnlPct)}%)` : ""}</td>
          <td>${fmt(trade.trailingStopPrice || trade.initialStopPrice)}<small class="riskState ${escapeHtml(riskState)}">${escapeHtml(stopRiskText)}</small></td>
        </tr>
      `;
    })
    .join("");
  elements.dashboardPositionsEmpty.classList.toggle("visible", trades.length === 0);
  elements.dashboardPositionsBody.querySelectorAll("tr").forEach((rowElement) => {
    rowElement.addEventListener("click", () => {
      const trade = trades[Number(rowElement.dataset.dashboardPositionIndex)];
      const row = findStockRow(trade?.yahooSymbol || trade?.symbol);
      if (row) renderDetail(row, trade);
    });
  });
}

function sortPositionTrades(trades) {
  if (state.positionSort === "default") return trades;
  const direction = state.positionSortDirection === "asc" ? 1 : -1;
  return trades
    .map((trade, index) => ({ trade, index, value: positionSortValue(trade, state.positionSort) }))
    .sort((a, b) => {
      const aMissing = a.value == null || (typeof a.value === "number" && !Number.isFinite(a.value));
      const bMissing = b.value == null || (typeof b.value === "number" && !Number.isFinite(b.value));
      if (aMissing && bMissing) return a.index - b.index;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof a.value === "string") {
        const compared = a.value.localeCompare(b.value, "en", { sensitivity: "base" });
        return compared === 0 ? a.index - b.index : compared * direction;
      }
      const compared = (a.value - b.value) * direction;
      return compared === 0 ? a.index - b.index : compared;
    })
    .map((item) => item.trade);
}

function positionSortValue(trade, field) {
  const livePosition = findLivePosition(trade);
  const displayPrice = Number.isFinite(livePosition?.ltp) ? livePosition.ltp : trade.lastPrice;
  if (field === "symbol") return String(trade.symbol || "");
  if (field === "pnl") return Number.isFinite(livePosition?.unrealizedPnl) ? livePosition.unrealizedPnl : trade.unrealizedPnl;
  if (field === "pnlPct") return Number.isFinite(livePosition?.unrealizedPnlPct) ? livePosition.unrealizedPnlPct : trade.unrealizedPnlPct;
  if (field === "investedValue") return Number.isFinite(livePosition?.investedValue) ? livePosition.investedValue : trade.investedValue;
  if (field === "currentValue") {
    if (Number.isFinite(livePosition?.marketValue)) return livePosition.marketValue;
    if (Number.isFinite(trade.currentValue)) return trade.currentValue;
    return Number.isFinite(displayPrice) && Number.isFinite(trade.quantity) ? displayPrice * trade.quantity : null;
  }
  if (field === "rank") return Number(trade.currentRank ?? trade.positionRank);
  if (field === "risk") return Number.isFinite(livePosition?.distanceToStopPct) ? livePosition.distanceToStopPct : null;
  return null;
}

function updatePositionSortDirection() {
  const isDefault = state.positionSort === "default";
  elements.positionSortDirection.disabled = isDefault;
  if (isDefault) {
    elements.positionSortDirection.textContent = "Portfolio Order";
  } else if (state.positionSort === "symbol") {
    elements.positionSortDirection.textContent = state.positionSortDirection === "asc" ? "A to Z" : "Z to A";
  } else {
    elements.positionSortDirection.textContent = state.positionSortDirection === "asc" ? "Low to High" : "High to Low";
  }
}

function persistPositionSort() {
  localStorage.setItem("tfPositionSort", state.positionSort);
  localStorage.setItem("tfPositionSortDirection", state.positionSortDirection);
  const url = new URL(window.location.href);
  url.searchParams.set("sort", state.positionSort);
  url.searchParams.set("direction", state.positionSortDirection);
  window.history.replaceState({}, "", url);
}

function findLivePosition(trade) {
  const positions = state.liveMtm?.positions || [];
  const yahooSymbol = String(trade?.yahooSymbol || "");
  const symbol = String(trade?.symbol || "");
  return positions.find((position) =>
    (yahooSymbol && position.yahooSymbol === yahooSymbol) || (symbol && position.symbol === symbol)
  );
}

function startLiveMtm() {
  if (!cloudMode) return;
  const hasActivePosition = (state.payload?.trades || []).some((trade) =>
    ["OPEN", "PENDING_EXIT", "PENDING_PARTIAL_EXIT"].includes(trade.status)
  );
  if (!hasActivePosition) {
    elements.liveMtmStatus.innerHTML = "<i></i> No open positional trades";
    elements.liveStopRisk.textContent = "0 (0%)";
    if (state.liveMtmTimer) clearInterval(state.liveMtmTimer);
    state.liveMtmTimer = null;
    return;
  }
  if (!state.liveMtmTimer) {
    state.liveMtmTimer = setInterval(fetchLiveMtm, 60_000);
  }
  fetchLiveMtm();
}

async function fetchLiveMtm() {
  if (!cloudMode || document.hidden) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const url = new URL(cloudApiUrl);
    url.searchParams.set("view", "live-mtm");
    url.searchParams.set("t", Date.now());
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "Live MTM unavailable");
    state.liveMtm = payload;
    renderPositions(state.payload);
    renderLiveMtmSummary();
  } catch {
    elements.liveMtmStatus.className = "liveMtmStatus stale";
    elements.liveMtmStatus.innerHTML = "<i></i> MTM unavailable, EOD values shown";
  } finally {
    clearTimeout(timeout);
  }
}

function renderLiveMtmSummary() {
  const mtm = state.liveMtm;
  if (!mtm) return;
  const summary = mtm.summary || {};
  setLiveValue(elements.unrealizedPnl, `${compact(summary.unrealizedPnl || 0)} (${compact(summary.unrealizedPnlPct || 0)}%)`);
  setLiveValue(elements.liveStopRisk, `${compact(summary.downsideToStops || 0)} (${compact(summary.stopRiskPct || 0)}%)`);
  const warningCount = (summary.breachCount || 0) + (summary.nearStopCount || 0);
  const statusClass = summary.breachCount ? "danger" : warningCount ? "warning" : mtm.marketStatus === "OPEN" ? "live" : "closed";
  const updateText = mtm.generatedAt ? formatTime(mtm.generatedAt) : "now";
  const quoteText = summary.staleCount ? `${summary.liveCount || 0} live, ${summary.staleCount} EOD` : `${summary.liveCount || 0} quotes`;
  elements.liveMtmStatus.className = `liveMtmStatus ${statusClass}`;
  elements.liveMtmStatus.innerHTML = `<i></i> ${escapeHtml(mtm.marketStatus || "CLOSED")} | ${escapeHtml(quoteText)} | ${escapeHtml(updateText)}`;
}

function animateCount(element, target, delay = 0) {
  const value = Math.max(0, Number(target) || 0);
  const duration = 650;
  const startAt = performance.now() + delay;
  element.textContent = "0";
  function frame(now) {
    if (now < startAt) {
      requestAnimationFrame(frame);
      return;
    }
    const progress = Math.min(1, (now - startAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = Math.round(value * eased).toLocaleString("en-IN");
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setLiveValue(element, value) {
  if (element.textContent === value) return;
  element.textContent = value;
  element.classList.remove("valueUpdated");
  void element.offsetWidth;
  element.classList.add("valueUpdated");
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
  const fullReason = (row.signalReason || []).join(" ");
  return `
    <tr data-index="${index}" title="Open stock details">
      <td><span class="pill ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.listLabel || "")}</td>
      <td class="symbolCell">
        <strong>${escapeHtml(row.symbol)}</strong>
        <span>${escapeHtml(row.name || row.yahooSymbol || "")}</span>
      </td>
      <td>${fmt(row.close)}</td>
      <td class="${row.dailyPriceAboveSupertrend ? "good" : "bad"}">${fmt(row.dailySupertrend)}</td>
      <td class="${classForAbove(row.weeklyRsi, 50)}">${fmt(row.weeklyRsi)}</td>
      <td class="${classForAbove(row.weeklyRs, 0)}">${rs(row.weeklyRs)}</td>
      <td class="${classForAbove(row.dailyLongRs, 0)}">${rs(row.dailyLongRs)}</td>
      <td class="${classForAbove(row.dailyShortRs, 0)}">${rs(row.dailyShortRs)}</td>
      <td class="${classForAbove(row.dailyRsi, 50)}">${fmt(row.dailyRsi)}</td>
      <td>${row.fundamentalScore || 0}/${row.fundamental?.maxScore || 8}</td>
      <td class="${row.gtfContext?.supplyBlocked ? "bad" : row.gtfContext?.score >= 5 ? "good" : ""}">${row.gtfContext?.dataAvailable ? `${fmt(row.gtfContext.score)}/${fmt(row.gtfContext.maxScore)}` : "NA"}</td>
      <td><strong>${escapeHtml(row.setupGrade || "")} ${row.score || 0}</strong></td>
      <td class="reasonCell" title="${escapeHtml(fullReason)}"><span class="signalPreview">${escapeHtml(reasonSummary(row.signalReason))}</span></td>
    </tr>
  `;
}

function renderDetail(row, trade = null) {
  const checks = row.fundamental?.checks || {};
  const setup = row.setupStrength || {};
  const setupChecks = setup.checks || {};
  const setupValues = setup.values || {};
  const sector = row.sectorStrength || {};
  const coverage = row.conceptCoverage || {};
  const institutional = row.institutionalContext || {};
  const gtf = row.gtfContext || {};
  elements.detailPanel.innerHTML = `
    <div class="detailHeader">
      <div>
        <h2>${escapeHtml(row.symbol)} - ${escapeHtml(row.name || "")}</h2>
        <div class="neutral">${escapeHtml(row.industry || "")} | As of ${escapeHtml(row.asOf || "NA")}</div>
        <div class="neutral">${escapeHtml(row.listLabel || "")}</div>
        <div class="neutral">${escapeHtml(row.entryStyle?.label || "")}</div>
      </div>
      <div class="detailHeaderActions">
        <span class="pill ${escapeHtml(trade?.pendingAdd ? "PENDING_ADD" : trade?.status || row.status)}">${escapeHtml((trade?.pendingAdd ? "PENDING_ADD" : trade?.status || row.status).replaceAll("_", " "))}</span>
        <button class="detailClose" type="button" title="Close details" aria-label="Close details">&times;</button>
      </div>
    </div>
    <div class="decisionSnapshot" aria-label="Decision snapshot">
      ${snapshotHtml("Close", fmt(row.close))}
      ${snapshotHtml("Weekly RSI", fmt(row.weeklyRsi), classForAbove(row.weeklyRsi, 50))}
      ${snapshotHtml("Weekly RS", rs(row.weeklyRs), classForAbove(row.weeklyRs, 0))}
      ${snapshotHtml("Daily RSI", fmt(row.dailyRsi), classForAbove(row.dailyRsi, 50))}
      ${snapshotHtml("Daily RS55", rs(row.dailyLongRs), classForAbove(row.dailyLongRs, 0))}
      ${snapshotHtml("Daily RS21", rs(row.dailyShortRs), classForAbove(row.dailyShortRs, 0))}
      ${snapshotHtml("Setup", `${row.setupGrade || "NA"} ${row.score || 0}`)}
      ${snapshotHtml("GTF", gtf.dataAvailable ? `${fmt(gtf.score)}/${fmt(gtf.maxScore)}` : "NA", gtf.supplyBlocked ? "bad" : gtf.score >= 5 ? "good" : "neutral")}
    </div>
    <div class="reasonBlock">
      <strong>Signal Reason</strong>
      ${reasonListHtml(row.signalReason)}
    </div>
    ${trade ? `
      <div class="reasonBlock">
        <strong>Position Management</strong>
        <p>Average ${fmt(trade.entryPrice)} | Initial ${fmt(trade.initialEntryPrice || trade.entryPrice)} | Quantity ${trade.quantity ?? "NA"} | Winner adds ${trade.addOns?.length || 0}/2 | Trailing stop ${fmt(trade.trailingStopPrice || trade.initialStopPrice)}</p>
        ${trade.pendingAdd ? reasonListHtml(trade.pendingAdd.reason) : reasonListHtml(trade.lastPyramidDecision?.reasons)}
      </div>
    ` : ""}
    <div class="checkGrid">
      ${checkHtml("Net income YoY", checks.netIncomeYoYUp)}
      ${checkHtml("Quarterly sales YoY", checks.revenueQuarterYoYUp)}
      ${checkHtml("Quarterly EPS YoY", checks.epsQuarterYoYUp)}
      ${checkHtml("Quarterly EBITDA YoY", checks.ebitdaQuarterYoYUp)}
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
      ${setupCheckHtml("20D base breakout", setupChecks.baseBreakout, setupValues.priorBaseHigh)}
      ${setupCheckHtml("Higher-low structure", setupChecks.higherLowStructure, setupValues.recentBaseLow)}
      ${setupCheckHtml("55D breakout", setupChecks.recentHighBreakout, setupValues.priorRecentHigh)}
      ${setupCheckHtml("52W high zone", setupChecks.nearYearHigh, setupValues.priorYearHigh)}
      ${setupCheckHtml("Volume shocker", setupChecks.volumeExpansion, setupValues.volumeRatio, "x")}
      ${setupCheckHtml("MACD > signal + zero", setupChecks.macdBullish, setupValues.macd)}
      ${setupCheckHtml("OBV rising", setupChecks.obvRising)}
      ${setupCheckHtml("Retracement buy", setupChecks.retracementBuyZone, setupValues.retracementPullbackDepthPct, "%")}
      ${setupCheckHtml("Pullback support", setupValues.retracementSupportProximityOk, setupValues.retracementSupportDistancePct, "%")}
      ${setupCheckHtml("Pullback volume", setupValues.retracementVolumePatternOk, setupValues.retracementPullbackVolumeRatio, "x")}
      ${setupCheckHtml("Reclaim candle", setupValues.retracementReclaimCandleOk, setupValues.retracementCloseLocationPct, "%")}
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
    <div class="reasonBlock">
      <strong>GTF Additional Confluence</strong>
      <p>${escapeHtml(gtf.dataAvailable ? `${gtf.score}/${gtf.maxScore} - ${gtf.grade}. ${(gtf.reasons || []).join(" ")}` : "No qualified daily/weekly GTF zone context is available for this row.")}</p>
    </div>
    <div class="checkGrid">
      ${contextCheckHtml("Daily demand", gtf.checks?.dailyDemandQualified, formatGtfZone(gtf.dailyDemand))}
      ${contextCheckHtml("Weekly demand", gtf.checks?.weeklyDemandQualified, formatGtfZone(gtf.weeklyDemand))}
      ${contextCheckHtml("Reacting from HTF", gtf.reactingFromHtf?.active, gtf.reactingFromHtf?.active ? `${formatGtfZone(gtf.reactingFromHtf.zone)} | Secondary GTF proxy | ${gtf.reactingFromHtf.managementClass}` : gtf.reactingFromHtf?.reason || "No reaction")}
      ${contextCheckHtml("Demand retest", gtf.demandRetest, gtf.preferredEntryStyle)}
      ${contextCheckHtml("2R runway", gtf.checks?.roomForTwoR, gtf.unlimitedRewardRoom ? "No active supply blocker" : Number.isFinite(gtf.rewardRisk) ? `${compact(gtf.rewardRisk)}R room` : "Not available")}
      ${contextCheckHtml("Opposing supply clear", !gtf.supplyBlocked, formatGtfZone(gtf.opposingSupply))}
      ${contextCheckHtml("Daily 50-SMA slope", gtf.dailyTrend === "up", gtf.dailyTrend || "unknown")}
    </div>
    <div class="reasonBlock">
      <strong>Institutional Multi-Market Context</strong>
      <p>${escapeHtml(institutional.maxScore ? `${institutional.score}/${institutional.maxScore} - ${institutional.grade}` : "No institutional context available for this row yet.")}</p>
    </div>
    <div class="checkGrid">
      ${contextCheckHtml("Index", institutional.index?.supportsLongs, institutional.index?.reason)}
      ${contextCheckHtml("Derivatives/F&O", institutional.derivatives?.fnoEligible, institutional.derivatives?.reason)}
      ${contextCheckHtml("Options", institutional.options?.supportsLongs, institutional.options?.reason)}
      ${contextCheckHtml("Commodity/Currency", institutional.commodity?.supportsSector, institutional.commodity?.reason)}
      ${contextCheckHtml("NSE Delivery/Operator", institutional.operator?.accumulation, institutional.operator?.reason)}
    </div>
    <div class="reasonBlock">
      <strong>Institutional Concept Coverage</strong>
      <p>${escapeHtml(coverage.summary || "No concept coverage available for this row yet.")}</p>
    </div>
    <div class="checkGrid">
      ${conceptBucketHtml("Strong", coverage.passLabels, "good")}
      ${conceptBucketHtml("Weak", coverage.weakLabels, "bad")}
      ${conceptBucketHtml("Data gaps", coverage.dataGapLabels)}
      ${conceptBucketHtml("Excluded", coverage.excludedLabels)}
    </div>
  `;
  elements.detailPanel.classList.add("visible");
  elements.detailBackdrop.classList.add("visible");
  document.body.classList.add("detailOpen");
  elements.detailPanel.scrollTop = 0;
  elements.detailPanel.querySelector(".detailClose")?.addEventListener("click", closeDetail);
}

function closeDetail() {
  elements.detailPanel.classList.remove("visible");
  elements.detailBackdrop.classList.remove("visible");
  document.body.classList.remove("detailOpen");
}

function setStatusFilter(filter) {
  state.filter = filter || "ALL";
  state.displayLimit = 250;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.filter === state.filter);
  });
  document.querySelectorAll(".metric[data-summary-filter]").forEach((metric) => {
    metric.classList.toggle("active", metric.dataset.summaryFilter === state.filter);
  });
  renderRows();
}

function findStockRow(symbol) {
  const key = String(symbol || "").replace(/\.(NS|BO)$/i, "");
  for (const list of Object.values(state.payload?.lists || {})) {
    const match = (list.results || []).find((row) =>
      [row.symbol, row.yahooSymbol].some((value) =>
        String(value || "").replace(/\.(NS|BO)$/i, "") === key
      )
    );
    if (match) return match;
  }
  return null;
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

function renderCandidates(payload) {
  const candidates = payload?.waitingCandidates || [];
  elements.candidatesBody.innerHTML = candidates
    .map((candidate) => `
      <tr>
        <td><span class="pill WATCH">${escapeHtml(candidate.status || "WAITING")}</span></td>
        <td class="symbolCell"><strong>${escapeHtml(candidate.symbol)}</strong><span>${escapeHtml(candidate.industry || "")}</span></td>
        <td>${escapeHtml(candidate.firstSignalDate || "")}</td>
        <td>${escapeHtml(candidate.grade || "NA")}</td>
        <td>${fmt(candidate.rank)}</td>
        <td>${compact(candidate.plannedAllocation)}</td>
        <td>${compact(candidate.plannedRisk)}</td>
        <td class="reasonCell" title="${escapeHtml(candidate.skipReason || "Waiting for portfolio allocation")}"><span class="signalPreview">${escapeHtml(reasonSummary([candidate.skipReason || "Waiting for portfolio allocation"]))}</span></td>
      </tr>
    `)
    .join("");
  elements.candidatesEmpty.classList.toggle("visible", candidates.length === 0);
}

async function refreshPublishedData() {
  elements.refreshButton.disabled = true;
  const previousLabel = elements.refreshButton.textContent;
  elements.refreshButton.textContent = "Checking...";
  try {
    await loadResults();
  } catch (error) {
    elements.scanMeta.textContent = `Update check failed: ${error.message}`;
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = previousLabel || "Check Updates";
  }
}

function renderCandidateDecisions(payload) {
  const decisions = (payload?.candidateDecisionLog || []).slice(0, 50);
  elements.candidateDecisionsBody.innerHTML = decisions
    .map((decision) => {
      const metrics = decision.metrics || {};
      return `
        <tr>
          <td><span class="pill WATCH">${escapeHtml(decision.disposition || decision.outcome || "REVIEW")}</span></td>
          <td class="symbolCell"><strong>${escapeHtml(decision.symbol || "")}</strong><span>${escapeHtml(decision.grade || "")}</span></td>
          <td>${escapeHtml(decision.asOf || "")}</td>
          <td>${Number.isFinite(metrics.runupPct) ? `${fmt(metrics.runupPct)}%` : "NA"}</td>
          <td>${Number.isFinite(metrics.executionGapPct) ? `${fmt(metrics.executionGapPct)}%` : "NA"}</td>
          <td>${Number.isFinite(metrics.supertrendDistancePct) ? `${fmt(metrics.supertrendDistancePct)}%` : "NA"}</td>
          <td>${Number.isFinite(metrics.rankDecay) ? fmt(metrics.rankDecay) : "NA"}</td>
          <td class="reasonCell" title="${escapeHtml(decision.reason || "")}"><span class="signalPreview">${escapeHtml(reasonSummary([decision.reason || "No reason recorded"]))}</span></td>
        </tr>
      `;
    })
    .join("");
  elements.candidateDecisionsEmpty.classList.toggle("visible", decisions.length === 0);
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
        qualityMode: elements.tradeQualitySelect.value,
        totalCapital: Number(elements.totalCapitalInput.value),
        addCapital: Number(elements.addCapitalInput.value || 0),
        maxOpenPositions: Number(elements.maxOpenPositionsInput.value),
        riskPerTradePct: Number(elements.riskPerTradeInput.value),
        maxPortfolioRiskPct: Number(elements.maxPortfolioRiskInput.value),
        maxPositionPct: Number(elements.maxPositionInput.value),
        maxSectorExposurePct: Number(elements.maxSectorExposureInput.value),
        pyramidingEnabled: elements.pyramidingEnabledInput.checked
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error || "Trade settings save failed");
    localStorage.setItem("tfAccessCode", accessCode);
    syncAccessCodeInputs(accessCode);
    state.cloudTradeSettings = payload.tradeSettings || state.cloudTradeSettings;
    elements.addCapitalInput.value = "";
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
  if (elements.totalCapitalInput && Number.isFinite(Number(settings.totalCapital))) {
    elements.totalCapitalInput.value = String(settings.totalCapital);
  }
  const numericControls = [
    [elements.maxOpenPositionsInput, settings.maxOpenPositions],
    [elements.riskPerTradeInput, settings.riskPerTradePct],
    [elements.maxPortfolioRiskInput, settings.maxPortfolioRiskPct],
    [elements.maxPositionInput, settings.maxPositionPct],
    [elements.maxSectorExposureInput, settings.maxSectorExposurePct]
  ];
  numericControls.forEach(([control, value]) => {
    if (control && Number.isFinite(Number(value))) control.value = String(value);
  });
  if (elements.pyramidingEnabledInput) {
    elements.pyramidingEnabledInput.checked = settings.pyramidingEnabled !== false;
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
      `${settings.scopeLabel || "All NSE Market"} | ${settings.qualityLabel || "Best only"} | Capital Rs ${compact(settings.totalCapital || 1000000)} | Risk ${compact(settings.riskPerTradePct || 1)}%/trade${updated}`;
  }
}

function updateDownloadLinks(payload) {
  if (!staticMode) return;
  const version = encodeURIComponent(payload?.scannedAt || Date.now());
  const excelHref = `data/techno-funda-trade-sheet.xlsx?v=${version}`;
  const csvHref = `data/techno-funda-trade-sheet.csv?v=${version}`;
  elements.excelDownloadLink.href = excelHref;
  elements.csvDownloadLink.href = csvHref;
  elements.topExcelDownloadLink.href = excelHref;
  elements.topCsvDownloadLink.href = csvHref;
  elements.dashboardExcelDownloadLink.href = excelHref;
  elements.dashboardCsvDownloadLink.href = csvHref;
}

function reasonListHtml(reasons = []) {
  const values = (Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean);
  if (!values.length) return '<p class="neutral">No signal reason available.</p>';
  return `<ul class="reasonList">${values.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`;
}

function snapshotHtml(label, value, tone = "") {
  const safeTone = ["good", "bad", "neutral"].includes(tone) ? tone : "";
  return `<div><span>${escapeHtml(label)}</span><strong class="${safeTone}">${escapeHtml(value)}</strong></div>`;
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

function conceptBucketHtml(label, items = [], css = "neutral") {
  const list = Array.isArray(items) ? items : [];
  return `
    <div class="check">
      <span>${escapeHtml(label)}</span>
      <strong class="${css}">${list.length}</strong>
      <span>${escapeHtml(list.length ? list.join(", ") : "None")}</span>
    </div>
  `;
}

function contextCheckHtml(label, ok, reason) {
  const css = ok === true ? "good" : ok === false ? "bad" : "neutral";
  const status = ok === true ? "Support" : ok === false ? "Risk/Gap" : "NA";
  return `
    <div class="check">
      <span>${escapeHtml(label)}</span>
      <strong class="${css}">${status}</strong>
      <span>${escapeHtml(reason || "No context")}</span>
    </div>
  `;
}

function formatGtfZone(zone) {
  if (!zone) return "No active qualified zone";
  const freshness = zone.freshnessTests === 0 ? "fresh" : `tested ${zone.freshnessTests}x`;
  return `${zone.timeframe || ""} ${zone.pattern || ""} ${fmt(zone.distal)}-${fmt(zone.proximal)}; ${freshness}; score ${fmt(zone.score)}/7; achievement ${fmt(zone.achievementR)}R`;
}

function exportCsv() {
  const headers = [
    "status",
    "list",
    "symbol",
    "name",
    "entryStyle",
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
    "retracementBuy",
    "retracementPullbackDepthPct",
    "retracementSupport",
    "retracementSupportDistancePct",
    "retracementPullbackVolumeRatio",
    "retracementReclaimVolumeRatio",
    "institutionalScore",
    "gtfScore",
    "gtfDailyDemand",
    "gtfWeeklyDemand",
    "gtfReactingFromHtf",
    "gtfOpposingSupply",
    "gtfRewardRisk",
    "indexContext",
    "derivativesContext",
    "optionsContext",
    "commodityContext",
    "conceptScore",
    "strongConcepts",
    "weakConcepts",
    "dataGaps",
    "excludedPlaybooks",
    "score",
    "reason"
  ];
  const lines = [headers.join(",")];
  filteredRows().forEach((row) => {
    const exportRow = {
      ...row,
      list: row.listLabel,
      entryStyle: row.entryStyle?.label || "",
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
      retracementBuy: row.setupStrength?.checks?.retracementBuyZone ? "Yes" : "No",
      retracementPullbackDepthPct: Number.isFinite(row.setupStrength?.values?.retracementPullbackDepthPct)
        ? compact(row.setupStrength.values.retracementPullbackDepthPct)
        : "",
      retracementSupport: row.setupStrength?.values?.retracementSupportSource || "",
      retracementSupportDistancePct: Number.isFinite(row.setupStrength?.values?.retracementSupportDistancePct)
        ? compact(row.setupStrength.values.retracementSupportDistancePct)
        : "",
      retracementPullbackVolumeRatio: Number.isFinite(row.setupStrength?.values?.retracementPullbackVolumeRatio)
        ? compact(row.setupStrength.values.retracementPullbackVolumeRatio)
        : "",
      retracementReclaimVolumeRatio: Number.isFinite(row.setupStrength?.values?.retracementCurrentVolumeRatio)
        ? compact(row.setupStrength.values.retracementCurrentVolumeRatio)
        : "",
      institutionalScore: row.institutionalContext?.maxScore
        ? `${row.institutionalContext.score}/${row.institutionalContext.maxScore}`
        : "",
      gtfScore: row.gtfContext?.dataAvailable
        ? `${row.gtfContext.score}/${row.gtfContext.maxScore}`
        : "",
      gtfDailyDemand: formatGtfZone(row.gtfContext?.dailyDemand),
      gtfWeeklyDemand: formatGtfZone(row.gtfContext?.weeklyDemand),
      gtfReactingFromHtf: row.gtfContext?.reactingFromHtf?.active
        ? `${formatGtfZone(row.gtfContext.reactingFromHtf.zone)} | ${row.gtfContext.reactingFromHtf.managementClass} | ${row.gtfContext.reactingFromHtf.sourceStatus}`
        : "No",
      gtfOpposingSupply: formatGtfZone(row.gtfContext?.opposingSupply),
      gtfRewardRisk: row.gtfContext?.unlimitedRewardRoom
        ? "Clear"
        : Number.isFinite(row.gtfContext?.rewardRisk) ? `${compact(row.gtfContext.rewardRisk)}R` : "",
      indexContext: row.institutionalContext?.index?.reason || "",
      derivativesContext: row.institutionalContext?.derivatives?.reason || "",
      optionsContext: row.institutionalContext?.options?.reason || "",
      commodityContext: row.institutionalContext?.commodity?.reason || "",
      conceptScore: row.conceptCoverage?.applicable
        ? `${row.conceptCoverage.passed}/${row.conceptCoverage.applicable}`
        : "",
      strongConcepts: (row.conceptCoverage?.passLabels || []).join("; "),
      weakConcepts: (row.conceptCoverage?.weakLabels || []).join("; "),
      dataGaps: (row.conceptCoverage?.dataGapLabels || []).join("; "),
      excludedPlaybooks: (row.conceptCoverage?.excludedLabels || []).join("; "),
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
  elements.scanButton.hidden = true;
  elements.refreshButton.textContent = "Check Updates";
  elements.refreshButton.title = "Reloads the latest automatically published scan and near-live position values; it does not start a new scan";
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

function rs(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "NA";
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

function formatTime(value) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
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
  if (window.TF_AUTH_MODE && window.TF_ACCESS_TOKEN) return "authenticated-session";
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

function reasonSummary(reasons = []) {
  const values = (Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean);
  const priority = values.find((reason) =>
    /data gap|history building|unavailable|GTF|retracement|breakout|exit|weakness|deterioration|risk|portfolio|waiting|capital|scope/i.test(reason)
  );
  return priority || values[0] || "Open details";
}
