import { isJsonValue, type JsonValue } from "../core/json.js";
import { decodeLines } from "./lines.js";
import { ProtocolError } from "./transport.js";

export async function* decodeNDJSON(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<JsonValue, void, undefined> {
  for await (const line of decodeLines(stream)) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isJsonValue(value)) {
        throw new ProtocolError("NDJSON value is not JSON-serializable", line);
      }
      yield value;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("Malformed NDJSON line", line);
    }
  }
}
