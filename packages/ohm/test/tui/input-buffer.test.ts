import assert from "node:assert/strict";
import test from "node:test";
import { StdinBuffer } from "@ohm/terminal";
import { TerminalInputBuffer } from "../../src/tui/input-buffer.js";

for (const [framer, inputKind] of [
  ["standalone", "ordinary"],
  ["product", "ordinary"],
  ["product", "repeated Alt"],
] as const) {
  test(`${framer} ${inputKind} input uses bounded string traversal`, () => {
    for (const length of [256, 512]) {
      const source = (inputKind === "ordinary" ? "x" : "\u001ba").repeat(length);
      const values: string[] = [];
      let traversed = 0;
      const iterate = String.prototype[Symbol.iterator];
      const indexOf = String.prototype.indexOf;
      const iterationDescriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator);
      const searchDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "indexOf");
      assert.ok(iterationDescriptor !== undefined && searchDescriptor !== undefined);
      Object.defineProperty(String.prototype, Symbol.iterator, { ...iterationDescriptor, value: function (this: string) {
        const iterator = iterate.call(this);
        const next = iterator.next.bind(iterator);
        iterator.next = () => {
          const result = next();
          if (!result.done) traversed += result.value.length;
          return result;
        };
        return iterator;
      } });
      Object.defineProperty(String.prototype, "indexOf", { ...searchDescriptor, value: function (this: string, value: string, position?: number) {
        // A missing paste opener requires examining the full requested suffix.
        if (value === "\u001b[200~") traversed += Math.max(0, this.length - (position ?? 0));
        return indexOf.call(this, value, position);
      } });
      try {
        if (framer === "standalone") {
          const input = new StdinBuffer();
          input.on("data", (value) => values.push(value));
          try { input.process(source); }
          finally { input.destroy(); }
        } else {
          values.push(...new TerminalInputBuffer().push(source).map((token) => token.value));
        }
      } finally {
        Object.defineProperty(String.prototype, Symbol.iterator, iterationDescriptor);
        Object.defineProperty(String.prototype, "indexOf", searchDescriptor);
      }
      assert.deepEqual(values, inputKind === "ordinary" ? Array.from(source) : Array.from({ length }, () => "\u001ba"));
      assert.ok(traversed <= source.length * 4, `${framer} traversed ${traversed} code units for ${source.length} input characters`);
    }
  });
}

test("ordinary input preserves standalone code points and product graphemes", () => {
  const source = "e\u0301👩‍💻🙂";
  const standalone = new StdinBuffer();
  const values: string[] = [];
  standalone.on("data", (value) => values.push(value));
  try { standalone.process(source); }
  finally { standalone.destroy(); }
  assert.deepEqual(values, ["e", "\u0301", "👩", "\u200d", "💻", "🙂"]);
  assert.deepEqual(new TerminalInputBuffer().push(source), [
    { type: "text", value: "e\u0301" },
    { type: "text", value: "👩‍💻" },
    { type: "text", value: "🙂" },
  ]);
});

test("ordinary text batches preserve grapheme, Alt, and control boundaries", () => {
  assert.deepEqual(new TerminalInputBuffer().push("ae\u0301👩‍💻\r\n\u001b[A\u0301x\u009b31my\u009dnotice\u009cz\u001be\u0301!\u001b👩‍💻\u001b[A"), [
    { type: "text", value: "a" },
    { type: "text", value: "e\u0301" },
    { type: "text", value: "👩‍💻" },
    { type: "text", value: "\r" },
    { type: "text", value: "\n" },
    { type: "sequence", value: "\u001b[A", complete: true },
    { type: "text", value: "\u0301" },
    { type: "text", value: "x" },
    { type: "sequence", value: "\u009b31m", complete: true },
    { type: "text", value: "y" },
    { type: "sequence", value: "\u009dnotice\u009c", complete: true },
    { type: "text", value: "z" },
    { type: "sequence", value: "\u001be\u0301", complete: true },
    { type: "text", value: "!" },
    { type: "sequence", value: "\u001b👩‍💻", complete: true },
    { type: "sequence", value: "\u001b[A", complete: true },
  ]);
});

test("Alt-prefixed controls retain ASCII and Unicode sequence framing", () => {
  assert.deepEqual(new TerminalInputBuffer().push("\u001b\r\nx"), [
    { type: "sequence", value: "\u001b\r", complete: true },
    { type: "text", value: "\n" },
    { type: "text", value: "x" },
  ]);
  assert.deepEqual(new TerminalInputBuffer().push("\u001b\r\n🙂"), [
    { type: "sequence", value: "\u001b\r\n", complete: true },
    { type: "text", value: "🙂" },
  ]);
});

test("terminal input buffer reassembles UTF-8, CSI, SS3, and terminal replies", () => {
  const input = new TerminalInputBuffer();
  const emoji = Buffer.from("🙂");
  assert.deepEqual(input.push(emoji.subarray(0, 2)), []);
  assert.deepEqual(input.push(emoji.subarray(2)), [{ type: "text", value: "🙂" }]);
  assert.deepEqual(input.push("\u001b[?"), []);
  assert.equal(input.pendingSequence, true);
  assert.deepEqual(input.push("7u\u001bO"), [{ type: "sequence", value: "\u001b[?7u", complete: true }]);
  assert.deepEqual(input.push("P"), [{ type: "sequence", value: "\u001bOP", complete: true }]);
});

test("terminal input buffer keeps OSC, DCS, APC, and PM controls atomic", () => {
  const input = new TerminalInputBuffer();
  assert.deepEqual(input.push("\u001b]11;rgb:00/00"), []);
  assert.deepEqual(input.push("/00\u0007x"), [
    { type: "sequence", value: "\u001b]11;rgb:00/00/00\u0007", complete: true },
    { type: "text", value: "x" },
  ]);
  assert.deepEqual(input.push("\u001bP1+r\u001b\\\u001b_payload\u001b\\\u001b^notice\u001b\\"), [
    { type: "sequence", value: "\u001bP1+r\u001b\\", complete: true },
    { type: "sequence", value: "\u001b_payload\u001b\\", complete: true },
    { type: "sequence", value: "\u001b^notice\u001b\\", complete: true },
  ]);
});

test("terminal input buffer isolates fragmented bracketed paste from controls", () => {
  const input = new TerminalInputBuffer();
  assert.deepEqual(input.push("\u001b[200~one\u001b]not-a-query"), []);
  assert.deepEqual(input.push("\n\u001b[20"), []);
  assert.deepEqual(input.push("1~after"), [
    { type: "paste", value: "one\u001b]not-a-query\n" },
    { type: "text", value: "a" },
    { type: "text", value: "f" },
    { type: "text", value: "t" },
    { type: "text", value: "e" },
    { type: "text", value: "r" },
  ]);
});

test("terminal input buffer times out incomplete controls without replaying them as text", () => {
  const input = new TerminalInputBuffer();
  input.push("\u001b[?12");
  assert.deepEqual(input.flushPending(), [{ type: "sequence", value: "\u001b[?12", complete: false }]);
  assert.deepEqual(input.push("a"), [{ type: "text", value: "a" }]);
  input.push("\u001b");
  assert.equal(input.pendingEscape, true);
  assert.deepEqual(input.flushPending(), [{ type: "sequence", value: "\u001b", complete: true }]);
});

test("terminal input buffer keeps adjacent Escape presses distinct", () => {
  const input = new TerminalInputBuffer();
  assert.deepEqual(input.push("\u001b\u001b"), [{ type: "sequence", value: "\u001b", complete: true }]);
  assert.equal(input.pendingEscape, true);
  assert.deepEqual(input.flushPending(), [{ type: "sequence", value: "\u001b", complete: true }]);
});

test("terminal input buffer bounds unterminated control strings and paste", () => {
  const control = new TerminalInputBuffer();
  assert.throws(() => control.push(`\u001b]${"x".repeat(4 * 1024 + 1)}`), /sequence is too large/u);

  const paste = new TerminalInputBuffer();
  assert.throws(() => paste.push(`\u001b[200~${"x".repeat(4 * 1024 * 1024 + 1)}`), /paste exceeds/u);
});
