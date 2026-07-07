import { readLatestScan, saveLatestScan } from "./storage.js";
import { pushCloudState } from "./cloud-sync.js";

const latest = readLatestScan();
if (!latest) {
  console.log("No results.json found.");
  process.exit(0);
}

for (const list of Object.values(latest.lists || {})) {
  delete list.path;
}

saveLatestScan(latest);

try {
  const pushed = await pushCloudState(latest);
  console.log(pushed.ok ? "Cloud results cleaned" : `Cloud clean skipped: ${pushed.reason}`);
} catch (error) {
  console.log(`Cloud clean skipped: ${error.message || String(error)}`);
}

console.log("Local results cleaned.");
