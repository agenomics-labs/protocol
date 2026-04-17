/**
 * Enum formatter functions shared across handler modules.
 * Maps Anchor enum variants to/from human-readable strings.
 */

export function mapPricingModel(model: string): any {
  switch (model) {
    case "perTask":
      return { perTask: {} };
    case "perHour":
      return { perHour: {} };
    case "perToken":
      return { perToken: {} };
    default:
      throw new Error(
        `Unknown pricing model: ${model}. Use perTask, perHour, or perToken.`
      );
  }
}

export function formatPricingModel(model: any): string {
  if (model.perTask !== undefined) return "perTask";
  if (model.perHour !== undefined) return "perHour";
  if (model.perToken !== undefined) return "perToken";
  return "unknown";
}

export function formatAgentStatus(status: any): string {
  if (status.active !== undefined) return "active";
  if (status.paused !== undefined) return "paused";
  if (status.retired !== undefined) return "retired";
  return "unknown";
}

export function formatEscrowStatus(status: any): string {
  if (status.created !== undefined) return "created";
  if (status.active !== undefined) return "active";
  if (status.completed !== undefined) return "completed";
  if (status.disputed !== undefined) return "disputed";
  if (status.cancelled !== undefined) return "cancelled";
  if (status.expired !== undefined) return "expired";
  return "unknown";
}

export function formatMilestoneStatus(status: any): string {
  if (status.pending !== undefined) return "pending";
  if (status.submitted !== undefined) return "submitted";
  if (status.approved !== undefined) return "approved";
  if (status.rejected !== undefined) return "rejected";
  if (status.disputed !== undefined) return "disputed";
  return "unknown";
}
