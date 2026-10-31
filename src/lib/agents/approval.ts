import 'server-only';
import { agentSettings } from './config';
import type { ToolRiskLevel } from './tools/types';

/**
 * Approval policy (Phase 4).
 *
 * Maps tool risk levels to execution semantics, per the permission model:
 *
 *   safe / low        → execute automatically (read-only or easily reversible
 *                       workspace-scoped writes)
 *   moderate          → configurable: auto-execute while
 *                       AGENT_AUTO_APPROVE_MODERATE=true, otherwise the run
 *                       enters waiting_for_approval
 *   high / destructive→ ALWAYS waiting_for_approval — never executed by an
 *                       unattended run
 *
 * No registered tool is currently moderate+; this policy is what makes it
 * SAFE to add such tools later — the runtime enforces the gate centrally
 * instead of trusting each tool to behave.
 */

export type ApprovalDecision =
  | { action: 'execute' }
  | { action: 'requires_approval'; reason: string };

const RISK_RANK: Record<ToolRiskLevel, number> = {
  safe: 0,
  low: 1,
  moderate: 2,
  high: 3,
  destructive: 4,
};

export function requiresApproval(riskLevel: ToolRiskLevel): ApprovalDecision {
  if (RISK_RANK[riskLevel] >= RISK_RANK.high) {
    return {
      action: 'requires_approval',
      reason:
        `Tool risk level "${riskLevel}" always requires human approval ` +
        'before an agent may execute it.',
    };
  }
  if (RISK_RANK[riskLevel] === RISK_RANK.moderate && !agentSettings.AGENT_AUTO_APPROVE_MODERATE) {
    return {
      action: 'requires_approval',
      reason:
        'Tool risk level "moderate" requires human approval ' +
        '(set AGENT_AUTO_APPROVE_MODERATE=true to auto-approve moderate-risk tools).',
    };
  }
  return { action: 'execute' };
}
