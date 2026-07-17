const IST_OFFSET_MINUTES = 5 * 60 + 30;
const EXECUTION_MINUTES = 9 * 60 + 17;

export function executionAfterDate(signalDate, orderCreatedAt) {
  const signal = isoDate(signalDate);
  const created = istDateTime(orderCreatedAt);
  if (!signal || !created) return signal || null;
  if (created.minutes < EXECUTION_MINUTES) return signal;
  return created.date > signal ? created.date : signal;
}

export function isRetroactiveExecution(orderCreatedAt, executionDate, executionTime = "09:17 IST") {
  const created = istDateTime(orderCreatedAt);
  const filled = isoDate(executionDate);
  if (!created || !filled || !String(executionTime).includes("09:17")) return false;
  return created.date === filled && created.minutes >= EXECUTION_MINUTES;
}

function istDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

function isoDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || null;
}
