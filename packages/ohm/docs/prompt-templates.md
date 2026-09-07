# Prompt templates

A prompt template is a Markdown file exposed as a slash command. Invoking it
substitutes your arguments and sends the resulting text as the task. It does
not register a tool or execute a script.

## Choose the contribution type

| Use | When you need it | Small example |
| --- | --- | --- |
| Prompt template | Repeated task wording with arguments | `/review-area src/storage` expands a review request |
| [Skill](skills.md) | On-demand instructions, possibly with supporting files | `release-check/SKILL.md` and a checklist, invoked with `/skill:release-check` |
| [Runtime plugin](../examples/starter/README.md) | Executable commands, tools, hooks, or UI | `/example-hello Ada` displays a notification through a registered callback |

Templates and skills are instructions for the model; a runtime plugin is
trusted JavaScript or TypeScript code. A package can contain any combination.
You do not need plugin code just to distribute Markdown prompts.

## Make one prompt

In your workspace, create `.ohm/prompts/review-area.md` with this content:

```md
---
description: Review one area without changing files
argument-hint: AREA [FOCUS]
---
Review $1. Focus on ${2:-correctness}. Read files before reporting findings.
If no area was supplied, ask which area to review before proceeding.
Do not edit files. Report concrete issues with file locations and evidence;
if none are found, say so and note what you did not verify.
```

Start ohm from that workspace and approve project resources only if you trust
them. If ohm is already running, use `/refresh` after saving the file. Invoke:

```text
/review-area src/storage durability
```

The task starts with `Review src/storage. Focus on durability.`. Omitting the
second argument selects `correctness`. To keep a path containing spaces in
one argument, use `/review-area "src/session storage"`.

The filename supplies the command name; `description` and `argument-hint` are
optional completion hints, not argument validation. If an argument is
essential, say what to do when it is absent in the template itself.

## Arguments

Arguments split on whitespace, including newlines. Single or double quotes
group text containing spaces; their surrounding quotes are removed. Empty
quoted arguments (`""` or `''`) are skipped, so they cannot reserve a position.

| Form | Meaning |
| --- | --- |
| `$1`, `$2` | One-indexed positional argument |
| `$ARGUMENTS` or `$@` | All arguments joined with spaces |
| `${2:-fallback}` | Positional argument, or fallback text if missing or empty |
| `${ARGUMENTS:-fallback}` | All arguments or fallback text |
| `${@:2}` | Arguments from position two onward |
| `${@:2:3}` | Up to three arguments starting at position two |
| `{{promptDir}}` | Resolved directory containing the template, inserted at load time |

Missing positions without a default become empty text. All-argument and slice
forms join the parsed arguments with single spaces; they do not preserve the
original quote delimiters or whitespace between arguments.

Argument substitution runs once: with `$1` set to the literal text `$2`,
inserting `$1` does not expand `$2` again. Defaults are also literal:
`${3:-$1}` inserts `$1`, not the first argument, when position three is absent.

This is not shell parsing. `$HOME` and `$(command)` remain text, and a
backslash does not escape a substitution such as `$1`. To include literal
double quotes in an argument, group it with single quotes, or vice versa;
do not rely on shell-style backslash escaping.

## Load and inspect templates

Automatic locations are the `prompts` folder under the agent data directory
and `WORKSPACE/.ohm/prompts`. Project templates require workspace trust.
Directory discovery reads top-level `.md` files, not nested folders.

To load a file or directory for one invocation without installing a package:

```sh
ohm --prompt-template ./prompts
```

`--prompt-template` is repeatable. `--no-prompt-templates` disables automatic
discovery; explicitly supplied `--prompt-template` paths remain selected.
Run inspection commands from the same workspace as your session:

```sh
ohm plugins prompts
ohm plugins doctor
```

In an active session, `/resources` shows the loaded resource catalog. The
loader keeps the first same-name template in its resolved source order and
reports collisions. Use specific names and inspect the winning source instead
of relying on a duplicate to override another package.

A native package declares fixed prompt paths in `package.json`:

```json
{
  "name": "my-task-prompts",
  "version": "0.0.0",
  "private": true,
  "ohm": { "prompts": ["prompts"] }
}
```

Put the Markdown files in that package's `prompts/` directory. Runtime plugins
can instead return package-relative `promptPaths` from `resources_discover`
when paths genuinely need to be selected dynamically.

The optional [task-prompts package](../examples/task-prompts/README.md) contains
`review-change`, `diagnose-issue`, and `implement-change` templates. They
separate read-only review, diagnosis, and explicitly requested implementation;
they are examples to select, not additional default instructions.

The runtime reads at most 1 MiB per template. Programmatic loaders can set
`maxFileBytes` from 1 byte through 16 MiB. Oversized templates are skipped with
a resource diagnostic.

## Trust and authority

Treat project templates as untrusted instructions until the workspace is
approved. A template does not grant tools, permissions, network access, or
permission to perform unrelated changes. Its expanded text can still ask the
model to use available tools, so review the instructions before invoking it.
