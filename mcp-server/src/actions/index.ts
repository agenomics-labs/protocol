// PR1 pilot: 5 high-risk Actions registered through the ADR-058 Action<I, O> shape.
// Remaining 18 stay on the legacy switch-case dispatch in src/index.ts until PR1.5.

import type { Action } from "../types/action.js";
import {
  createEscrowAction,
  approveMilestoneAction,
  cancelEscrowAction,
  resolveDisputeAction,
} from "./settlement.js";
import { vaultTransferAction } from "./vault.js";

export const pilotActions: Action<any, any>[] = [
  createEscrowAction,
  approveMilestoneAction,
  cancelEscrowAction,
  resolveDisputeAction,
  vaultTransferAction,
];

export const pilotActionNames = new Set(pilotActions.map((a) => a.name));
