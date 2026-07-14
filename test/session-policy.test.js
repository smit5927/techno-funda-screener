import assert from "node:assert/strict";
import test from "node:test";
import { sessionActivationUpdates, sessionIsRejected } from "../supabase/functions/techno-funda-app-api/session-policy.js";

test("owner sessions remain valid on multiple devices", () => {
  const owner = { role: "admin", active_session_id: "older-session" };
  assert.equal(sessionIsRejected(owner, { session_id: "new-session" }, true), false);
  assert.deepEqual(sessionActivationUpdates(owner, "new-session", "now"), { last_login_at: "now" });
});

test("member access remains limited to its latest active device", () => {
  const member = { role: "member", active_session_id: "current-session" };
  assert.equal(sessionIsRejected(member, { session_id: "current-session" }, true), false);
  assert.equal(sessionIsRejected(member, { session_id: "older-session" }, true), true);
  assert.deepEqual(sessionActivationUpdates(member, "new-session", "now"), {
    active_session_id: "new-session",
    last_login_at: "now"
  });
});

test("login activation can run before a member session is selected", () => {
  assert.equal(sessionIsRejected({ role: "member" }, { session_id: "new-session" }, false), false);
});
