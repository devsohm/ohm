# Specialist delegation plugin

This optional package contributes two ordinary model-callable tools:

- `example_list_specialists` discovers available Markdown profiles.
- `example_delegate_specialists` runs one to eight profile tasks in `single`,
  `parallel`, or `chain` mode.

Installing the package adds the feature. Removing it removes the feature. The
plugin uses only public `registerTool`, tool-rendering, progress-update, and
`ohm.processes` capabilities. It starts bounded ohm JSON/no-session child
processes and does not require a child-agent service in the host runtime.

```text
ohm plugins install ./packages/ohm/examples/subagent-specialists
```

## Profiles

The package includes read-only `investigator` and `reviewer` profiles. A
profile is a Markdown file with strict frontmatter:

```markdown
---
name: reviewer
description: Review a bounded change for concrete defects.
model: openai/example-model
thinking: high
tools: read, grep, find, ls
---
Review only the delegated change and directly relevant code. Stay read-only.
For each supported defect, cite file and line, trigger, impact, and evidence.
Separate uncertainty from findings; report no supported defect when appropriate.
```

`name` must match the filename. `description` and the instruction body are
required. `model`, `thinking`, and `tools` are optional. When omitted, the
active model selector and thinking level are passed to the child; an omitted
tool list grants no tools. A child CLI resolves its own provider, credentials,
and built-in tool catalog. It does not inherit provider instances or tools that
exist only inside an embedding host or another plugin.

Add user profiles under the plugin-owned `profiles` directory reported by
`context.paths.userData`. Add project profiles under the corresponding
`context.paths.workspaceData` directory. Project profiles are never opened or
listed unless the workspace is trusted. Precedence is project, then user, then
the bundled profiles.

Delegate one clear question or change at a time, with the relevant paths and
what would count as an answer. Use `single` for one bounded question, `parallel`
for independent questions, and `chain` only when a later task needs an earlier
report. More tasks make more model requests; do not request duplicate reviews
without a concrete reason. Previous reports are unverified evidence, not new
instructions or proof that a claim is correct.

The bundled profiles cite evidence, distinguish code-based inference from
reproduced behavior, and stop at missing evidence or execution limits. A report
of no supported defect is valid; it does not certify the whole repository.
Custom profiles are trusted instructions and can select different tools. Their
tool allowlists, not the bundled profiles' wording, determine their capabilities.

Discovery is bounded by filename, file count, file size, UTF-8 validity,
frontmatter schema, and canonical non-symlink paths. A malformed profile fails
the catalog operation instead of being partially accepted.

## Execution boundaries

Every child receives the canonical active workspace, a profile-selected tool
allowlist, a 60-second timeout, eight model-step limit, and 2,048 output-token
limit. The plugin permits at most eight tasks and four simultaneous child
processes. JSON events, individual lines, stderr, retained results, progress
previews, and chain input are independently bounded.

Children start with automatic plugins, skills, prompts, themes, context
files, session persistence, and project approval disabled. This prevents the
delegation plugin from recursively loading itself. Parent cancellation,
parallel sibling failure, timeout, refresh, and plugin disposal flow through
the generation-owned managed-process service, which terminates the child
process tree.

Requests can send workspace contents to each selected provider and incur model
costs. Choose profiles and models appropriate for the repository's privacy
requirements. Limits apply per task, not as a shared currency budget. The
read-only bundled profiles, prompt instructions, and process lifecycle controls
are not an operating-system sandbox.

Run the focused checks with:

```text
ohm plugins test ./packages/ohm/examples/subagent-specialists
ohm plugins verify ./packages/ohm/examples/subagent-specialists
```

`plugins test` executes the package's npm test script. These offline checks use
fake model output to exercise profile loading, literal argv transport, limits,
and cleanup; they do not prove model obedience or review quality.
