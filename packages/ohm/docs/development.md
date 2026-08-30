# Development from source

This guide is for contributors working in the monorepo. A managed user
installation is a copied application with an ownership marker. It does not run
code from the source checkout.

## Toolchain and first build

The root `package.json` requires Node.js 26.7.0 or newer. The workspace build
also requires npm.

```sh
git clone https://github.com/devsohm/ohm.git
cd ohm
node --version
npm --version
npm ci --ignore-scripts
npm run build
```

The root build orders the workspaces:

```text
@ohm/terminal -> @ohm/models -> @ohm/kernel -> ohm
```

The application imports sibling packages through their built exports. Build
those dependencies before running a direct TypeScript entry. `dist/`
directories are generated output. Change `src/`, tests, docs, resources, or
generation inputs instead.

On macOS or Windows, source installation and release verification also build
the matching native artifacts. macOS needs `cc` and `swiftc`; Windows needs an
architecture-matching MSVC developer shell with `cl`. Ordinary Linux
development does not compile those helpers.

## Run without installing

From the repository root, run the TypeScript entry directly:

```sh
node --import tsx packages/ohm/src/bin/ohm.ts --offline
```

Or run the built entry:

```sh
npm run build
node packages/ohm/dist/bin/ohm.js --offline
```

Both commands preserve the shell's current directory as the launch workspace.
By contrast:

```sh
npm run dev --workspace ohm -- --offline
```

runs npm's package script with `packages/ohm` as its working directory. That
is useful for package-local development, but it makes that package directory
the default ohm workspace unless `--workspace` is supplied.

To exercise a separate fixture project against the built checkout:

```sh
cd /absolute/path/to/fixture
node /absolute/path/to/ohm/packages/ohm/dist/bin/ohm.js --offline
```

Use an isolated ohm home when a test should not read or modify personal
settings, credentials, sessions, packages, or caches:

```sh
export OHM_HOME="$(mktemp -d -t ohm-dev-home.XXXXXX)"
printf 'isolated ohm home: %s\n' "$OHM_HOME"
node packages/ohm/dist/bin/ohm.js --offline --no-session
```

Keep provider credential variables unset for deterministic offline work.
`--offline` prevents startup catalog refreshes and package network operations;
it does not turn arbitrary extension or tool code into a sandbox.

## Install a private source build

From the repository root:

```sh
npm run install:user
ohm --version
```

This builds and copies a private application under `OHM_INSTALL_DIR` or
`~/.ohm`. It does not create a global npm package or link the launcher to the
checkout. Later source edits remain invisible until the next source-install
transaction. `ohm uninstall --yes` removes the marker-owned private
installation, subject to the lifecycle lock and active-runtime checks.

Use direct source or built-entry commands for short edit/test loops. Use the
private installer when verifying packaging, launchers, update behavior,
scaffold preservation, or platform helpers.

## Path resolution

When present, `--workspace` is resolved against the invoking process directory.
Otherwise, the launch workspace is `process.cwd()`. The workspace determines
tool paths, project trust, project resources, and default session grouping.

Important bases:

| Input | Resolution base |
| --- | --- |
| Invocation `--extension`, `--skill`, `--prompt-template`, and `--theme` paths | Launch workspace |
| User-scoped local resource paths in settings | ohm home |
| Project-scoped local resource paths in settings | `WORKSPACE/.ohm` |
| `OHM_HOME` | Used as supplied after `~` expansion; choose an absolute value for repeatable tests |
| `config.json` `sessionDir` | Launch workspace after `~` expansion |
| `--session-dir` and `OHM_SESSION_DIR` | Normalized first, then a relative value is resolved by session storage against the invoking process directory |
| Built-in README, docs, examples, and bundled `ohm-dev` resources | Installed/source package location derived from the module URL |

The package-location rule is why the runtime can find its own docs and bundled
resources regardless of the launch workspace. Do not resolve application
assets from `process.cwd()`.

Canonical-path deduplication follows real paths when they exist. A missing path
is resolved lexically and normally becomes a resource diagnostic. Project
resources still require trust when project settings supply their path.

## Focused verification

Run a focused TypeScript test from the application workspace:

```sh
cd packages/ohm
node --import ./test/setup.mjs --import tsx --test \
  test/tui/capabilities.test.ts
```

Other useful focused suites include:

```text
test/tui/controller.test.ts
test/tui/keys.test.ts
test/context/instructions.test.ts
test/context/skills.test.ts
test/storage/session-manager.test.ts
```

Source and test declarations are checked separately:

```sh
npm run typecheck --workspace ohm
npm run typecheck:test --workspace ohm
```

Before handing off a change, return to the repository root and run:

```sh
git diff --check
npm run check
```

The root check enforces dependency and workspace policy, builds all packages,
and runs each workspace check. The ohm check covers types, tests, an external
consumer, distribution, and release validation. Live provider tests and paid
comparisons are separate. Run them only with explicit credentials and cost
authorization.

## Optional adapter seams

The repository keeps three extension points available without shipping their
optional products:

| Future component | Stable starting point |
| --- | --- |
| Durable session backend | Journal readers, writers, validation, and recovery state from `@ohm/kernel/session-v4` |
| Behavioral evaluation runner | `createAgentSessionServices()` and `createAgentSessionFromServices()` from `ohm/sdk` |
| Multi-process supervisor | `RpcClient` from `ohm/interfaces`, or the JSONL process at `ohm/rpc-entry` |

A storage adapter must prove reopen, fork, branch selection, bounded reads,
concurrent append ordering, and failure rollback. A failed durable write must
not publish an entry or leaf change.

An evaluation runner should use isolated workspace and agent directories,
require an explicit provider and model, support prompt, refresh, cancellation,
and cleanup steps, and normalize results without adding scenario-specific
runtime behavior.

A process supervisor should test correlated responses, interleaved events,
extension UI requests, paged history, child exit with pending requests, and
bounded shutdown. It can use the existing RPC process or the authenticated
loopback service. The service owns one process and is not a supervisor.

The installed CLI intentionally uses its JSONL `SessionManager`. Connecting a
future database-backed adapter to that CLI requires a small session-factory
bridge; the neutral kernel storage contract does not require that database or
bridge today.

## TUI debugging

Start with an isolated ohm home and offline mode, then test these
boundaries independently:

```sh
OHM_ACCESSIBLE=1 node packages/ohm/dist/bin/ohm.js --offline --no-session
OHM_SYNC_UPDATE=0 node packages/ohm/dist/bin/ohm.js --offline --no-session
OHM_ASCII=1 TERM_COLOR=0 node packages/ohm/dist/bin/ohm.js --offline --no-session
OHM_DEBUG_REDRAW=1 node packages/ohm/dist/bin/ohm.js --offline --no-session
```

Reproduce once outside tmux, SSH, and an IDE. Use a real PTY for raw-input,
resize, bracketed-paste, and inline
image behavior; redirected input or output intentionally selects a fallback
path. Redraw diagnostics contain bounded renderer geometry, not transcript
text, and are disabled unless requested.

The TUI tests include in-memory renderer tests and real-PTY fixtures. PTY and
platform-native cases can skip where the host lacks the required facility, so
record the exact platform and skipped test names when reporting a terminal-only
bug.

Do not add ad hoc terminal writes to debug the renderer. They compete with the
single live-surface owner and can create the artifact being investigated.
Prefer a focused test that captures the controller's output stream or a
generation-owned component with deterministic state.

For key problems, compare `/hotkeys` outside and inside the multiplexer. For
repaint problems, test synchronized output off, semantic zones off, terminal
shrink, and refresh separately. For image problems, verify protocol detection
and caption fallback before inspecting payload encoding.

## Contributor boundaries

- Preserve credential access behind `src/auth`; never log secret values.
- Keep filesystem checks for tools centralized in `src/tools/paths`.
- A requested sandbox must fail closed if isolation cannot be established.
- Session records are append-only; change projections rather than rewriting
  history.
- Tool failures are model-visible results; invariant failures stop the run.
- Preserve opaque provider continuation state without exposing hidden
  reasoning.
- Add a regression test for every runtime behavior change.
- Do not copy generated `dist/` output back into source.
