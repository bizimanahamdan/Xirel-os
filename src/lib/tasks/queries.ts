import 'server-only';
import { db } from '@/lib/db';
import { tasks, messages } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { AiMessage } from '@/lib/ai/types';

/**
 * Load all tasks for a workspace (used by chat sidebar/history)
 */
export async function getWorkspaceTasks(workspaceId: string) {
  try {
    return await db
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .orderBy(desc(tasks.createdAt))
      .limit(50); // Recent tasks only
  } catch (err) {
    console.error('Failed to fetch workspace tasks:', err);
    return [];
  }
}

/**
 * Load a specific task with its messages
 */
export async function getTaskWithMessages(taskId: string) {
  try {
    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    // Narrow on the extracted element itself, not taskRows.length — same
    // pattern as the createTask and orchestrator fixes. A .length check
    // alone doesn't narrow taskRows[0] under noUncheckedIndexedAccess.
    const task = taskRows[0];
    if (!task) {
      return null;
    }

    const taskMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .orderBy(messages.createdAt);

    return {
      task,
      messages: taskMessages,
    };
  } catch (err) {
    console.error('Failed to fetch task with messages:', err);
    return null;
  }
}

/**
 * Get task messages for context in streaming
 */
export async function getTaskMessages(taskId: string) {
  try {
    return await db
      .select()
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .orderBy(messages.createdAt);
  } catch (err) {
    console.error('Failed to fetch task messages:', err);
    return [];
  }
}

/**
 * Load task messages as AiMessage[], including tool-call data. Used by
 * the orchestrator (Phase 3) to reconstruct conversation state — unlike
 * getTaskMessages() above, this preserves toolCalls/toolCallId/toolName
 * so a resumed conversation with pending tool context round-trips
 * correctly. Kept separate from getTaskMessages() so Phase 2's chat
 * endpoint (which only needs role + content) is unaffected.
 */
export async function getTaskMessagesForAgent(taskId: string): Promise<AiMessage[]> {
  const rows = await getTaskMessages(taskId);
  return rows.map((m) => ({
    role: m.role as AiMessage['role'],
    content: m.content,
    toolCalls: m.toolCalls ?? undefined,
    toolCallId: m.toolCallId ?? undefined,
    name: m.toolName ?? undefined,
  }));
}

/**
 * Persist a batch of AiMessage objects (as produced by the orchestrator)
 * to the messages table, preserving tool-call data. Inserts are done in
 * a single statement to keep ordering (createdAt) tight when several
 * tool-call/tool-result messages are produced in the same agent turn.
 */
export async function saveAgentMessages(taskId: string, agentMessages: AiMessage[]) {
  if (agentMessages.length === 0) return;
  try {
    await db.insert(messages).values(
      agentMessages.map((m) => ({
        taskId,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? null,
        toolCallId: m.toolCallId ?? null,
        toolName: m.name ?? null,
      }))
    );
  } catch (err) {
    console.error('Failed to save agent messages:', err);
    throw err;
  }
}

/**
 * Create a new task (called when user starts new conversation)
 */
export async function createTask(workspaceId: string, userId: string, title: string) {
  try {
    const [newTask] = await db
      .insert(tasks)
      .values({
        workspaceId,
        userId,
        title,
        status: 'running',
      })
      .returning();

    // .returning() types its result as T[], so destructuring the first
    // element is T | undefined at the type level even though a
    // successful single-row insert always returns exactly one row.
    // Throwing here (rather than returning possibly-undefined) means
    // every caller gets a guaranteed non-undefined Task back instead of
    // each needing its own undefined check — same TypeScript-narrowing
    // discipline as the chat-client.tsx array-element fix, applied at
    // the source instead of at every call site.
    if (!newTask) {
      throw new Error('Task insert returned no row');
    }

    return newTask;
  } catch (err) {
    console.error('Failed to create task:', err);
    throw err;
  }
}

/**
 * Update task status
 */
export async function updateTaskStatus(
  taskId: string,
  status: 'queued' | 'planning' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled'
) {
  try {
    return await db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
  } catch (err) {
    console.error('Failed to update task status:', err);
    throw err;
  }
}
