import fs from "node:fs";
import path from "node:path";
import { appConfig, resolveProjectPath } from "./config.js";

const outDir = resolveProjectPath(process.env.STATIC_OUT_DIR || "site");
const publicDir = path.join(appConfig.rootDir, "public");
const outDataDir = path.join(outDir, "data");

if (!outDir.startsWith(appConfig.rootDir)) {
  throw new Error(`Refusing to write outside project: ${outDir}`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDataDir, { recursive: true });

copyFile("index.html");
copyFile("app.js");
copyFile("styles.css");
copyFile("cloud-config.js");
copyDirectory("vendor");
writeNoJekyll();
copyDataFile("results.json", appConfig.latestResultPath);
copyDataFile("trades.json", appConfig.tradesPath);
copyDataFile("techno-funda-trade-sheet.xlsx", appConfig.tradeSheetPath);
copyDataFile("techno-funda-trade-sheet.csv", appConfig.tradeCsvPath);

console.log(`Static site built at ${path.relative(appConfig.rootDir, outDir)}`);

function copyFile(filename) {
  const source = path.join(publicDir, filename);
  const target = path.join(outDir, filename);
  let contents = fs.readFileSync(source, filename.endsWith(".html") || filename.endsWith(".js") || filename.endsWith(".css") ? "utf8" : undefined);
  if (filename === "index.html") {
    contents = contents.replace(
      '<script src="app.js" type="module"></script>',
      '<script src="vendor/exceljs.min.js"></script>\n    <script src="cloud-config.js"></script>\n    <script>window.TF_STATIC_MODE = true;</script>\n    <script src="app.js" type="module"></script>'
    );
  }
  fs.writeFileSync(target, contents);
}

function writeNoJekyll() {
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");
}

function copyDirectory(dirname) {
  const source = path.join(publicDir, dirname);
  const target = path.join(outDir, dirname);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, { recursive: true });
}

function copyDataFile(filename, source) {
  const target = path.join(outDataDir, filename);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
    return;
  }
  if (filename.endsWith(".json")) fs.writeFileSync(target, "{}\n", "utf8");
  else fs.writeFileSync(target, "");
}
