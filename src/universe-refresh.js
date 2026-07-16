import fs from "node:fs";
import path from "node:path";
import { parseCsv, stringifyCsv } from "./csv.js";

export function validateUniverseSnapshot(rows, options = {}) {
  const label = String(options.label || "Universe");
  const minRows = Number(options.minRows) || 1;
  const maxRows = Number(options.maxRows) || Number.MAX_SAFE_INTEGER;
  const symbols = rows.map((row) => String(row.symbol || "").trim().toUpperCase()).filter(Boolean);
  const unique = new Set(symbols);
  if (rows.length < minRows || rows.length > maxRows) {
    throw new Error(`${label} snapshot has ${rows.length} rows; expected ${minRows}-${maxRows}. Last good file was kept.`);
  }
  if (symbols.length !== rows.length || unique.size !== symbols.length) {
    throw new Error(`${label} snapshot contains blank or duplicate symbols. Last good file was kept.`);
  }

  const previousRows = Array.isArray(options.previousRows) ? options.previousRows : [];
  if (previousRows.length > 0) {
    const maxDropPct = Number(options.maxDropPct ?? 20);
    const dropPct = Math.max(0, (previousRows.length - rows.length) / previousRows.length * 100);
    if (dropPct > maxDropPct) {
      throw new Error(`${label} snapshot dropped ${dropPct.toFixed(1)}%; safety limit is ${maxDropPct}%. Last good file was kept.`);
    }
  }
  return rows;
}

export function universeChanges(previousRows = [], nextRows = []) {
  const previous = new Set(previousRows.map((row) => normalizeSymbol(row.symbol)).filter(Boolean));
  const next = new Set(nextRows.map((row) => normalizeSymbol(row.symbol)).filter(Boolean));
  return {
    added: [...next].filter((symbol) => !previous.has(symbol)).sort(),
    removed: [...previous].filter((symbol) => !next.has(symbol)).sort()
  };
}

export function readExistingUniverse(filePath) {
  return fs.existsSync(filePath) ? parseCsv(fs.readFileSync(filePath, "utf8")) : [];
}

export function writeUniverseAtomically(filePath, rows, columns) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, stringifyCsv(rows, columns), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

export function formatUniverseChanges(changes, limit = 12) {
  const added = changes.added.slice(0, limit).join(", ") || "none";
  const removed = changes.removed.slice(0, limit).join(", ") || "none";
  const addedSuffix = changes.added.length > limit ? ` +${changes.added.length - limit} more` : "";
  const removedSuffix = changes.removed.length > limit ? ` +${changes.removed.length - limit} more` : "";
  return `Added ${changes.added.length}: ${added}${addedSuffix} | Removed ${changes.removed.length}: ${removed}${removedSuffix}`;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}
