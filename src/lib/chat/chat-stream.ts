/**
 * Shared reader for the /api/chat SSE stream.
 *
 * Extracted from chat-client.tsx so the parsing rules live in ONE tested
 * place instead of inline inside a React component. Two bugs this fixes
 * relative to the original inline loop:
 *
 * 1. PARTIAL LINES: a single reader.read() chunk can end in the middle of
 *    an SSE line (or contain several). The original code parsed each chunk
 *    independently and threw away any line fragment split across reads —
 *    JSON.parse failed silently and that text was permanently lost. This
 *    reader buffers the trailing partial line (same approach the server-side
 *    providers use) and processes it once the rest arrives.
 *
 * 2. SWALLOWED ERRORS: the server sends `data: {"error": "..."}` events
 *    (with HTTP 200 — the stream has already started, so the status code
 *    can't change). The original code raised the error inside a try whose
 *    catch ignored everything, so provider failures were invisible: the UI
 *    just showed an empty assistant bubble. This reader surfaces the error
 *    through onError and stops reading.
 *
 * Never logs message content or credentials — it only routes parsed
 * fields to the caller's callbacks.
 */

export interface ChatStreamEvent {
  /** Incremental assistant text. */
  text?: string;
  /** Provider that produced this chunk (informational). */
  provider?: string;
  /** Present when the server failed — see /api/chat's error event. */
  error?: string;
}

export interface ChatStreamHandlers {
  /** Called once per text delta, in order. */
  onText: (text: string, providerId?: string) => void;
  /** Called at most once, when the server reports a failure mid-stream. */
  onError?: (message: string) => void;
}

export async function readChatStream(
  stream: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawError = false;

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let parsed: ChatStreamEvent;
    try {
      parsed = JSON.parse(payload) as ChatStreamEvent;
    } catch {
      // Malformed/partial JSON — ignore the line rather than killing the
      // stream over one bad event.
      return;
    }

    if (typeof parsed.error === 'string' && parsed.error) {
      sawError = true;
      handlers.onError?.(parsed.error);
      return;
    }

    if (typeof parsed.text === 'string' && parsed.text) {
      handlers.onText(parsed.text, parsed.provider);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        processLine(line);
        if (sawError) return;
      }
    }

    // Flush any final line that arrived without a trailing newline.
    if (buffer && !sawError) {
      processLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}
