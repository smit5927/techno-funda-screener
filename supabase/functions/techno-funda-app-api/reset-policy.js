export const MASTER_RESET_CONFIRMATION = "RESET ALL PORTFOLIOS";

export function requireMasterResetConfirmation(value) {
  const confirmation = String(value || "").trim();
  if (confirmation !== MASTER_RESET_CONFIRMATION) {
    const error = new Error(`Type ${MASTER_RESET_CONFIRMATION} exactly to confirm the master reset.`);
    error.status = 400;
    throw error;
  }
  return confirmation;
}
