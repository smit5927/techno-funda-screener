import fs from "node:fs";
import path from "node:path";
import { appConfig, resolveProjectPath } from "./config.js";

const outDir = resolveProjectPath(process.env.STATIC_OUT_DIR || "site");
const publicDir = path.join(appConfig.rootDir, "public");

if (!outDir.startsWith(appConfig.rootDir)) {
  throw new Error(`Refusing to write outside project: ${outDir}`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const filename of [
  "index.html",
  "app.js",
  "auth.js",
  "auth-request.js",
  "detail-evidence.js",
  "decision-guide.js",
  "styles.css",
  "mobile-config.js",
  "manifest.webmanifest",
  "app-icon-192.png",
  "app-icon-512.png",
  "app-icon-maskable-512.png",
  "service-worker.js"
]) {
  copyFile(filename);
}
copyDirectory("vendor");
copySupabaseVendor();
fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");

console.log(`Secure PWA built at ${path.relative(appConfig.rootDir, outDir)}`);

function copyFile(filename) {
  fs.copyFileSync(path.join(publicDir, filename), path.join(outDir, filename));
}

function copyDirectory(dirname) {
  const source = path.join(publicDir, dirname);
  const target = path.join(outDir, dirname);
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
}

function copySupabaseVendor() {
  const source = path.join(
    appConfig.rootDir,
    "node_modules",
    "@supabase",
    "supabase-js",
    "dist",
    "umd",
    "supabase.js"
  );
  const target = path.join(outDir, "vendor", "supabase.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
