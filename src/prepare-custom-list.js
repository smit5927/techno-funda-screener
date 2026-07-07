import fs from "node:fs";
import path from "node:path";
import { appConfig, resolveProjectPath } from "./config.js";
import { importSymbolsFromUpload } from "./import-symbols.js";
import { saveCustomWatchlist } from "./watchlist.js";

const candidates = [
  "config/custom-symbols.xlsx",
  "config/custom-symbols.csv",
  "config/custom-symbols.txt"
].map(resolveProjectPath);

const sourcePath = candidates.find((filePath) => fs.existsSync(filePath));
const customList = appConfig.lists.find((list) => list.id === "custom");

if (!customList) {
  throw new Error("Custom list is not configured.");
}

if (!sourcePath) {
  console.log("No config/custom-symbols.xlsx/csv/txt found. Existing custom-list.csv will be used.");
} else {
  const buffer = fs.readFileSync(sourcePath);
  const symbols = await importSymbolsFromUpload(path.basename(sourcePath), buffer);
  const count = saveCustomWatchlist(customList.path, symbols.join("\n"));
  console.log(`Imported ${count} symbols from ${path.relative(appConfig.rootDir, sourcePath)}.`);
}
