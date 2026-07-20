import assert from "node:assert/strict";
import test from "node:test";

import { hasPendingExecutionWork } from "../src/screener.js";

test("execution retries run only while a 09:17 order still needs processing", () => {
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_ENTRY", orderState: "CONFIRMED_FOR_0917" }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_EXIT", exitOrderState: "CONFIRMED_FOR_0917" }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_PARTIAL_EXIT", partialExitOrderState: "CONFIRMED_FOR_0917" }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "OPEN", pendingAdd: { signalDate: "2026-07-13", orderState: "CONFIRMED_FOR_0917" } }]), true);
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_EXIT", pendingAdd: { signalDate: "2026-07-13", orderState: "CONFIRMED_FOR_0917" } }]), false);
  assert.equal(hasPendingExecutionWork([{ status: "PENDING_ENTRY" }]), false);
  assert.equal(hasPendingExecutionWork([{ status: "OPEN" }, { status: "CLOSED" }]), false);
});
