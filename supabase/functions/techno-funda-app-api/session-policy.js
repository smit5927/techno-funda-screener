export function sessionActivationUpdates(profile, sessionId, deviceId, now) {
  if (profile?.role === "admin") return { last_login_at: now };
  return { active_session_id: sessionId, active_device_id: deviceId, last_login_at: now };
}

export function sessionIsRejected(profile, claims, activeSessionRequired, deviceId) {
  if (!activeSessionRequired || profile?.role === "admin") return false;
  if (profile?.active_device_id) return profile.active_device_id !== deviceId;
  return profile?.active_session_id !== claims?.session_id;
}
