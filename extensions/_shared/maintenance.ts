export type MaintenancePhase = "pending" | "parked" | "claimed" | "error";

export interface MaintenanceHandoff {
  maintenanceId: string;
  ownerEpoch: string;
  sessionId: string;
  sessionFile?: string;
  branchAnchor?: string | null;
  /** Selected leaf sealed after the outgoing run drains. */
  replacementAnchor?: string | null;
  jobId?: string;
  attemptId?: string;
  reportPath?: string;
}

export interface MaintenancePrepareResult {
  replace?: boolean;
  afterNoReplace?: () => void | Promise<void>;
}
