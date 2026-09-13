// Fail closed until the replacement path has a drained admission/publication
// boundary and verified bind rollback. Do not fall back to ordinary switchSession:
// its shutdown kills background jobs and disconnects helper monitors.
export function assertMaintenanceAvailable(): void {
  throw new Error("Maintenance cleanup is unavailable: live ownership transfer is not yet verified. No interruption or cleanup was performed.");
}

export type MaintenancePhase = "pending" | "parked" | "claimed" | "error";

export interface MaintenanceHandoff {
  maintenanceId: string;
  ownerEpoch: string;
  sessionId: string;
  sessionFile?: string;
  branchAnchor?: string | null;
  jobId?: string;
  attemptId?: string;
}

export interface MaintenancePrepareResult {
  replace?: boolean;
}
