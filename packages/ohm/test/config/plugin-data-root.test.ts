import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePluginDataRoot } from "../../src/config/plugin-data-root.js";

for (const present of [[], ["extension-data"], ["state/extension-data"], ["extension-data", "state/extension-data"]]) {
  test(`product plugin data root preserves ${present.join(" and ") || "a fresh installation"}`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "ohm-plugin-data-root-"));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    for (const directory of present) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "retained.txt"), directory);
    }
    const before = await readdir(root, { recursive: true });

    if (present.length === 2) {
      assert.throws(() => resolvePluginDataRoot(root), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(join(root, "extension-data")));
        assert.ok(error.message.includes(join(root, "state", "extension-data")));
        assert.match(error.message, /back up both directories/u);
        return true;
      });
    } else {
      assert.equal(resolvePluginDataRoot(root), join(root, present[0] ?? "extension-data"));
    }

    assert.deepEqual(await readdir(root, { recursive: true }), before, "selection must not create or move state");
    for (const directory of present) {
      assert.equal(await readFile(join(root, directory, "retained.txt"), "utf8"), directory);
    }
  });
}

for (const invalid of ["extension-data", "state", "state/extension-data"]) {
  test(`product plugin data root rejects a non-directory at ${invalid}`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "ohm-plugin-data-invalid-"));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    if (invalid.startsWith("state/")) await mkdir(join(root, "state"));
    await writeFile(join(root, invalid), "retained");
    assert.throws(() => resolvePluginDataRoot(root), /canonical|ENOTDIR/u);
    assert.equal(await readFile(join(root, invalid), "utf8"), "retained");
  });
}

test("product plugin data root rejects a linked legacy root without choosing the preferred root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-plugin-data-link-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const outside = join(root, "outside");
  await mkdir(join(agentDir, "extension-data"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "retained.txt"), "outside");
  await symlink(outside, join(agentDir, "state"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolvePluginDataRoot(agentDir), /canonical/u);
  assert.deepEqual(await readdir(outside), ["retained.txt"]);
  assert.equal(await readFile(join(outside, "retained.txt"), "utf8"), "outside");
});
