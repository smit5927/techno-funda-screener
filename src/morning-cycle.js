const IST_OFFSET_MINUTES = 330;
const MORNING_START_MINUTE = 8 * 60 + 20;
const MORNING_END_MINUTE = 9 * 60 + 5;
const EXECUTION_MINUTE = 9 * 60 + 17;

export function istClock(value = new Date()) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return null;
  const shifted = new Date(time + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    day: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    time: shifted.toISOString().slice(11, 16)
  };
}

export function isMorningApprovalWindow(value = new Date()) {
  const clock = istClock(value);
  return Boolean(
    clock &&
    clock.day >= 1 &&
    clock.day <= 5 &&
    clock.minute >= MORNING_START_MINUTE &&
    clock.minute <= MORNING_END_MINUTE
  );
}

export function morningApprovalStatus(requested, value = new Date()) {
  const clock = istClock(value);
  if (!requested) return { requested: false, allowed: false, clock, reason: "not-requested" };
  if (!clock) return { requested: true, allowed: false, clock: null, reason: "invalid-time" };
  if (clock.day === 0 || clock.day === 6) {
    return { requested: true, allowed: false, clock, reason: "non-trading-weekday" };
  }
  if (!isMorningApprovalWindow(value)) {
    return { requested: true, allowed: false, clock, reason: "outside-08:20-to-09:05-IST" };
  }
  return { requested: true, allowed: true, clock, reason: "morning-window" };
}

export function canReachExecutionDate(value, executionAfterDate) {
  const clock = istClock(value);
  const targetDate = String(executionAfterDate || "").slice(0, 10);
  if (!clock || !targetDate) return true;
  if (clock.date > targetDate) return true;
  if (clock.date < targetDate) return false;
  return clock.minute < EXECUTION_MINUTE;
}
