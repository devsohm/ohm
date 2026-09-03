import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getOsc8LinkAtColumn,
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilities,
  setCapabilityOverrides,
  stripTerminalSequences,
} from "../dist/index.js";

describe("public terminal helpers", () => {
  it("removes terminal control sequences without changing visible text", () => {
    const value = "\x1b[31mred\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
    assert.equal(stripTerminalSequences(value), "red link");
    assert.equal(stripTerminalSequences("plain"), "plain");
    assert.equal(stripTerminalSequences("a\x07b\x9b31mc"), "abc");
    assert.equal(stripTerminalSequences("lone\x1b"), "lone");
    assert.equal(stripTerminalSequences("csi\x1b[31"), "csi");
    assert.equal(stripTerminalSequences("osc\x1b]0;unfinished"), "osc");
    assert.equal(
      stripTerminalSequences("a\0b\bc\r\nd\re\tf\ng\x07h\x7fi"),
      "abc\nd\ne\tf\nghi",
    );
    assert.equal(
      stripTerminalSequences("before\u009d8;;https://example.com\u009clink\u009d8;;\x07after"),
      "beforelinkafter",
    );
  });

  it("finds the hyperlink covering a terminal cell", () => {
    const value = "a\x1b]8;id=docs;https://example.com/docs\x07界x\x1b]8;;\x07z";
    assert.equal(getOsc8LinkAtColumn(value, 0), undefined);
    assert.equal(getOsc8LinkAtColumn(value, 1), "https://example.com/docs");
    assert.equal(getOsc8LinkAtColumn(value, 2), "https://example.com/docs");
    assert.equal(getOsc8LinkAtColumn(value, 3), "https://example.com/docs");
    assert.equal(getOsc8LinkAtColumn(value, 4), undefined);
    assert.equal(getOsc8LinkAtColumn(value, -1), undefined);
    assert.equal(getOsc8LinkAtColumn("unfinished\x1b", 10), undefined);

    const malformed = "\x1b]8;;https://example.com\x07a\x1b]8;missing-separator\x07b";
    assert.equal(getOsc8LinkAtColumn(malformed, 0), "https://example.com");
    assert.equal(getOsc8LinkAtColumn(malformed, 1), undefined);

    const c1 = "a\u009d8;id=docs;https://example.com/c1\u009c界\u009d8;;\u009cz";
    assert.equal(getOsc8LinkAtColumn(c1, 0), undefined);
    assert.equal(getOsc8LinkAtColumn(c1, 1), "https://example.com/c1");
    assert.equal(getOsc8LinkAtColumn(c1, 2), "https://example.com/c1");
    assert.equal(getOsc8LinkAtColumn(c1, 3), undefined);

    const malformedC1 = "\u009d8;;https://example.com\u009cA\u009d8;broken\u009cB";
    assert.equal(getOsc8LinkAtColumn(malformedC1, 0), "https://example.com");
    assert.equal(getOsc8LinkAtColumn(malformedC1, 1), undefined);
  });

  it("keeps explicit capability overrides separate from one-shot cached values", () => {
    try {
      setCapabilities({ images: null, trueColor: false, hyperlinks: false });
      setCapabilityOverrides({ images: "kitty" });
      assert.equal(getCapabilities().images, "kitty");

      setCapabilities({ images: "iterm2", trueColor: false, hyperlinks: false });
      assert.equal(getCapabilities().images, "iterm2");
      resetCapabilitiesCache();
      assert.equal(getCapabilities().images, "kitty");
    } finally {
      setCapabilityOverrides({});
      resetCapabilitiesCache();
    }
  });
});
