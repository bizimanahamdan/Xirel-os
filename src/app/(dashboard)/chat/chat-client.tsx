'use client';

import { useEffect, useRef, useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
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

    // Bounds the browser's own wait for the entire exchange (connecting
    // AND streaming the response), independent of anything the server
    // does. A single AbortSignal on fetch() covers body-reading too, not
    // just the initial connection — so one timer for the whole lifecycle
    // is correct here; there's no need to re-arm it once headers arrive.
    // Without this, if the connection ever goes silent mid-stream (rather
    // than closing cleanly or erroring — a real possibility if the
    // serverless platform kills the backend function while a response is
    // in flight) reader.read() below can hang forever with nothing to
    // catch it, even though the existing finally block correctly clears
    // isLoading on every OTHER exit path. 65s gives ~5s slack over the
    // server's own 60s maxDuration (see /api/chat/route.ts) so a
    // legitimate full-duration server response isn't cut off first.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 65_000);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          message: userMessage,
          workspaceId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to send message');
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      let fullResponse = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Initialize assistant message
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);

          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.error) {
              throw new Error(parsed.error);
            }

            if (parsed.text) {
              fullResponse += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                const lastMessage = updated[updated.length - 1];
                // Only update if the last message is an assistant message
                if (lastMessage && lastMessage.role === 'assistant') {
                  lastMessage.content = fullResponse;
                }
                return updated;
              });
            }
          } catch {
            // Ignore parse errors for partial chunks
          }
        }
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
          {taskId && (
            <div className="text-xs text-muted">
              Task: {taskId.slice(0, 8)}...
            </div>
          )}
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
            {isLoading && messages[messages.length - 1]?.role === 'assistant' && (
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
