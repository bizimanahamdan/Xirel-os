import 'server-only';
import type { z } from 'zod';

/**
 * Xirel OS — Tool Framework (Phase 3)
 *
 * Per the project spec, every tool must have: name, description, input
 * schema, output schema, permission requirement, risk level, and error
 * handling. This file is the contract; individual tools (calculator,
 * get_current_datetime, ...) implement it in this directory.
 *
 * Scope discipline: this phase ships the FRAMEWORK plus a small number
 * of real, deterministic, zero-external-dependency tools — enough to
 * prove the agentic loop end-to-end. It deliberately does NOT ship
 * web_search, github, or code-execution tools yet: those need real
 * external services (API keys, sandboxing) that haven't been wired up,
 * and stubbing them now would mean an agent that claims capabilities
 * it doesn't have — exactly what the project principles forbid.
 */

/**
 * Risk levels gate what an agent can do without a human in the loop.
 * 'safe' and 'low' may execute automatically. 'moderate' and above
 * should be reviewed by the calling agent's policy before execution —
 * the tool framework itself doesn't grant permission, it only declares
 * risk so the orchestrator/agent layer can enforce a policy consistently.
 */
export type ToolRiskLevel = 'safe' | 'low' | 'moderate' | 'high' | 'destructive';

/**
 * Minimum workspace role required to invoke this tool. Enforced by the
 * agent/orchestrator layer against workspace_members.role — the tool
 * itself has no access to the caller's identity beyond what's passed
 * in ToolExecutionContext.
 */
export type ToolPermission = 'member' | 'admin' | 'owner';

export interface ToolExecutionContext {
  workspaceId: string;
  userId: string;
  taskId: string;
}

export interface ToolResult<TOutput = unknown> {
  success: boolean;
  output?: TOutput;
  /** Human-readable error, safe to show the model and the user. Never include stack traces or secrets. */
  error?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** Zod schema — used for runtime validation of the model's arguments before execute() runs. */
  inputSchema: z.ZodType<TInput>;
  /** JSON Schema — the wire format sent to the model so it knows what arguments to produce. Must describe the same shape as inputSchema. */
  inputJsonSchema: Record<string, unknown>;
  /** Plain-language description of what execute() returns, for documentation/UI — not sent to the model. */
  outputDescription: string;
  riskLevel: ToolRiskLevel;
  requiredPermission: ToolPermission;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<ToolResult<TOutput>>;
}
