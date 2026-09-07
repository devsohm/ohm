import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  allToolNames,
  createAllToolDefinitions,
  createCodingToolDefinitions,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadOnlyToolDefinitions,
  createReadToolDefinition,
  createWriteToolDefinition,
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ShellTool,
  WriteTool,
} from "../../src/tools/index.js";

test("public tool collections expose the stable tools in their target groups", () => {
  assert.deepEqual([...allToolNames], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(createCodingToolDefinitions(process.cwd()).map((tool) => tool.name), ["read", "bash", "edit", "write"]);
  assert.deepEqual(createReadOnlyToolDefinitions(process.cwd()).map((tool) => tool.name), ["read", "grep", "find", "ls"]);
  assert.deepEqual(Object.keys(createAllToolDefinitions(process.cwd())), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("built-in provider schemas match standalone parameters including descriptions", async (t) => {
  const definitions = createAllToolDefinitions(process.cwd());
  const tools = [new ReadTool(), new ShellTool("bash"), new EditTool(), new WriteTool(), new GrepTool(), new FindTool(), new LsTool()];
  for (const [name, definition] of Object.entries(definitions)) {
    await t.test(name, () => {
      const tool = tools.find((candidate) => candidate.definition.name === name);
      assert.ok(tool);
      assert.deepEqual(structuredClone(tool.definition.inputSchema), structuredClone(definition.parameters));
    });
  }
});

test("read, write, and edit factories honor injected operations", async () => {
  const cwd = resolve("/virtual/workspace");
  const read = createReadToolDefinition(cwd, {
    operations: {
      async access() {},
      async readFile() { return Buffer.from("one\ntwo", "utf8"); },
    },
  });
  const readResult = await read.execute("read-1", { path: "notes.txt", offset: 2 });
  assert.equal(readResult.content[0]?.type === "text" ? readResult.content[0].text : undefined, "two");

  const writes: Array<{ path: string; content: string }> = [];
  const directories: string[] = [];
  const write = createWriteToolDefinition(cwd, {
    operations: {
      async mkdir(path) { directories.push(path); },
      async writeFile(path, content) { writes.push({ path, content }); },
    },
  });
  await write.execute("write-1", { path: "new/file.txt", content: "hello" });
  assert.deepEqual(directories, [join(cwd, "new")]);
  assert.deepEqual(writes, [{ path: join(cwd, "new", "file.txt"), content: "hello" }]);

  let edited = "alpha\nbeta\n";
  const edit = createEditToolDefinition(cwd, {
    operations: {
      async access() {},
      async readFile() { return Buffer.from(edited, "utf8"); },
      async writeFile(_path, content) { edited = content; },
    },
  });
  assert.equal(edit.renderShell, undefined, "built-in edits retain the host tool timeline and status marker");
  const editResult = await edit.execute(
    "edit-1",
    { path: "file.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
    undefined,
    undefined,
  );
  assert.equal(edited, "alpha\ngamma\n");
  assert.equal(editResult.details?.firstChangedLine, 2);
});

test("find and ls factories honor injected discovery operations", async () => {
  const cwd = resolve("/virtual/workspace");
  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: () => true,
      glob: () => [join(cwd, "src", "a.ts"), join(cwd, "src", "b.ts")],
    },
  });
  const found = await find.execute("find-1", { pattern: "**/*.ts" });
  assert.equal(found.content[0]?.type === "text" ? found.content[0].text : undefined, "src/a.ts\nsrc/b.ts");

  const ls = createLsToolDefinition(cwd, {
    operations: {
      exists: () => true,
      stat: (path) => ({ isDirectory: () => path === join(cwd, "folder") || path === cwd }),
      readdir: () => ["z.txt", "folder", "a.txt"],
    },
  });
  const listed = await ls.execute("ls-1", {});
  assert.equal(listed.content[0]?.type === "text" ? listed.content[0].text : undefined, "a.txt\nfolder/\nz.txt");
});

test("find and ls default counts can be increased without changing their defaults", async () => {
  const cwd = resolve("/virtual/workspace");
  const paths = Array.from({ length: 1001 }, (_value, index) => join(cwd, `file-${index}.ts`));
  const findLimits: number[] = [];
  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: () => true,
      glob(_pattern, _cwd, options) { findLimits.push(options.limit); return paths; },
    },
  });
  const defaultFind = await find.execute("find-default", { pattern: "*.ts" });
  const expandedFind = await find.execute("find-expanded", { pattern: "*.ts", limit: 1002 });
  assert.deepEqual(findLimits, [1000, 1002]);
  assert.equal(defaultFind.details?.resultLimitReached, 1000);
  assert.equal(expandedFind.details?.resultLimitReached, undefined);
  assert.ok(expandedFind.content.some((block) => block.type === "text" && block.text.includes("file-1000.ts")));

  const ls = createLsToolDefinition(cwd, {
    operations: {
      exists: () => true,
      stat: (path) => ({ isDirectory: () => path === cwd }),
      readdir: () => Array.from({ length: 501 }, (_value, index) => `file-${index}.txt`),
    },
  });
  const defaultLs = await ls.execute("ls-default", {});
  const expandedLs = await ls.execute("ls-expanded", { limit: 502 });
  assert.equal(defaultLs.details?.entryLimitReached, 500);
  assert.equal(expandedLs.details?.entryLimitReached, undefined);
  const block = expandedLs.content[0];
  assert.ok(block?.type === "text");
  assert.equal(block.text.split("\n").length, 501);
});

test("default factory definitions execute against their captured cwd", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-tool-factory-"));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "captured.txt"), "captured cwd", "utf8");
  const read = createReadToolDefinition(cwd);
  const result = await read.execute("read-cwd", { path: "captured.txt" });
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "captured cwd");
});
