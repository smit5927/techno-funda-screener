import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveRequestUrl } from "../public/auth-request.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("authenticated fetch routing recognizes URL objects", () => {
  const target = new URL("https://example.supabase.co/functions/v1/app?view=meta");
  assert.equal(resolveRequestUrl(target, "https://example.test/").href, target.href);
});

test("authenticated fetch routing recognizes strings and Request-like objects", () => {
  assert.equal(resolveRequestUrl("/api/state", "https://example.test/").href, "https://example.test/api/state");
  assert.equal(
    resolveRequestUrl({ url: "https://example.supabase.co/functions/v1/app" }, "https://example.test/").href,
    "https://example.supabase.co/functions/v1/app"
  );
});

test("static website build publishes the authentication helper", () => {
  const buildSource = fs.readFileSync(path.join(rootDir, "src", "build-static-site.js"), "utf8");
  assert.match(buildSource, /"auth-request\.js"/);
  assert.match(buildSource, /"decision-guide\.js"/);
});
