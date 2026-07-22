const [target = "", maxWaitMinutesText = "15"] = process.argv.slice(2);
const match = /^(\d{2}):(\d{2})$/.exec(target);

if (!match) {
  throw new Error("Usage: node src/wait-until-ist.js HH:MM [max-wait-minutes]");
}

const targetHour = Number(match[1]);
const targetMinute = Number(match[2]);
const maxWaitMs = Math.max(0, Number(maxWaitMinutesText) || 0) * 60_000;
const now = new Date();
const istNow = new Date(now.getTime() + 330 * 60_000);
const targetUtcMs = Date.UTC(
  istNow.getUTCFullYear(),
  istNow.getUTCMonth(),
  istNow.getUTCDate(),
  targetHour,
  targetMinute
) - 330 * 60_000;
const delayMs = targetUtcMs - now.getTime();

if (delayMs > maxWaitMs) {
  throw new Error(`Target ${target} IST is more than ${maxWaitMinutesText} minutes away.`);
}

if (delayMs > 0) {
  console.log(`Waiting ${Math.ceil(delayMs / 1000)} seconds for ${target} IST.`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
} else {
  console.log(`${target} IST has already arrived; continuing immediately.`);
}

