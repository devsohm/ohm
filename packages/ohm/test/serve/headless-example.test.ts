import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("the public headless HTTP example proves offline client recovery and actions", () => {
  const example = pathToFileURL(resolve("examples/serve-headless.mjs")).href;
  const guard = pathToFileURL(resolve("benchmarks/offline-network-guard.mjs")).href;
  const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "--eval",
    `const { runServeClientProof } = await import(${JSON.stringify(example)}); console.log(JSON.stringify(await runServeClientProof()));`,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    discoveredServices: 1,
    actionAccepted: true,
    cancelled: true,
    retainedReplay: true,
    replayGapRecovered: true,
    staleStreamRejected: true,
    committedHistoryPreserved: true,
  });
});
