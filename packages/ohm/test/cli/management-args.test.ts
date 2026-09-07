import assert from "node:assert/strict";
import test from "node:test";

import {
  findLeadingManagementCommand,
  parseManagementArguments,
} from "../../src/cli/management-args.js";

test("management command discovery respects option values and the literal boundary", () => {
  assert.equal(findLeadingManagementCommand(["--offline", "config", "--", "path"]), "config");
  assert.equal(findLeadingManagementCommand(["--workspace", "/tmp/work", "serve"]), "serve");
  assert.equal(findLeadingManagementCommand(["--offline", "--", "config", "path"]), undefined);
  assert.equal(findLeadingManagementCommand(["--model", "config", "prompt"]), undefined);
  assert.equal(findLeadingManagementCommand(["--print=config"]), undefined);
});

test("management commands accept only their documented flags", () => {
  const sessions = parseManagementArguments([
    "sessions", "doctor", "--json", "--all", "--workspace", "/tmp/work", "--session-dir", "/tmp/sessions",
  ]);
  assert.equal(sessions.command, "sessions");
  assert.equal(sessions.flags.get("workspace"), "/tmp/work");

  const serve = parseManagementArguments([
    "serve", "--host", "127.0.0.1", "--port", "4317", "--workspace", "/tmp/work",
    "--session-dir", "/tmp/sessions", "--offline", "--no-plugin-code",
  ]);
  assert.equal(serve.command, "serve");
  assert.equal(serve.flags.get("port"), "4317");

  const stats = parseManagementArguments(["stats", "--json"]);
  assert.equal(stats.command, "stats");
  assert.equal(stats.flags.get("json"), true);

  assert.throws(
    () => parseManagementArguments(["sessions", "doctor", "--scope", "project"]),
    /--scope is not valid for sessions/u,
  );
  assert.throws(
    () => parseManagementArguments(["sessions", "doctor", "--model", "gpt"]),
    /Unknown flag --model/u,
  );
  assert.throws(
    () => parseManagementArguments(["self-update", "--yes"]),
    /--yes is not valid for self-update/u,
  );
  assert.throws(
    () => parseManagementArguments(["serve", "--json"]),
    /--json is not valid for serve/u,
  );
  assert.throws(
    () => parseManagementArguments(["stats", "--workspace", "/tmp/work"]),
    /--workspace is not valid for stats/u,
  );
});

test("management value flags do not consume a following option", () => {
  for (const [flag, argv] of [
    ["--workspace", ["sessions", "doctor", "--workspace", "--json"]],
    ["--scope", ["install", "package", "--scope", "-l"]],
    ["--plugin", ["plugins", "--plugin"]],
    ["--plugin", ["plugins", "--plugin", "--json"]],
  ] as const) {
    assert.throws(() => parseManagementArguments([...argv]), { message: `${flag} requires a value` });
  }
});

test("plugins commands share author and package dispatch without losing source arguments", () => {
  for (const action of ["init", "test", "preview", "verify", "validate", "inspect", "pack", "smoke", "refresh", "report", "index"]) {
    const source = ["plugins", action, "./selected", "--json"];
    const parsed = parseManagementArguments(source);
    assert.equal(parsed.command, "plugins");
    assert.deepEqual(parsed.positionals, ["author", action, "./selected"]);
    assert.deepEqual(parsed.source, source);
  }
  assert.equal(findLeadingManagementCommand(["--plugin", "./selected", "plugins", "doctor"]), "plugins");
  assert.equal(findLeadingManagementCommand(["extensions", "doctor"]), undefined);
  assert.deepEqual(parseManagementArguments(["plugins"]).positionals, ["packages"]);
  assert.deepEqual(parseManagementArguments(["plugins", "list"]).positionals, ["packages"]);
  assert.deepEqual(parseManagementArguments(["plugins", "resources"]).positionals, ["list"]);
  assert.deepEqual(parseManagementArguments(["plugins", "install", "./selected"]).positionals, ["install", "./selected"]);
  const canonical = parseManagementArguments(["plugins", "doctor", "--plugin", "one", "--plugin=two", "--no-plugins"]);
  assert.deepEqual(canonical.flags.get("plugin"), ["one", "two"]);
  assert.equal(canonical.flags.get("no-plugins"), true);
  for (const retired of ["--extension", "--no-extensions", "-e", "-ne"]) {
    assert.throws(() => parseManagementArguments(["plugins", retired]), /Unknown flag/u);
  }
});
