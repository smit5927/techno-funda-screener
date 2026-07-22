import assert from "node:assert/strict";
import test from "node:test";
import { canReachExecutionDate, isMorningApprovalWindow, morningApprovalStatus } from "../src/morning-cycle.js";

test("morning approval is limited to the weekday 08:20-09:15 IST recovery window", () => {
  assert.equal(isMorningApprovalWindow("2026-07-20T03:00:00.000Z"), true); // 08:30 IST
  assert.equal(isMorningApprovalWindow("2026-07-20T03:30:00.000Z"), true); // 09:00 IST
  assert.equal(isMorningApprovalWindow("2026-07-20T03:44:00.000Z"), true); // 09:14 IST
  assert.equal(isMorningApprovalWindow("2026-07-20T03:46:00.000Z"), false); // 09:16 IST
  assert.equal(isMorningApprovalWindow("2026-07-20T06:16:00.000Z"), false); // 11:46 IST
  assert.equal(isMorningApprovalWindow("2026-07-19T03:00:00.000Z"), false); // Sunday
});

test("same-session alert is valid before 09:17 and invalid after the execution minute", () => {
  assert.equal(canReachExecutionDate("2026-07-20T03:00:00.000Z", "2026-07-20"), true);
  assert.equal(canReachExecutionDate("2026-07-20T03:47:00.000Z", "2026-07-20"), false);
  assert.equal(canReachExecutionDate("2026-07-21T03:00:00.000Z", "2026-07-20"), true);
});

test("a delayed GitHub morning schedule becomes a data refresh without approvals or alerts", () => {
  const valid = morningApprovalStatus(true, "2026-07-20T03:00:00.000Z");
  const late = morningApprovalStatus(true, "2026-07-20T06:16:00.000Z");
  assert.equal(valid.allowed, true);
  assert.equal(late.allowed, false);
  assert.equal(late.reason, "outside-08:20-to-09:15-IST");
});
