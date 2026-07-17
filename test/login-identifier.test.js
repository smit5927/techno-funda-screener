import assert from "node:assert/strict";
import test from "node:test";
import { classifyLoginIdentifier } from "../supabase/functions/techno-funda-app-api/login-identifier.js";

test("login accepts user ID, registered email or normalized mobile", () => {
  assert.deepEqual(classifyLoginIdentifier("5785"), { kind: "username", value: "5785" });
  assert.deepEqual(classifyLoginIdentifier("User.Name"), { kind: "username", value: "user.name" });
  assert.deepEqual(classifyLoginIdentifier("USER@Example.COM"), { kind: "email", value: "user@example.com" });
  assert.deepEqual(classifyLoginIdentifier("+91 98765-43210"), { kind: "mobile", value: "9876543210" });
});

test("invalid login identifiers are rejected without guessing an account", () => {
  assert.deepEqual(classifyLoginIdentifier(""), { kind: "invalid", value: "" });
  assert.deepEqual(classifyLoginIdentifier("two words"), { kind: "invalid", value: "" });
  assert.deepEqual(classifyLoginIdentifier("12"), { kind: "invalid", value: "" });
});
