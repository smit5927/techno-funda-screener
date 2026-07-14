import assert from "node:assert/strict";
import test from "node:test";

import { hasPendingExecutionWork } from "../src/screener.js";

test("execution retries run only while a 09:17 order still needs processing", () => {
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_ENTRY" }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_EXIT" }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_PARTIAL_EXIT" }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "OPEN", pendingAdd: { signalDate: "2026-07-13" } }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "OPEN" }, { status: "CLOSED" }]), false);
});
