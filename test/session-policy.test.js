import assert from "node:assert/strict";
import test from "node:test";
import { sessionActivationUpdates, sessionIsRejected } from "../supabase/functions/techno-funda-app-api/session-policy.js";

test("owner sessions remain valid on multiple devices", () => {
  const owner = { role: "admin", active_session_id: "older-session", active_device_id: "older-device" };
  assert.equal(sessionIsRejected(owner, { session_id: "new-session" }, true, "new-device"), false);
  assert.deepEqual(sessionActivationUpdates(owner, "new-session", "new-device", "now"), { last_login_at: "now" });
});

test("member access remains limited to its latest active device", () => {
  const member = { role: "member", active_session_id: "current-session", active_device_id: "current-device" };
  assert.equal(sessionIsRejected(member, { session_id: "refreshed-session" }, true, "current-device"), false);
  assert.equal(sessionIsRejected(member, { session_id: "current-session" }, true, "older-device"), true);
  assert.deepEqual(sessionActivationUpdates(member, "new-session", "new-device", "now"), {
    active_session_id: "new-session",
    active_device_id: "new-device",
    last_login_at: "now"
  });
});

test("login activation can run before a member session is selected", () => {
  assert.equal(sessionIsRejected({ role: "member" }, { session_id: "new-session" }, false, "new-device"), false);
});

test("legacy member sessions fall back to the Supabase session identifier", () => {
  const member = { role: "member", active_session_id: "current-session" };
  assert.equal(sessionIsRejected(member, { session_id: "current-session" }, true, "new-device"), false);
  assert.equal(sessionIsRejected(member, { session_id: "older-session" }, true, "new-device"), true);
});
