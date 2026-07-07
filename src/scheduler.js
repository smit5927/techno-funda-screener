import cron from "node-cron";

export function startScheduler(config, task) {
  if (!config.schedule.enabled) return null;

  if (!cron.validate(config.schedule.cron)) {
    throw new Error(`Invalid SCAN_CRON expression: ${config.schedule.cron}`);
  }

  return cron.schedule(
    config.schedule.cron,
    async () => {
      try {
        await task();
      } catch (error) {
        console.error("[scheduler] scan failed:", error);
      }
    },
    {
      timezone: config.schedule.timezone
    }
  );
}
