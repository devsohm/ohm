import { terminalPattern } from "../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  ohmCompactSignature,
  ohmTerminalLockup,
} from "../../src/tui/brand.js";

test("ohm terminal identity stays compact without a decorative logo", () => {
  assert.equal(ohmCompactSignature("1.2.3"), "ohm 1.2.3 · ready");
  assert.equal(ohmCompactSignature("1.2.3", false), "ohm 1.2.3 - ready");
  assert.equal(ohmTerminalLockup("1.2.3"), "ohm 1.2.3 · ready\nprogrammable agent harness");
  assert.doesNotMatch(ohmTerminalLockup("1.2.3", false), terminalPattern("[^\\x00-\\x7f]", "u"));
  assert.match(ohmTerminalLockup("1.2.3", false), /programmable agent harness/u);
});
