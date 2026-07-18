export const MASTER_RESET_CONFIRMATION = "RESET SELECTED PORTFOLIO";

export function requireMasterResetConfirmation(value) {
  const confirmation = String(value || "").trim();
  if (confirmation !== MASTER_RESET_CONFIRMATION) {
    const error = new Error(`Type ${MASTER_RESET_CONFIRMATION} exactly to confirm the selected portfolio reset.`);
    error.status = 400;
    throw error;
  }
  return confirmation;
}
