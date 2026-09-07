import assert from "node:assert/strict";
import test from "node:test";
import { decodeNDJSON } from "../../src/providers/ndjson.js";
import { decodeLines } from "../../src/providers/lines.js";
import { decodeSSE } from "../../src/providers/sse.js";
import { byteChunks, readable } from "./helpers.js";

test("SSE decoder handles comments, multiline data, CRLF, unicode splits, and EOF dispatch", async () => {
  const source =
    ": keepalive\r\nid: evt-1\r\nevent: token\r\ndata: hello\r\ndata: 🌍\r\nretry: 15\r\n\r\ndata: tail";
  const events = [];
  for await (const event of decodeSSE(readable(byteChunks(source)))) events.push(event);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    data: "hello\n🌍",
    event: "token",
    id: "evt-1",
    retry: 15,
    raw: ["id: evt-1", "event: token", "data: hello", "data: 🌍", "retry: 15"],
  });
  assert.deepEqual(events[1], { data: "tail", id: "evt-1", raw: ["data: tail"] });
});

test("SSE replacement decoding preserves valid UTF-8 split across byte boundaries", async () => {
  const events = [];
  for await (const event of decodeSSE(readable(byteChunks("data: 🌍漢字\n\n")))) events.push(event);

  assert.deepEqual(events, [{ data: "🌍漢字", raw: ["data: 🌍漢字"] }]);
});

test("SSE replacement decoding accepts malformed and truncated UTF-8", async (t) => {
  await t.test("malformed sequence", async () => {
    const events = [];
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("data: bad "),
      0xc3,
      0x28,
      0x0a,
      0x0a,
    ]);
    for await (const event of decodeSSE(readable(byteChunks(bytes)))) events.push(event);
    assert.deepEqual(events, [{ data: "bad �(", raw: ["data: bad �("] }]);
  });

  await t.test("truncated sequence at EOF", async () => {
    const events = [];
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("data: tail "),
      0xe2,
      0x82,
    ]);
    for await (const event of decodeSSE(readable(byteChunks(bytes)))) events.push(event);
    assert.deepEqual(events, [{ data: "tail �", raw: ["data: tail �"] }]);
  });
});

test("SSE decoder bounds the whole stream including comments", async () => {
  await assert.rejects(async () => {
    for await (const _event of decodeSSE(readable(byteChunks(": long keepalive\n\ndata: ok\n\n")), {
      maxStreamBytes: 8,
    })) {
      // Consume the stream.
    }
  }, /SSE stream exceeded 8 bytes/);
});

test("NDJSON decoder handles one-byte chunks and a final unterminated line", async () => {
  const values = [];
  for await (const value of decodeNDJSON(readable(byteChunks('{"text":"🌍"}\r\n{"done":true}')))) {
    values.push(value);
  }
  assert.deepEqual(values, [{ text: "🌍" }, { done: true }]);
});

test("NDJSON decoder rejects malformed lines instead of silently dropping them", async () => {
  await assert.rejects(async () => {
    for await (const _value of decodeNDJSON(readable(byteChunks('{"ok":true}\nnot-json\n')))) {
      // Consume the stream.
    }
  }, /Malformed NDJSON line/);
});

test("NDJSON decoder continues to reject malformed UTF-8", async () => {
  await assert.rejects(async () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('{"text":"'), 0xc3, 0x28, 0x22, 0x7d, 0x0a]);
    for await (const _value of decodeNDJSON(readable(byteChunks(bytes)))) {
      // Consume the stream.
    }
  }, /Stream contained invalid UTF-8/);
});

test("line decoder validates limits before acquiring the stream reader", async () => {
  const body = readable([]);
  await assert.rejects(decodeLines(body, { maxLineBytes: 0 }).next(), /maxLineBytes must be positive/u);
  assert.equal(body.locked, false);
});

test("fragmented line decoding performs bounded byte-counting work", async () => {
  const source = "x".repeat(4_096);
  const body = readable(byteChunks(source));
  const descriptor = Object.getOwnPropertyDescriptor(Buffer, "byteLength");
  assert.ok(descriptor);
  const originalByteLength = Buffer.byteLength;
  let byteVisits = 0;
  const measuredByteLength: typeof Buffer.byteLength = (value, encoding) => {
    const bytes = originalByteLength(value, encoding);
    byteVisits += bytes;
    return bytes;
  };
  const lines: string[] = [];
  Object.defineProperty(Buffer, "byteLength", { ...descriptor, value: measuredByteLength });
  try {
    for await (const line of decodeLines(body, { maxLineBytes: source.length })) lines.push(line);
  } finally {
    Object.defineProperty(Buffer, "byteLength", descriptor);
  }
  assert.deepEqual(lines, [source]);
  assert.equal(body.locked, false);
  assert.ok(byteVisits <= source.length * 8, `counted ${byteVisits} bytes for ${source.length} input bytes`);
});

test("incremental line accounting preserves delimiter splits, UTF-8 limits, and EOF", async () => {
  for (const [source, expected] of [
    ["a\rb\r\nc\nd\r", ["a", "b", "c", "d"]],
    ["\r\n\r", ["", ""]],
    ["🌍\n漢", ["🌍", "漢"]],
  ] as const) {
    for (const sizes of [[], [128]]) {
      const body = readable(byteChunks(source, sizes));
      const lines: string[] = [];
      for await (const line of decodeLines(body, { maxLineBytes: 4 })) lines.push(line);
      assert.deepEqual(lines, expected);
      assert.equal(body.locked, false);
    }
  }
  const tooLong = readable(byteChunks("🌍"));
  await assert.rejects(async () => {
    for await (const _line of decodeLines(tooLong, { maxLineBytes: 3 })) { /* Consume. */ }
  }, /Stream line exceeded 3 bytes/u);
  assert.equal(tooLong.locked, false);
});

for (const content of ["abcd", "🌍"]) {
  for (const delimiter of ["CR", "CRLF"] as const) {
    test(`line byte limits exclude split ${delimiter} after ${content === "abcd" ? "ASCII" : "UTF-8"} content`, async () => {
      const source = content + (delimiter === "CR" ? "\r" : "\r\n");
      for (const sizes of [[128], []]) {
        const body = readable(byteChunks(source, sizes));
        const lines: string[] = [];
        for await (const line of decodeLines(body, { maxLineBytes: 4 })) lines.push(line);
        assert.deepEqual(lines, [content]);
        assert.equal(body.locked, false);
      }
    });
  }
}

test("NDJSON preserves a transport failure instead of reporting malformed UTF-8", async () => {
  const failure = new Error("transport disconnected");
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
  await assert.rejects(decodeNDJSON(body).next(), (error) => error === failure);
  assert.equal(body.locked, false);
});

test("early line-decoder return releases its reader without awaiting source cancellation", async () => {
  let releaseCancel!: () => void;
  const pendingCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("one\ntwo\n")); },
    cancel() { cancellations += 1; return pendingCancel; },
  });
  const iterator = decodeLines(body);
  assert.deepEqual(await iterator.next(), { value: "one", done: false });
  const returning = iterator.return();
  let returned = false;
  void returning.then(() => { returned = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, true);
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  } finally {
    releaseCancel();
    await returning;
  }
});
