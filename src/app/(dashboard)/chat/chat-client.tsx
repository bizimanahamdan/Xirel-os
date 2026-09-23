'use client';

import { useEffect, useRef, useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentRunInfo {
  runId: string;
  status: 'completed' | 'waiting_for_approval' | 'failed';
  verification?: { verified: number; failed: number; unavailable: number } | null;
}

interface ChatClientProps {
  workspaceId: string;
}

export default function ChatClient({ workspaceId }: ChatClientProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState<string>('New Conversation');
  const [lastRun, setLastRun] = useState<AgentRunInfo | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load task history on mount
  useEffect(() => {
    const loadTaskHistory = async () => {
      try {
        // Fetch all tasks for this workspace to allow switching
        // (implemented as sidebar feature in Phase 3)
        // For now, just establish the workspace context
      } catch (err) {
        console.error('Failed to load task history:', err);
      }
    };
    loadTaskHistory();
  }, [workspaceId]);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);
    setError(null);

    // Set title from first message if this is a new task
    if (!taskId && taskTitle === 'New Conversation') {
      setTaskTitle(userMessage.slice(0, 50));
    }

    // Bounds the browser's own wait for the whole agent turn (connect +
    // plan + execute + verify), independent of anything the server does.
    // A single AbortSignal on fetch() covers body-reading too. The agent
    // runtime persists its run/trajectory server-side, so an aborted wait
    // here never loses the work record — the run stays inspectable at
    // /api/agent/runs/[id] even if this request gives up. 65s gives ~5s
    // slack over the route's own 60s maxDuration.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 65_000);

    try {
      // Phase 4: the main chat talks to the AGENT RUNTIME (plan → execute
      // → verify), not the bare streaming model endpoint. /api/chat
      // remains available for compatibility but is no longer used here.
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          message: userMessage,
          workspaceId,
        }),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          (data && typeof data.error === 'string' && data.error) ||
            'Failed to send message'
        );
      }

      if (data && typeof data.taskId === 'string') {
        setTaskId(data.taskId);
      }

      const text = data && typeof data.text === 'string' ? data.text : '';
      if (data && typeof data.runId === 'string') {
        setLastRun({
          runId: data.runId,
          status: data.status === 'waiting_for_approval' ? 'waiting_for_approval' : data.status,
          verification: data.verification ?? null,
        });
      }

      if (text) {
        setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
      } else {
        // No text and no thrown error: surface honestly instead of a
        // silent empty response.
        setError('The agent returned an empty response. Check the run status for details.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Request timed out. The AI provider may be slow or unreachable — please try again.'
          : message
      );
      console.error('Chat error:', err);
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <h1 className="text-xl font-semibold">AI Command Center</h1>
            <p className="mt-1 text-sm text-muted">
              {taskTitle === 'New Conversation' ? 'Start a new conversation' : taskTitle}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 text-xs text-muted">
            {taskId && <div>Task: {taskId.slice(0, 8)}...</div>}
            {lastRun && (
              <div className="flex items-center gap-2">
                <span>
                  Run {lastRun.runId.slice(0, 8)}: {lastRun.status.replace(/_/g, ' ')}
                </span>
                {lastRun.verification && (lastRun.verification.verified > 0 || lastRun.verification.failed > 0) && (
                  <span
                    className={
                      lastRun.verification.failed > 0
                        ? 'text-red-400'
                        : 'text-green-400'
                    }
                  >
                    {lastRun.verification.verified} verified
                    {lastRun.verification.failed > 0
                      ? `, ${lastRun.verification.failed} failed`
                      : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-muted">No messages yet</p>
              <p className="mt-1 text-sm text-muted">Start by typing a command or question</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-lg rounded-lg px-4 py-3 ${
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-surface text-white'
                  }`}
                >
                  <p className="text-sm">{message.content}</p>
                </div>
              </div>
            ))}
            {/* Assistant bubble is added lazily (on first text), so show the
                typing indicator whenever a request is in flight. */}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-surface px-4 py-3 text-white">
                  <div className="flex gap-1">
                    <div className="h-2 w-2 rounded-full bg-muted animate-bounce" />
                    <div className="h-2 w-2 rounded-full bg-muted animate-bounce" style={{ animationDelay: '0.1s' }} />
                    <div className="h-2 w-2 rounded-full bg-muted animate-bounce" style={{ animationDelay: '0.2s' }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="border-t border-border bg-red-500/10 px-6 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Input form */}
      <form onSubmit={handleSubmit} className="border-t border-border px-6 py-4">
        <div className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            placeholder="Ask your AI team to build, research, analyze..."
            className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {isLoading ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
