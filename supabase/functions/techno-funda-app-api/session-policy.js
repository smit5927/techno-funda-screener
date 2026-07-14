export function sessionActivationUpdates(profile, sessionId, now) {
  if (profile?.role === "admin") return { last_login_at: now };
  return { active_session_id: sessionId, last_login_at: now };
}

export function sessionIsRejected(profile, claims, activeSessionRequired) {
  if (!activeSessionRequired || profile?.role === "admin") return false;
  return profile?.active_session_id !== claims?.session_id;
}
