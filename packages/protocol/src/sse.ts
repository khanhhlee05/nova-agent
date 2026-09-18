/**
 * A minimal server-sent events parser shared by the browser client, the
 * OpenRouter adapter, and the API tests. Dependency-free and built on
 * `getReader()` rather than async iteration so it runs on Chrome 116.
 */
export type SseFrame = { event: string | null; data: string; id: string | null };

const parseBlock = (block: string): SseFrame | null => {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const rawLine of block.split(/\r\n|\n|\r/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length === 0 && event === null && id === null) return null;
  return { event, data: data.join("\n"), id };
};

export async function* parseSseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseBlock(block);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const frame = parseBlock(buffer);
      if (frame) yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export const encodeSseFrame = ({ event, data, id }: Partial<SseFrame> & { data: string }): string => {
  const lines: string[] = [];
  if (id !== null && id !== undefined) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  for (const line of data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
};

/** Turns a list of strings into a byte stream, chunked as given, for tests and fixtures. */
export const streamFromChunks = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
};
