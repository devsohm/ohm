import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const managerModule = new URL("../../src/storage/session-manager.ts", import.meta.url).href;

for (const replace of [false, true]) {
  test(`failed SQLite creation cleans only its owned inode under its lease (replacement=${replace})`, (t) => {
    if (process.platform === "win32") return t.skip("creation fault is injected through POSIX chmod");
    const root = mkdtempSync(join(tmpdir(), "ohm-create-cleanup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      const root = process.argv[1];
      process.env.OHM_HOME = join(root, "home");
      const path = join(root, "sessions", "candidate.sqlite");
      const originalChmod = fs.chmodSync;
      const originalUnlink = fs.unlinkSync;
      const deletedWithLease = [];
      fs.chmodSync = (selected, mode) => {
        if (selected !== path) return originalChmod(selected, mode);
        if (${replace}) {
          fs.renameSync(path, path + ".displaced");
          fs.writeFileSync(path, "replacement must survive");
        }
        throw Object.assign(new Error("injected creation failure"), { code: "EIO" });
      };
      fs.unlinkSync = (selected) => {
        if (selected === path) deletedWithLease.push(fs.existsSync(path + ".writer-lock"));
        return originalUnlink(selected);
      };
      syncBuiltinESMExports();
      const { SessionManager } = await import(${JSON.stringify(managerModule)});
      assert.throws(() => SessionManager.create(root, join(root, "sessions"), { id: "candidate" }), /injected creation failure/);
      if (${replace}) {
        assert.equal(fs.existsSync(path), true, "cleanup deleted the replacement file");
        assert.equal(fs.readFileSync(path, "utf8"), "replacement must survive");
        assert.deepEqual(deletedWithLease, []);
      } else {
        assert.deepEqual(deletedWithLease, [true], "cleanup released the lease before deleting its candidate");
        assert.equal(fs.existsSync(path), false);
      }
      assert.equal(fs.existsSync(path + ".writer-lock"), false);
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, root]);
  });
}

test("candidate cleanup rechecks the captured inode after acquiring writer ownership", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ohm-candidate-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = process.argv[1];
    process.env.OHM_HOME = join(root, "home");
    const { SessionManager } = await import(${JSON.stringify(managerModule)});
    const candidate = SessionManager.create(root, join(root, "sessions"), { id: "candidate" });
    const path = candidate.getSessionFile();
    const cleanup = candidate.captureCreatedSessionCleanup();
    candidate.closeV4Store();
    const other = SessionManager.create(root, join(root, "sessions"), { id: "other" });
    const otherPath = other.getSessionFile();
    other.closeV4Store();
    const bytes = fs.readFileSync(otherPath);
    const originalStat = fs.statSync;
    let replaced = false;
    fs.statSync = (selected, options) => {
      const result = originalStat(selected, options);
      if (selected === path && !replaced) {
        replaced = true;
        fs.renameSync(path, path + ".displaced");
        fs.renameSync(otherPath, path);
      }
      return result;
    };
    syncBuiltinESMExports();
    cleanup();
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(path), true, "cleanup deleted a file that replaced its candidate");
    assert.deepEqual(fs.readFileSync(path), bytes);
    assert.equal(fs.existsSync(path + ".writer-lock"), false);
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, root]);
});

test("candidate cleanup preserves independently created SQLite sidecars", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ohm-candidate-sidecars-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = process.argv[1];
    process.env.OHM_HOME = join(root, "home");
    const { SessionManager } = await import(${JSON.stringify(managerModule)});
    const candidate = SessionManager.create(root, join(root, "sessions"), { id: "candidate" });
    const path = candidate.getSessionFile();
    const cleanup = candidate.captureCreatedSessionCleanup();
    candidate.closeV4Store();
    const originalUnlink = fs.unlinkSync;
    let injected = false;
    fs.unlinkSync = (selected) => {
      if (selected === path) {
        for (const suffix of ["-wal", "-shm"]) {
          if (fs.existsSync(path + suffix)) fs.renameSync(path + suffix, path + suffix + ".displaced");
          fs.writeFileSync(path + suffix, "independent sidecar" + suffix, { flag: "wx" });
        }
        injected = true;
      }
      return originalUnlink(selected);
    };
    syncBuiltinESMExports();
    cleanup();
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path), false);
    assert.equal(fs.existsSync(path + ".writer-lock"), false);
    for (const suffix of ["-wal", "-shm"]) {
      assert.equal(fs.readFileSync(path + suffix, "utf8"), "independent sidecar" + suffix);
    }
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, root]);
});
