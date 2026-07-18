import assert from "node:assert/strict";
import test from "node:test";
import {
  MASTER_RESET_CONFIRMATION,
  requireMasterResetConfirmation
} from "../supabase/functions/techno-funda-app-api/reset-policy.js";

test("master reset accepts only the exact destructive confirmation phrase", () => {
  assert.equal(requireMasterResetConfirmation(MASTER_RESET_CONFIRMATION), MASTER_RESET_CONFIRMATION);
  assert.throws(() => requireMasterResetConfirmation("reset selected portfolio"), /Type RESET SELECTED PORTFOLIO exactly/);
  assert.throws(() => requireMasterResetConfirmation("RESET ALL"), /Type RESET SELECTED PORTFOLIO exactly/);
});
