import { runScreener } from "./screener.js";

const args = new Set(process.argv.slice(2));
const sendTelegram = args.has("--telegram") || !args.has("--no-telegram");

try {
  const result = await runScreener({ sendTelegram });
  console.log(
    [
      `Scan complete at ${result.scannedAt}`,
      `Entry: ${result.summary.entry}`,
      `Exit: ${result.summary.exit}`,
      `Watch: ${result.summary.watch}`,
      `Error: ${result.summary.error}`,
      `Telegram: ${result.telegram.sent ? "sent" : result.telegram.reason}`
    ].join("\n")
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
