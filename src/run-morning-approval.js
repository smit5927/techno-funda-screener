import { syncMultiUserRuntime } from "./multi-user-runtime.js";
import { morningApprovalStatus } from "./morning-cycle.js";

const cycleAt = new Date().toISOString();
const morningCycle = morningApprovalStatus(true, cycleAt);

if (!morningCycle.allowed) {
  console.log(
    `Morning approval skipped at ${morningCycle.clock?.time || "unknown"} IST (${morningCycle.reason}).`
  );
} else {
  const result = await syncMultiUserRuntime(null, {
    approvalOnly: true,
    cycleAt,
    publishActionAlerts: true,
    sendTelegram: true
  });
  if (!result.ok) {
    throw new Error(`Morning approval failed for ${result.failed || 0} portfolios.`);
  }
  console.log(`Morning approval completed for ${result.processed} portfolios at ${morningCycle.clock.time} IST.`);
}
