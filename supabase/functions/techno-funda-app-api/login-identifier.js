export function classifyLoginIdentifier(input) {
  const raw = String(input || "").trim();
  if (!raw) return { kind: "invalid", value: "" };
  const email = raw.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { kind: "email", value: email };
  const rawDigits = raw.replace(/[^0-9]/g, "");
  const digits = /^91\d{10}$/.test(rawDigits) ? rawDigits.slice(2) : rawDigits;
  if (/^[+()\d\s-]+$/.test(raw) && digits.length >= 8 && digits.length <= 15) {
    return { kind: "mobile", value: digits };
  }
  const username = raw.toLowerCase();
  if (/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return { kind: "username", value: username };
  return { kind: "invalid", value: "" };
}
