<h1 align="center">
  <img src="assets/brand/ohm-lockup.svg" alt="ohm" width="640">
</h1>

**Power your agent. Own the runtime.**

ohm is an open, local-first agent harness for people who want control over how their agent works. Its lean core provides
a capable agent runtime, bounded coding tools, persistent sessions, multiple ways to interact, and a trusted extension
system designed to be built on rather than boxed in.

Instead of putting every possible workflow into core, ohm supplies the foundation for the agent you want. Extensions
can add tools, commands, providers, authentication, state, events, and UI. Use ohm in its terminal interface, run it
once or over JSON, RPC, HTTP, or SSE, embed it through the SDK, or build a new experience on the same runtime.

**ohm is not the finished agent. It is the harness you build yours with.**

Runtime extensions and `bash` execute with your operating-system user privileges. Review executable packages before enabling them; ohm is not a process sandbox.

The `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools are active by default across interactive, print,
JSON, RPC, serve, and direct SDK sessions.

## Install and start

One command detects the current x64 or arm64 platform, verifies the matching GitHub standalone release, installs its
pinned runtime, and creates a per-user launcher:

```sh
curl -fsSL https://raw.githubusercontent.com/devsohm/ohm/v0.1.0/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/devsohm/ohm/v0.1.0/install.ps1 | iex
```

Neither command needs Node.js, npm, an npm account, or the npm registry. Linux and macOS need `curl`, `tar`, and a
SHA-256 utility. Current Windows includes the required PowerShell and `tar.exe`.

For a portable manual installation, download the standalone archive for your platform from the
[v0.1.0 GitHub release](https://github.com/devsohm/ohm/releases/tag/v0.1.0), verify it against `SHA256SUMS`, and
extract it.

```sh
tar -xzf ohm-v0.1.0-linux-x64.tar.gz
cd /path/to/your/project
/path/to/ohm-v0.1.0-linux-x64/bin/ohm
```

Use `bin/ohm` on Linux or macOS and `bin\ohm.cmd` on Windows. The
[complete product guide](packages/ohm/README.md) covers every platform, a private per-user installation from the
same GitHub release, and source installation.

To remove a portable copy, close its processes and delete the extracted archive directory. The managed
`ohm uninstall --yes` command does not claim or delete an arbitrary portable directory; portable user state remains
under `~/.ohm` until you intentionally remove or reuse it.

On first run, use `/login` to connect a provider. Then use `/model` to select an available model. The directory where
ohm starts is the workspace unless you pass `--workspace DIR`.

By default, the managed installation keeps its launcher, versioned runtime, and user-scoped state under
`$HOME/.ohm`. On Linux and macOS, `$HOME/.local/bin/ohm` is only a command symlink into that root. A manually
extracted archive remains portable. Neither route uses npm's global package directory or redirects execution into
this source checkout.

Useful commands include `/help`, `/settings`, `/model`, `/thinking`, `/new`, `/resume`, `/atlas`, `/compact`, `/refresh`,
`/export`, `/share`, and `/hotkeys`. Run a one-shot task with:

```sh
ohm -p "Review this project and explain its architecture"
```

The installer creates an empty, user-owned `~/.ohm/AGENTS.md` and an
editable `config.json` when they are missing. Updates preserve both files.
Personal instructions load first from that `AGENTS.md` (or
`$OHM_HOME/AGENTS.md`). Project `AGENTS.md` files then load in
ancestor order. Run `ohm config path` to locate the user settings document
and `ohm config edit` to edit it safely. Add `--scope project` to target the
trusted workspace settings file.

Read the complete product guide for providers, sessions, configuration, terminal controls, extensions, embedding,
RPC, the local HTTP and SSE service, security boundaries, and troubleshooting. The [extension examples catalog](packages/ohm/examples/README.md)
routes authors by outcome, and the [documentation map](packages/ohm/docs/README.md) links every focused topic.

## How ohm works

[![ohm request and tool loop](packages/ohm/docs/assets/core-loop.svg)](packages/ohm/docs/ARCHITECTURE.md)

Interactive, print, JSON, RPC, serve, and SDK modes use the same
`AgentSession`, kernel runtime engine, tool coordinator, and V4 session state.
The [architecture guide](packages/ohm/docs/ARCHITECTURE.md) explains the
request loop, storage, refresh, compaction, execution, and extension boundaries.

## Packages

- [`ohm`](packages/ohm) — the terminal application, session runtime, extension host, and public application API.
- [`@ohm/models`](packages/models) — canonical messages, model metadata, standalone provider transports, OAuth helpers, and streaming utilities.
- [`@ohm/kernel`](packages/kernel) — the reusable agent loop and queue/lifecycle primitives.
- [`@ohm/terminal`](packages/terminal) — terminal input, rendering, components, layout, themes, and native helpers.

[![ohm package dependency layers](packages/ohm/docs/assets/package-layers.svg)](packages/ohm/docs/ARCHITECTURE.md#package-layers)

## Development

```sh
npm install
npm run check
```

The repository root is a private workspace container. Release tooling uploads only validated artifacts to GitHub
Releases. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[release procedure](packages/ohm/docs/releasing.md).

## License

ohm is released under the [MIT License](LICENSE).
