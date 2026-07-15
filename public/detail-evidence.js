export function buildDetailEvidenceRow(currentRow = {}, trade = null, candidate = null) {
  const sources = [
    trade?.entrySnapshot,
    candidate?.entrySnapshot,
    candidate?.latestSnapshot,
    trade?.exitSnapshot,
    trade?.currentSnapshot,
    currentRow
  ].filter(isObject);

  return sources.reduce((merged, source) => mergeDefined(merged, source), {});
}

function mergeDefined(base, source) {
  const output = { ...base };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (isObject(value) && isObject(output[key])) {
      output[key] = mergeDefined(output[key], value);
    } else if (Array.isArray(value)) {
      output[key] = [...value];
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
