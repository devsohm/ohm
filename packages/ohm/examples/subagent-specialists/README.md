# Specialist delegation extension

This optional package contributes two ordinary model-callable tools:

- `example_list_specialists` discovers available Markdown profiles.
- `example_delegate_specialists` runs one to eight profile tasks in `single`,
  `parallel`, or `chain` mode.

Installing the package adds the feature. Removing it removes the feature. The
extension uses only public `registerTool`, tool-rendering, progress-update, and
`ohm.processes` capabilities. It starts bounded ohm JSON/no-session child
processes and does not require a child-agent service in the host runtime.

```text
ohm install ./packages/ohm/examples/subagent-specialists
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
Review the delegated task and cite evidence for every finding.
```

`name` must match the filename. `description` and the instruction body are
required. `model`, `thinking`, and `tools` are optional. When omitted, the
active model selector and thinking level are passed to the child; an omitted
tool list grants no tools. A child CLI resolves its own provider, credentials,
and built-in tool catalog. It does not inherit provider instances or tools that
exist only inside an embedding host or another extension.

Add user profiles under the extension-owned `profiles` directory reported by
`context.paths.userData`. Add project profiles under the corresponding
`context.paths.workspaceData` directory. Project profiles are never opened or
listed unless the workspace is trusted. Precedence is project, then user, then
the bundled profiles.

Discovery is bounded by filename, file count, file size, UTF-8 validity,
frontmatter schema, and canonical non-symlink paths. A malformed profile fails
the catalog operation instead of being partially accepted.

## Execution boundaries

Every child receives the canonical active workspace, a profile-selected tool
allowlist, a 60-second timeout, eight model-step limit, and 2,048 output-token
limit. The extension permits at most eight tasks and four simultaneous child
processes. JSON events, individual lines, stderr, retained results, progress
previews, and chain input are independently bounded.

Children start with automatic extensions, skills, prompts, themes, context
files, session persistence, and project approval disabled. This prevents the
delegation extension from recursively loading itself. Parent cancellation,
parallel sibling failure, timeout, refresh, and extension disposal flow through
the generation-owned managed-process service, which terminates the child
process tree.

Run the focused checks with:

```text
npm test --prefix packages/ohm/examples/subagent-specialists
```
