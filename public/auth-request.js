export function resolveRequestUrl(input, baseUrl) {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input, baseUrl);
  if (input && typeof input.url === "string") return new URL(input.url, baseUrl);
  throw new TypeError("Unsupported fetch input");
}
