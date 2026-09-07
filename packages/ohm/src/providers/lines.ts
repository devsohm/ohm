import { ProtocolError } from "./transport.js";

export async function* decodeLines(
  stream: ReadableStream<Uint8Array>,
  options: { maxLineBytes?: number; malformedUtf8?: "reject" | "replace" } = {},
): AsyncGenerator<string, void, undefined> {
  const maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError("maxLineBytes must be positive");
  const decoder = new TextDecoder("utf-8", { fatal: options.malformedUtf8 !== "replace" });
  const decode = (bytes?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw new ProtocolError("Stream contained invalid UTF-8");
    }
  };
  const reader = stream.getReader();
  let buffer = "";
  let bufferBytes = 0;
  let pendingCarriageReturn = false;
  let finished = false;
  const append = (value: string): void => {
    buffer += value;
    bufferBytes += Buffer.byteLength(value, "utf8");
  };
  const checkLength = (): void => {
    if (bufferBytes > maxLineBytes) throw new ProtocolError(`Stream line exceeded ${maxLineBytes} bytes`);
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) finished = true;
      const chunk = decode(result.value, !result.done);
      if (chunk === "" && !result.done) continue;
      let offset = 0;
      if (pendingCarriageReturn) {
        checkLength();
        yield buffer;
        buffer = "";
        bufferBytes = 0;
        pendingCarriageReturn = false;
        if (chunk[0] === "\n") offset = 1;
      }

      while (true) {
        const boundary = findLineBoundary(chunk, result.done, offset);
        if (boundary === undefined) break;
        append(chunk.slice(offset, boundary.index));
        checkLength();
        yield buffer;
        buffer = "";
        bufferBytes = 0;
        offset = boundary.index + boundary.length;
      }
      pendingCarriageReturn = chunk.endsWith("\r") && !result.done;
      append(chunk.slice(offset, pendingCarriageReturn ? chunk.length - 1 : chunk.length));
      checkLength();
      if (result.done) break;
    }
    if (buffer !== "") yield buffer;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function findLineBoundary(
  value: string,
  eof: boolean,
  start: number,
): { index: number; length: number } | undefined {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\n") return { index, length: 1 };
    if (character !== "\r") continue;
    if (index + 1 < value.length) {
      return { index, length: value[index + 1] === "\n" ? 2 : 1 };
    }
    if (eof) return { index, length: 1 };
    return undefined;
  }
  return undefined;
}

export function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new ProtocolError("Response did not contain a body");
  return response.body;
}
