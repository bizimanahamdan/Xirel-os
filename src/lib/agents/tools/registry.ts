import 'server-only';
import type { AiToolDefinition } from '@/lib/ai/types';
import type { ToolDefinition } from './types';
import { calculatorTool } from './calculator';
import { getCurrentDatetimeTool } from './datetime';

/**
 * Central tool registry. Adding a new tool means: implement it against
 * ToolDefinition in this directory, then register it here. Nothing else
 * in the codebase should import a specific tool file directly — this
 * mirrors the AI provider registry pattern (src/lib/ai/registry.ts) so
 * "tools are replaceable/extensible units" stays true in practice, not
 * just in the type system.
 */
const TOOL_REGISTRY: Record<string, ToolDefinition<any, any>> = {
  [calculatorTool.name]: calculatorTool,
  [getCurrentDatetimeTool.name]: getCurrentDatetimeTool,
};

export function getTool(name: string): ToolDefinition<any, any> | undefined {
  return TOOL_REGISTRY[name];
}

export function getAllTools(): ToolDefinition<any, any>[] {
  return Object.values(TOOL_REGISTRY);
}

/** Converts registered tools to the provider-agnostic wire shape AiRequest.tools expects. */
export function toAiToolDefinitions(tools: ToolDefinition<any, any>[]): AiToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputJsonSchema,
  }));
}
