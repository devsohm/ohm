import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { enableNativeInput, modifierPressed } from "../dist/native-modifiers.js";

describe("native terminal helper loading", () => {
  it("does not attempt to load platform helpers on unsupported operating systems", () => {
    let loads = 0;
    const loadNativeModule = () => {
      loads += 1;
      throw new Error("must not load");
    };

    assert.equal(enableNativeInput({ platform: "linux", loadNativeModule }), false);
    assert.equal(modifierPressed("shift", { platform: "win32", loadNativeModule }), false);
    assert.equal(loads, 0);
  });

  it("finds the Darwin modifier helper across package layouts and fails closed", () => {
    const candidates = [];
    const selected = modifierPressed("shift", {
      platform: "darwin",
      architecture: "arm64",
      executablePath: "/opt/ohm/node",
      moduleUrl: import.meta.url,
      loadNativeModule(path) {
        candidates.push(path);
        if (candidates.length === 1) throw new Error("not in this layout");
        if (candidates.length === 2) return {};
        return { modifierPressed: (name) => name === "shift" };
      },
    });

    assert.equal(selected, true);
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every((path) => path.endsWith(join("darwin-arm64", "darwin-modifiers.node"))));
    assert.equal(modifierPressed("shift", {
      platform: "darwin",
      loadNativeModule() { throw new Error("unavailable"); },
    }), false);
  });
});
