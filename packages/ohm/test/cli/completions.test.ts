import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { parseArgs } from "../../src/cli/args.js";
import { renderShellCompletion } from "../../src/cli/completions.js";
import { renderCliHelp } from "../../src/cli/help.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";
import {
  AGENT_CLI_OPTIONS,
  CLI_COMPLETION_SHELLS,
  PLUGIN_AUTHOR_COMMANDS,
  MANAGEMENT_CLI_COMMANDS,
  MANAGEMENT_CLI_OPTIONS,
  type CliOptionMetadata,
  type ManagementCliCommandMetadata,
} from "../../src/cli/metadata.js";

const CLI_SOURCE = resolve("src/bin/ohm.ts");
const agentOptions: readonly CliOptionMetadata[] = AGENT_CLI_OPTIONS;
const managementOptions: readonly CliOptionMetadata[] = MANAGEMENT_CLI_OPTIONS;
const managementCommands: readonly ManagementCliCommandMetadata[] = MANAGEMENT_CLI_COMMANDS;
const ERROR_CODE_VALUE = Type.Object({ code: Type.Optional(Type.String()) }, { additionalProperties: true });

function cli(args: readonly string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_SOURCE, ...args], {
    cwd: resolve("."),
    env: { ...process.env, OHM_RECURSION_DEPTH: "0", ...overrides },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function assertBalancedQuotes(script: string): void {
  for (const [index, line] of script.split("\n").entries()) {
    let single = false;
    let double = false;
    let escaped = false;
    for (const character of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && !single) {
        escaped = true;
        continue;
      }
      if (character === "'" && !double) single = !single;
      else if (character === '"' && !single) double = !double;
    }
    assert.equal(single, false, `unclosed single quote on line ${index + 1}`);
    assert.equal(double, false, `unclosed double quote on line ${index + 1}`);
  }
}

function occurrences(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function optionValue(name: string, values: readonly string[] | undefined): string {
  if (values?.[0] !== undefined) return values[0];
  if (name === "max-steps" || name === "max-output-tokens" || name === "port") return "1";
  return "fixture";
}

test("completion metadata is the option and management parser authority", () => {
  for (const option of agentOptions) {
    for (const token of [option.long, ...(option.short === undefined ? [] : [option.short])]) {
      const parsed = parseArgs([
        token,
        ...(option.value === undefined ? [] : [optionValue(option.name, option.values)]),
      ]);
      assert.equal(parsed.unknownFlags.size, 0, token);
      assert.doesNotMatch(parsed.diagnostics.map((entry) => entry.message).join("\n"), /Unknown option/u, token);
    }
  }

  const options = new Map(managementOptions.map((option) => [option.name, option]));
  for (const command of managementCommands) {
    assert.equal(parseManagementArguments([command.name]).command, command.name);
    assert.doesNotThrow(() => renderCliHelp(command.name), command.name);
    for (const name of command.options) {
      const option = options.get(name);
      assert.notEqual(option, undefined, `${command.name}: ${name}`);
      const parsed = parseManagementArguments([
        command.name,
        option!.long,
        ...(option!.value === undefined ? [] : [optionValue(option!.name, option!.values)]),
      ]);
      assert.equal(parsed.flags.has(name), true, `${command.name}: ${option!.long}`);
    }
  }
});

test("generated scripts cover every static command, option, and fixed value without recursive evaluation", () => {
  for (const shell of CLI_COMPLETION_SHELLS) {
    const script = renderShellCompletion(shell);
    assert.equal(script.endsWith("\n"), true, shell);
    assert.doesNotMatch(script, /\r|\0/u, shell);
    assert.doesNotMatch(script, /\beval\b|\bohm\s+(?:completions|--list-models)\b/u, shell);
    assert.doesNotMatch(script, /\bextensions?\b/u, shell);
    assertBalancedQuotes(script);

    for (const command of managementCommands) {
      if (command.hidden) continue;
      assert.match(script, new RegExp(`(?:^|[^a-z0-9-])${command.name}(?:$|[^a-z0-9-])`, "mu"), `${shell}: ${command.name}`);
      for (const value of [...(command.subcommands ?? []), ...(command.argumentValues ?? [])]) {
        assert.equal(script.includes(value), true, `${shell}: ${command.name} ${value}`);
      }
    }
    for (const action of PLUGIN_AUTHOR_COMMANDS) assert.equal(script.includes(action), true, `${shell}: ${action}`);
    for (const option of [...agentOptions, ...managementOptions]) {
      if (option.hidden) continue;
      if (shell === "fish") {
        assert.equal(script.includes(`-l ${option.long.slice(2)}`), true, `${shell}: ${option.long}`);
        if (option.short !== undefined) {
          const kind = option.short.length === 2 ? "-s" : "-o";
          assert.equal(script.includes(`${kind} ${option.short.slice(1)}`), true, `${shell}: ${option.short}`);
        }
      } else {
        assert.equal(script.includes(option.long), true, `${shell}: ${option.long}`);
        if (option.short !== undefined) assert.equal(script.includes(option.short), true, `${shell}: ${option.short}`);
      }
      if (option.values !== undefined) {
        for (const value of option.values) assert.equal(script.includes(value), true, `${shell}: ${option.long} ${value}`);
      }
    }
  }
});

test("generated scripts satisfy deterministic syntax contracts", () => {
  const bash = renderShellCompletion("bash");
  const zsh = renderShellCompletion("zsh");
  const fish = renderShellCompletion("fish");

  assert.equal(occurrences(bash, /^\s*case\b/gmu), occurrences(bash, /^\s*esac\b/gmu));
  assert.equal(occurrences(bash, /^\s*if\b/gmu), occurrences(bash, /^\s*fi\b/gmu));
  assert.match(bash, /^_ohm\(\) \{[\s\S]*^\}$/mu);
  assert.match(bash, /^complete -o bashdefault -o default -F _ohm ohm$/mu);

  assert.match(zsh, /^#compdef ohm$/mu);
  assert.equal(occurrences(zsh, /^\s*case\b/gmu), occurrences(zsh, /^\s*esac\b/gmu));
  assert.equal(occurrences(zsh, /^\s*if\b/gmu), occurrences(zsh, /^\s*fi\b/gmu));
  assert.match(zsh, /^compdef _ohm ohm$/mu);

  for (const line of fish.split("\n").filter((line) => line !== "" && !line.startsWith("#"))) {
    assert.match(line, /^complete -c ohm(?: |$)/u);
  }

  for (const shell of CLI_COMPLETION_SHELLS) {
    assert.equal(renderShellCompletion(shell), renderShellCompletion(shell), `${shell} generation is deterministic`);
  }
});

test("bash accepts its generated script and suggests only canonical top-level names when available", () => {
  const parsed = spawnSync("bash", ["--noprofile", "--norc"], {
    input: [renderShellCompletion("bash"), 'COMP_WORDS=(ohm "")', "COMP_CWORD=1", "_ohm", 'printf "%s\\n" "${COMPREPLY[@]}"'].join("\n"),
    encoding: "utf8",
  });
  if (parsed.error !== undefined && Value.Check(ERROR_CODE_VALUE, parsed.error) && parsed.error.code === "ENOENT") return;
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.status, 0, parsed.stderr);
  const suggestions = parsed.stdout.trim().split("\n");
  for (const name of ["plugins", "--plugin", "--no-plugins", "--no-plugin-code"]) assert.ok(suggestions.includes(name), name);
  for (const name of ["extensions", "install", "remove", "update", "list", "--extension", "--no-extensions", "-e", "-ne"]) {
    assert.equal(suggestions.includes(name), false, name);
  }
});

test("the CLI writes only the requested script and rejects missing, extra, or unsupported shells", () => {
  const root = mkdtempSync(join(tmpdir(), "ohm-completions-"));
  const agentDirectory = join(root, "state-must-not-be-created");
  try {
    for (const shell of CLI_COMPLETION_SHELLS) {
      const result = cli(["completions", shell], { OHM_HOME: agentDirectory });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, renderShellCompletion(shell));
      assert.equal(result.stderr, "");
      assert.equal(existsSync(agentDirectory), false);
    }

    const help = cli(["completions", "--help"], { OHM_HOME: agentDirectory });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /source <\(ohm completions bash\)/u);
    assert.match(help.stdout, /ohm completions fish \| source/u);
    assert.equal(help.stderr, "");
    assert.equal(existsSync(agentDirectory), false);

    for (const args of [
      ["completions"],
      ["completions", "bash", "extra"],
      ["completions", "powershell"],
    ]) {
      const result = cli(args, { OHM_HOME: agentDirectory });
      assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /bash, zsh, (?:or )?fish/u);
      assert.equal(existsSync(agentDirectory), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
