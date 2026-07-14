const DEFAULT_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

export async function applyAiDecisionReview(lists = {}, options = {}) {
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN || "";
  const enabled = options.enabled ?? String(process.env.AI_REVIEW_ENABLED || "true").toLowerCase() !== "false";
  const candidates = topCandidates(lists, options.limit || 15);
  if (!enabled || !token || candidates.length === 0) {
    return { ok: false, reason: !enabled ? "disabled" : !token ? "token unavailable" : "no entry candidates", reviewed: 0 };
  }

  try {
    const response = await fetch(options.endpoint || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10"
      },
      body: JSON.stringify({
        model: options.model || process.env.AI_REVIEW_MODEL || DEFAULT_MODEL,
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a conservative evidence reviewer for an Indian positional equity screener.",
              "The deterministic entry and exit rules are authoritative and cannot be changed.",
              "Review only the supplied structured data. Never invent facts, news, filings or prices.",
              "Return JSON with key reviews, an array of {symbol, adjustment, confidence, summary, flags}.",
              "adjustment must be an integer from -2 to 2. Missing data is neutral, not bearish.",
              "Penalize contradictions, weak/deteriorating fundamentals, excessive extension or concentration risk.",
              "Reward broad agreement between technical strength, improving fundamentals and institutional context.",
              "summary must be at most 24 words and flags at most 3 short strings."
            ].join(" ")
          },
          { role: "user", content: JSON.stringify({ candidates: candidates.map(aiInput) }) }
        ]
      })
    });
    if (!response.ok) throw new Error(`GitHub Models returned ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const reviews = validateReviews(parsed?.reviews, new Set(candidates.map((row) => row.symbol)));
    applyReviews(lists, reviews);
    return { ok: true, reviewed: reviews.size, model: options.model || DEFAULT_MODEL };
  } catch (error) {
    console.warn(`AI decision review skipped: ${error.message || String(error)}`);
    return { ok: false, reason: error.message || String(error), reviewed: 0 };
  }
}

export function validateReviews(input, allowedSymbols) {
  const reviews = new Map();
  for (const item of Array.isArray(input) ? input : []) {
    const symbol = String(item?.symbol || "").trim().toUpperCase();
    if (!allowedSymbols.has(symbol) || reviews.has(symbol)) continue;
    const adjustment = Math.max(-2, Math.min(2, Math.round(Number(item.adjustment) || 0)));
    const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
    const summary = String(item.summary || "AI review completed without an additional evidence note.").trim().slice(0, 220);
    const flags = (Array.isArray(item.flags) ? item.flags : []).map((flag) => String(flag).trim().slice(0, 80)).filter(Boolean).slice(0, 3);
    reviews.set(symbol, { available: true, adjustment, confidence, summary, flags, role: "BOUNDED_SECOND_OPINION" });
  }
  return reviews;
}

function topCandidates(lists, limit) {
  const rows = Object.values(lists)
    .flatMap((list) => Array.isArray(list?.results) ? list.results : [])
    .filter((row) => row.status === "ENTRY");
  const bySymbol = new Map();
  for (const row of rows) {
    const key = String(row.symbol || row.yahooSymbol || "").toUpperCase();
    const current = bySymbol.get(key);
    if (!current || deterministicRank(row) > deterministicRank(current)) bySymbol.set(key, row);
  }
  return [...bySymbol.values()].sort((a, b) => deterministicRank(b) - deterministicRank(a)).slice(0, limit);
}

function deterministicRank(row) {
  return (Number(row.score) || 0) + (Number(row.weeklyRs) || 0) * 10 + (Number(row.dailyLongRs) || 0) * 6;
}

function aiInput(row) {
  const fundamentalChecks = Object.fromEntries(
    Object.entries(row.fundamental?.checks || {}).map(([key, value]) => [key, {
      ok: value?.ok ?? null,
      latest: compact(value?.latest),
      previous: compact(value?.previous)
    }])
  );
  return {
    symbol: row.symbol,
    setupGrade: row.setupGrade,
    entryStyle: row.entryStyle?.type,
    weeklyRsi: compact(row.weeklyRsi),
    dailyRsi: compact(row.dailyRsi),
    weeklyRs: compact(row.weeklyRs),
    dailyLongRs: compact(row.dailyLongRs),
    dailyShortRs: compact(row.dailyShortRs),
    distanceToSupertrendPct: compact(row.setupStrength?.values?.riskToSupertrendPct),
    atrPct: compact(row.setupStrength?.values?.atrPct),
    fundamentalScore: row.fundamentalScore,
    currentPe: compact(row.fundamental?.currentPe),
    ebitdaMargin: compact(row.fundamental?.ebitdaMargin),
    fundamentalChecks,
    institutionalScore: row.institutionalScore,
    gtfRankAdjustment: row.gtfContext?.rankAdjustment || 0,
    marketRiskMode: row.institutionalContext?.marketRiskMode || null
  };
}

function applyReviews(lists, reviews) {
  for (const list of Object.values(lists)) {
    for (const row of list?.results || []) {
      const review = reviews.get(String(row.symbol || "").toUpperCase());
      if (!review) continue;
      row.aiReview = review;
      row.aiScore = review.adjustment;
      row.signalReason = [
        ...(row.signalReason || []),
        `AI evidence review (${review.adjustment >= 0 ? "+" : ""}${review.adjustment}): ${review.summary}`,
        ...review.flags.map((flag) => `AI risk flag: ${flag}.`)
      ];
    }
  }
}

function compact(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : null;
}
