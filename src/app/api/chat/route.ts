import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { routeStreamText } from '@/lib/ai/router';
import { getConfiguredProviderInstances } from '@/lib/ai/registry';
import { getTaskMessages, createTask, updateTaskStatus } from '@/lib/tasks/queries';
import { withTimeout } from '@/lib/db/with-timeout';
import type { AiProviderId } from '@/lib/ai/types';

/**
 * Vercel's default serverless function timeout is 10s on the Hobby
 * plan — shorter than this route's own DB timeouts (10-15s) and far
 * shorter than the AI provider timeout (30s, up to 3 fallback
 * attempts). Without this, the platform kills the function before any
 * of this file's own timeout/error-handling logic gets a chance to
 * run, which surfaces to the client as a hang with no error rather
 * than a clean failure. 60s is the max configurable on Hobby; raise
 * further if you're on Pro and provider responses are still cut off.
 */
export const maxDuration = 60;

/**
 * POST /api/chat
 *
 * Streaming chat endpoint. Accepts a message, routes it to an AI provider,
 * streams the response back to the client, and stores both message and
 * response in the database.
 *
 * Request body:
 *   {
 *     "taskId": "uuid or null (null = create new task)",
 *     "message": "user message text",
 *     "workspaceId": "workspace uuid",
 *     "providerPriority": ["openrouter", "groq"] // optional, defaults to configured providers
 *   }
 */

const chatRequestSchema = z.object({
  taskId: z.string().uuid().optional().nullable(),
  message: z.string().min(1, 'Message cannot be empty').max(10000),
  workspaceId: z.string().uuid(),
  providerPriority: z.array(z.string()).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 }
    );
  }

  const { taskId, message, workspaceId, providerPriority } = parsed.data;

  let currentTaskId = taskId;

  // Create or reuse task
  if (!currentTaskId) {
    try {
      const newTask = await createTask(workspaceId, user.id, message.slice(0, 100));
      currentTaskId = newTask.id;
    } catch (err) {
      console.error('Failed to create task:', err);
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
  }

  // Store user message
  try {
    await withTimeout(
      db.insert(messages).values({
        taskId: currentTaskId,
        role: 'user',
        content: message,
      }),
      5_000,
      'store user message'
    );
  } catch (err) {
    console.error('Failed to store user message:', err);
    return NextResponse.json({ error: 'Failed to store message' }, { status: 500 });
  }

  // Stream response
  const encodedStream = new ReadableStream({
    async start(controller) {
      try {
        // Fetch existing messages for context
        const messageHistory = await getTaskMessages(currentTaskId);

        const aiMessages = messageHistory.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
        }));

        // Determine provider priority — validate that these are real provider IDs
        let providers: AiProviderId[] = [];
        if (providerPriority && Array.isArray(providerPriority)) {
          providers = providerPriority.filter((p) =>
            ['gemini', 'groq', 'qwen', 'moonshot', 'openai', 'anthropic', 'openrouter'].includes(
              p
            )
          ) as AiProviderId[];
        }

        if (providers.length === 0) {
          providers = getConfiguredProviderInstances().map((p) => p.id);
        }

        if (providers.length === 0) {
          throw new Error('No AI providers configured');
        }

        // Route to provider with streaming
        let fullResponse = '';
        let streamStarted = false;

        for await (const chunk of routeStreamText({
          messages: aiMessages,
          model: 'openai/gpt-4-turbo', // Default; make configurable per workspace later
          providerPriority: providers,
          temperature: 0.7,
        })) {
          streamStarted = true;
          fullResponse += chunk.text;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ text: chunk.text, provider: chunk.providerId })}\n\n`
            )
          );
        }

        if (!streamStarted) {
          throw new Error('No streaming response received from any provider');
        }

        // Store assistant response
        await db.insert(messages).values({
          taskId: currentTaskId,
          role: 'assistant',
          content: fullResponse,
        });

        // Update task status
        await updateTaskStatus(currentTaskId, 'completed');

        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        console.error('Stream error:', err);
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ error: errorMessage })}\n\n`
          )
        );
        controller.close();

        // Mark task as failed
        try {
          await updateTaskStatus(currentTaskId, 'failed');
        } catch {
          // Silent fail — client already got the error
        }
      }
    },
  });

  return new NextResponse(encodedStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
