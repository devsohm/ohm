# Getting started

This guide takes a new installation from an empty terminal to a useful, resumable coding session. For a complete topic list, see the [documentation map](README.md).

## What ohm does

ohm connects a model to a small set of tools running on your computer:

1. You enter a task in the terminal interface or as a one-shot command.
2. ohm sends the conversation and tool definitions to the selected provider.
3. The model may request file reads, shell commands, or edits.
4. ohm executes those requests locally, returns bounded results to the model, and renders the work as it happens.
5. ohm saves the session locally so you can continue, branch, compact, or export it later.

The default tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. The same default applies to
interactive, print, JSON, RPC, serve, and direct SDK sessions. These tools run with the permissions of the user who launched
ohm. Project trust controls whether project-local configuration and executable extensions load. It does not approve
individual shell commands or create a sandbox.

Model requests leave your machine when you choose a hosted provider. Use a local provider such as Ollama when the model must also run locally.

## 1. Install ohm

Use the one-line installer for your platform. It includes the supported Node.js runtime, so the installation machine
does not need Node.js or npm.

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/devsohm/ohm/v0.1.1/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/devsohm/ohm/v0.1.1/install.ps1 | iex
```

The installer downloads only the matching standalone archive from the latest GitHub release. It verifies the release
checksum, rejects unsafe archive paths, and then switches the per-user launcher. It requires no npm account and does
not resolve ohm from the npm registry.

For a portable manual copy, download the standalone archive and `SHA256SUMS` from the same release. Verify the exact
archive line, extract it, and run `bin/ohm` (`bin\ohm.cmd` on Windows).

To install from the public source checkout instead, first install Node.js 26.7.0 or newer and npm:

```sh
git clone https://github.com/devsohm/ohm.git
cd ohm
npm run install:user
ohm --version
```

By default, the managed one-line installer keeps its launcher, versioned standalone runtimes, and user-scoped data
under `~/.ohm`. A source install uses the same private root. Neither route creates a global npm package or links
the executable to the source checkout.

On Linux and macOS, the command launcher is `~/.local/bin/ohm`. On Windows, it is
`%USERPROFILE%\.ohm\bin\ohm.cmd`. See
[Installation and platform troubleshooting](install.md) for the exact runtime paths or if the command is not on
`PATH`.

## 2. Open a workspace

Launch ohm from the project you want it to work on:

```sh
cd /path/to/your/project
ohm
```

The launch directory becomes the workspace. It sets the starting directory for tools, the project instruction and
resource roots, and the default scope for `/resume`. You can launch the global `ohm` command from any directory.
Using a source checkout for installation does not make ohm run inside or modify that checkout.

To select a different workspace without changing the shell directory:

```sh
ohm --workspace /path/to/your/project
```

Tools can still use absolute paths when needed. Workspace scope is organization and trust context, not an operating-system boundary.

## 3. Connect a provider and choose a model

In the terminal interface, enter:

```text
/login
/model
```

`/login` shows the authentication methods implemented for each provider. These may include subscription OAuth,
browser or device OAuth, an API key, an environment credential, a cloud identity, or a local connection. `/model`
refreshes connected catalogs and shows models available to the active credentials.

Useful checks are:

```sh
ohm --list-models
ohm --list-models PROVIDER
```

You can choose a model for one invocation without changing the saved default:

```sh
ohm --model PROVIDER/MODEL:high
```

The optional suffix selects a supported thinking level. See [Providers and authentication](providers.md) for provider IDs, environment variables, OAuth behavior, custom endpoints, and model metadata.

`/thinking` reports the effective reasoning level. `/thinking off|minimal|low|medium|high|xhigh|max` changes it; ohm
clamps an unsupported request to a level supported by the selected model. The effective choice is recorded in the
session and saved as the default. `Shift+Tab` cycles supported levels, `/settings` exposes **Reasoning level**, and
`Ctrl+T` collapses or expands visible reasoning in the rich viewport, including the currently streaming block. Its
header remains visible while hidden reasoning continues accumulating.

## 4. Give ohm a task

Start with a task that has a concrete result and a verification step:

```text
Explain how this project starts, then identify the smallest safe fix for the failing test. Do not edit yet.
```

After reviewing the answer, ask the model to implement and verify the change. ohm displays model text, provider
visible reasoning, bounded live command output, completed tool details, edits, token usage, cache usage, and known
cost data. Provider-supplied summaries remain summaries, while raw public thinking such as Kimi or DeepSeek
`reasoning_content` remains raw. Visible reasoning streams in a bordered block, remains visible after completion, and
collapses or expands with `Ctrl+T`.

Type `/` for the command palette, `/help` for the interactive command list, or `/hotkeys` for the active key map. Prefix a command with `!` to run it yourself
and include its bounded result in session and model context:

```text
! git status --short
```

Use `!!` instead when the result must stay outside model context.

For a read-only review, restrict the available tools:

```sh
ohm --no-session --tools read,grep,find,ls --print \
  "Review this repository and cite concrete file paths. Do not modify files."
```

`--tools` is an allowlist. `--no-session` disables conversation persistence; neither option creates an OS sandbox.

Use `--max-steps NUMBER` to bound model turns for this invocation and
`--max-output-tokens NUMBER` to bound output for each model turn. A known live or
reviewed model ceiling clamps the request, and ohm validates completed output
against the effective bound even when the provider omits usable token counts.
Both require positive safe integers. `--max-steps` adds a bound only for the
current invocation; without it, the outer agent loop has no fixed step count.

## 5. Continue or branch the work

Sessions are saved automatically. To continue the most recent session in the current workspace:

```sh
ohm --continue
```

To choose one:

```sh
ohm --resume
```

Inside the interface, use `/resume`, `/new`, `/name`, and `/atlas`. Atlas explores
the active journal's lineage tree. Use `/resume --all` or `ohm --resume --all`
to search saved sessions in every workspace.

Automatic context compaction helps long sessions stay within the selected model's context window. `/compact` starts
it manually. See [Sessions and context](sessions.md), [Context compaction](compaction.md), and the
[session export contract](session-export.md) for recovery, branching, retention, import, and export behavior.

## 6. Add reusable behavior

ohm separates four resource types:

- A **skill** is on-demand instruction content. Only its name and description stay in the base prompt; full guidance loads when relevant.
- A **prompt template** is a reusable slash command with arguments and defaults.
- A **theme** is a terminal presentation resource; ohm ships the default operational `signal` and monochrome `mono` themes, and can discover custom themes.
- A **runtime extension** is trusted code that can add tools, commands, providers, authentication, state, events, shortcuts, and structural UI.

A **package** distributes one or more of those resources. Installed runtime extensions activate inside the current
ohm process and extend that harness. They do not need to launch a second ohm instance.

Install and inspect a reviewed package with:

```sh
ohm install ./my-package
ohm list
ohm extensions doctor
ohm remove my-package
```

Use `ohm --extension ./my-package/extensions/index.mjs` to load an extension for one invocation without installing
the package. Runtime extensions are ordinary Node.js code with your user's access. Review the package, its runtime
entries, and its production dependencies first. Enable dependency lifecycle scripts only for a reviewed install or
update by passing `--allow-scripts`.

To configure or develop ohm, enter `/skill:ohm-dev <request>`. For a package request, use a disposable workspace.
The single bundled skill uses version-matched installed documentation and verifies extensions through the real
install, `/refresh`, and remove path. See
[Extensions](extensions.md), [Package authoring and the local gallery](packages.md), and the
[Extension TUI](tui.md).

## 7. Know where data lives

The managed standalone installation keeps application files and user data in separate subdirectories of one root:

```text
~/.ohm/                       configuration, auth, sessions, logs, diagnostics, crash reports, and resources
~/.ohm/bin/                   managed launcher
~/.ohm/runtime/               versioned platform runtimes
```

Linux and macOS also use `~/.local/bin/ohm` as a command symlink into `~/.ohm/bin`.

The source-built private installation places its application under `~/.ohm/app` and uses `~/.ohm` as its ohm
home. Direct development and portable runs use the same default:

```text
~/.ohm/
```

Set `OHM_HOME` to choose another root. An installation creates
an empty, user-owned `AGENTS.md` and an editable `config.json` in its ohm
home when they are missing. Reinstall and update preserve both files.

Put personal instructions in `AGENTS.md`. Project `AGENTS.md` files load afterward, from outer ancestors through the
active working directory. Run `ohm config path` to print the settings location and `ohm config edit` to edit it
transactionally. Add `--scope project` to target the trusted workspace file. `ohm config` without an action selects
resources from installed packages. `/settings` covers common interactive preferences. See
[Settings](configuration.md) for paths, precedence, keybindings, instructions, and trust behavior.

## 8. Update, diagnose, or remove

Every installation can run diagnostics:

```sh
ohm diagnostics ./ohm-support.json
ohm extensions doctor
```

Update a managed standalone installation by rerunning the verified one-line installer. `ohm self-update` prints
that installer command. Both standalone and source-built private installations use `ohm uninstall --yes` for a
full purge of the managed application and saved state. Close other running ohm processes first. Removal does not
delete a source checkout, project workspace, unmanaged command, or external agent-directory override.

For common failures, see [Troubleshooting](troubleshooting.md), [Platform notes](platforms.md), and [Local diagnostics](diagnostics.md).

## Where to go next

- Learn the terminal workflow: [README terminal workflow](../README.md#terminal-workflow) and [Runtime cookbook](cookbook.md).
- Build structural terminal UI for an extension: [Extension TUI](tui.md).
- Configure providers and models: [Providers and authentication](providers.md).
- Understand persistence: [Sessions and context](sessions.md) and [Context compaction](compaction.md).
- Install or author extensions: [Extensions](extensions.md) and [Packages](packages.md).
- Automate or embed ohm: [HTTP and SSE service](serve.md), [RPC](rpc.md), [Embedding](embedding.md), and [Public API](public-api.md).
- Understand the implementation: [Architecture](ARCHITECTURE.md).
