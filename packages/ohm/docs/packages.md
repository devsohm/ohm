# Plugin packages

An ohm plugin declares any combination of factory entry points, skills, prompts, and themes in one `package.json`. A package containing only declarative resources needs no runtime factory. Executable entries are trusted Node.js code; each factory receives the public `PluginAPI` from `ohm/plugins`.

Use `ohm plugins` to create, test, preview, verify, install, list, update, diagnose,
or remove plugins. Code, skills, prompts, and themes are contribution types in
that one plugin system and share the same runtime.

Start with the [examples catalog](../examples/README.md), then copy [`examples/starter`](../examples/starter/README.md) into a new workspace directory instead of editing the bundled example. The bundled copy stays `private` to prevent accidental publication from the ohm repository, but it includes the enforced ohm peer range. Choose your own package name and remove `private` only when the copy is ready for registry publication.

## Package shape

```text
my-plugin/
  package.json
  README.md
  src/index.ts
  skills/review/SKILL.md       # optional
  prompts/review.md            # optional
  themes/ocean.json            # optional custom theme
  checks/runtime.test.mjs      # recommended
```

A complete declaration is:

```json
{
  "name": "@example/my-plugin",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": { "ohm": ">=0.2.0 <0.3.0" },
  "ohm": {
    "entrypoints": ["src/index.ts"],
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

The `ohm` object accepts four string arrays: `entrypoints`, `skills`, `prompts`, and `themes`.

Paths are package-relative, normalized, and constrained to the package root. Resource resolution rejects or reports missing paths, symlink escapes, and unsupported formats. Declare only the documented keys; unknown `ohm` keys are not plugin configuration.

For runtime-selected resources outside the package, a trusted plugin can
return explicit absolute paths from `resources_discover`. Relative contributions
remain package-contained. This selects bounded, read-only resource loading; it
does not change model-tool filesystem permissions. See [dynamic resource
discovery](plugins.md#skills-prompts-and-custom-themes).

ohm ships the built-in `mono` and `signal` themes. Package declarations add reviewed custom themes without replacing them.

`peerDependencies.ohm` is the enforced host-compatibility range. ohm validates it before package activation and does not install a nested host runtime. `engines.ohm` remains optional report metadata for older packages, but it is not an activation gate. Test the packed artifact against every supported ohm release before publishing.

## Portable skill packages

ohm can also load the skills portion of the portable plugin 1.0.0 format. This is an additional package input, not a replacement for ohm's native plugin package format.

```text
portable-tools/
  plugin.json
  skills/
    review/
      SKILL.md
```

The minimal manifest is:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "portable-tools"
}
```

When `plugin.json` exists, it is authoritative. ohm validates it before looking for components. An invalid manifest rejects that package; ohm does not reinterpret the directory as a native package. Unsupported namespaces are ignored without inspecting their values.

Portable skill discovery is intentionally narrow: `skills/` must be a directory, each skill must be an immediate child directory, and its manifest must be named exactly `SKILL.md`. Every discovered skill receives strict frontmatter, name, and root-containment validation. One invalid skill does not block valid siblings or namespaced ohm resources. A discovered component path may link within the package root; a link that resolves outside it is rejected at the narrowest component boundary.

This release is skills-only for portable components. A root `mcp.json` is left untouched and ignored without a warning. MCP processes are not started from portable packages. Use a reviewed ohm plugin when an integration needs an external protocol client.

When a declaration is omitted, the matching conventional directory is discovered if present. Explicit declarations are preferable for published packages because the packed file set is then obvious. Hierarchical `.gitignore`, `.ignore`, and `.fdignore` rules apply during package inventory.

Package metadata is read through bounded regular-file snapshots. Native and legacy manifests and ignore files are limited to 1 MiB; managed package locks, declared legacy integrity files, and direct runtime source files are limited to 16 MiB. Project package manifests use the narrower 512 KiB project-resource limit. Authoring inspection accepts at most 4,096 files, 32 MiB per file, and 64 MiB in aggregate; packed artifacts are also limited to 64 MiB, and gallery indexes to 4 MiB. Files that exceed a limit, are not regular files, or violate the applicable symlink policy are rejected before activation or publication. Descriptor-bounded reads prevent concurrent growth from bypassing the byte ceiling.

Runtime files may be JavaScript, TypeScript, or their standard ESM/CommonJS variants. Every runtime entry must default-export one factory:

```ts
import type { PluginAPI } from "ohm/plugins";

export default function activate(ohm: PluginAPI): void {
  ohm.registerCommand("hello", {
    description: "Show a greeting",
    async handler(_args, context) {
      context.ui.notify("Hello from the plugin.", "info");
    },
  });
}
```

## Install and run

Install a local package:

```text
ohm plugins install ./my-plugin
```

Other immutable sources are supported:

```text
ohm plugins install "npm:@example/my-plugin@1.2.3"
ohm plugins install "npm:file:///absolute/path/my-plugin-1.2.3.tgz"
ohm plugins install "git:https://github.com/example/my-plugin.git#0123456789abcdef0123456789abcdef01234567"
```

For a bare `npm:file:` archive, ohm records the validated package identity
selected by the package manager. Multiple archives therefore remain
independently discoverable after restart; removal still uses the identical
source string. Two configured sources that declare the same package name are
rejected before either installed package is replaced.

Git package URLs are credential-free:

- HTTPS credential helpers are disabled, so private HTTPS repositories are unavailable;
- for private repositories, use a real SSH host URL with an agent or default key;
- SSH keeps the normal key and `known_hosts` locations, but ignores user/system SSH configuration, aliases, `ProxyJump`, `ProxyCommand`, and local commands;
- Git LFS filters and submodules are disabled.

A short moving ref resolves a same-named branch before a tag. ohm then verifies that the checkout still matches the advertised commit before activation.

Use `-l` for the trusted project scope. Lifecycle scripts are disabled by default; `--allow-scripts` is accepted only by install and update commands and should be used only after reviewing the complete dependency tree.

After changing package code, run `/refresh`. ohm sends `session_shutdown` to the current generation, activates a candidate, and replaces the current generation only after preparation succeeds. If candidate activation fails, the candidate is disposed and the previous generation receives `session_start` again.

Useful commands:

```text
ohm plugins list --json
ohm plugins doctor
ohm plugins show PACKAGE_ID
ohm plugins update SOURCE
ohm plugins remove SOURCE
```

`ohm plugins remove` removes the configured package contribution. For managed npm or
Git sources it also removes the installed package bytes; a local source directory
is never deleted. Package removal does not delete the separate plugin-owned
user or workspace data roots, including documents written through `ohm.config`.
This lets a later reinstall of the same contribution identity recover durable
state. If a package needs an explicit "forget my data" operation, expose a
bounded, confirmed command that calls `ohm.config.remove` before removal. A
disposer cannot do this: the API is stale before disposal, and removed package
code is not activated merely to erase data.

Remove a packed archive with the identical immutable source string used to
install it:

```text
ohm plugins install "npm:file:///absolute/path/my-plugin-1.2.3.tgz"
ohm plugins remove "npm:file:///absolute/path/my-plugin-1.2.3.tgz"
```

With `--offline`, `update` rejects a selected moving npm version, range, tag, or Git ref before checking or staging it. Local paths and immutable npm versions or full Git revisions remain non-network selections. An explicitly requested `install` remains an intentional operation and is not disabled by this update guard.

For one invocation without persisting package settings, use `ohm --plugin /absolute/path/to/index.mjs` or point `--plugin` at a package source. `--no-plugins` disables automatic discovery while preserving the selected plugin's code and declared resources. Individual `--no-skills`, `--no-prompt-templates`, and `--no-themes` switches can suppress those resource kinds. Invocation loading never enables dependency lifecycle scripts.

## Package entries in settings

The `plugins` array in `config.json` accepts a source string or an object:

```json
{
  "plugins": [
    "git:https://github.com/example/basic-tools.git#0123456789abcdef0123456789abcdef01234567",
    {
      "source": "npm:@example/review-tools@1.2.3",
      "autoload": true,
      "entrypoints": ["!src/internal.mjs", "+src/public.mjs"],
      "skills": ["skills/review"],
      "prompts": [],
      "themes": ["themes/*.json"]
    }
  ]
}
```

An object accepts `source`, `autoload`, `entrypoints`, `skills`, `prompts`, and `themes`.

`autoload` is `true` by default. When it is true:

- an omitted resource field keeps the package declaration for that resource type;
- an empty resource array disables all resources of that type;
- an unmarked pattern selects matching resources;
- `!PATTERN` disables matching resources;
- `+PATH` enables one exact package-relative path;
- `-PATH` disables one exact package-relative path.

Exact `+` and `-` rules run after pattern rules. An exact `-` rule has final priority. A settings filter cannot enable a resource that the package manifest already excluded.

When `autoload` is `false`, the package does not add its resources automatically. Only entries in the resource arrays change the result. This form can apply a project delta to the same user package. For example, a project can disable one plugin and keep the other user-scoped resources unchanged:

```json
{
  "plugins": [
    {
      "source": "npm:@example/review-tools@1.2.3",
      "autoload": false,
      "entrypoints": ["-src/internal.mjs"]
    }
  ]
}
```

Project settings are read only after project trust. A project package entry wins over an equivalent user entry. The exception is a project entry with `autoload: false`; it keeps the user entry as its base and applies only its resource delta. If the project array repeats one package identity, the last project entry wins.

Package identity uses the npm package name, the Git repository, or the resolved local path. Resource paths are also deduplicated by canonical filesystem path. One physical resource loads only once, even when more than one configured path or symbolic link reaches it.

## Declarative project package set

A trusted workspace may declare a reviewed package set in `.ohm/packages.json`:

![Managed package update, commit, startup, and reconcile lifecycle](assets/managed-package-lifecycle.svg)

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "id": "local-review",
      "source": { "kind": "local", "path": "packages/review" },
      "disabledResources": ["command:internal-review"]
    },
    {
      "id": "published-review",
      "source": { "kind": "npm", "package": "@example/review", "selector": "^1.2.0" }
    },
    {
      "id": "git-review",
      "source": { "kind": "git", "repository": "https://github.com/example/review.git", "ref": "main" }
    }
  ]
}
```

Declarations are ignored without project trust. IDs are unique lowercase identifiers; local paths are normalized workspace-relative paths outside `.ohm`; Git repositories must be credential-free HTTPS or SSH locations. Resource filters use `runtime:`, `skill:`, `prompt:`, `theme:`, or `command:` followed by a package-relative resource key or command name. Filters are literal and exact: `*`, `?`, and brackets are not globs, and a basename does not match the same name in another directory.

The declaration is intentionally separate from its generated `.ohm/packages.lock.json`:

```text
ohm packages check
ohm packages update --all
ohm packages update local-review
ohm packages reconcile
```

`update` is the only operation that follows a moving selector, branch, or local edit. It:

1. resolves the selected declarations;
2. records exact versions or revisions and archive, manifest, and content digests;
3. activation-tests the complete candidate set;
4. commits the installed set and lock together.

Partial updates reject unrelated declaration additions, removals, or edits.

Normal startup and `reconcile` consume only the immutable lock. A healthy local install is not refreshed merely because its source directory changed. If repair is required, the source must reproduce the locked digests or reconciliation fails.

ohm stages and swaps the complete `.ohm/packages` directory as one recoverable transaction. Cancellation or activation failure preserves the previous lock and installed set. Dependency lifecycle scripts remain disabled for every declarative operation. Do not hand-edit the generated lock.

New updates write project lock schema 2. Schema 2:

- uses locale-independent code-unit ordering;
- embeds canonical production dependency locks;
- includes empty directories in content identity;
- rejects package-content names that are not portable across supported filesystems.

Rejected names include case or NFC-equivalent collisions, Windows device basenames, colons and other Windows-invalid characters, and trailing dots or spaces. Historical public package IDs remain unchanged. A Windows-reserved or trailing-dot ID maps to a collision-free private install-directory name.

Modern packages with multiple runtime files receive deterministic path-derived plugin IDs for every runtime. A single runtime keeps the package ID.


Schema 2 is a one-way lifecycle upgrade. An older host that only understands schema 1 cannot consume or safely downgrade a schema 2 lock. If a host downgrade is required, use version control to restore the declaration, lock, and matching installed state. Never edit the schema number.

Production dependency replay is split into a portable anchor and a local platform attestation. The lock digest covers every required installed byte and rejects omitted-development roots or extraneous content. Required non-host peers are installed and attested; optional peers remain optional. A `ohm` peer is checked against the running host version and removed from the install inventory so plugins cannot install a second host runtime. Optional, OS-gated, CPU-gated, and libc-gated packages may legitimately be absent on one platform and present on another, so their installed bytes are digested immediately after controlled `npm ci`. The exact digest is written to package provenance and to one append-only, mode-`0600` record keyed by canonical workspace, lock digest, package ID, and a stable OS/architecture/libc-family/Node-ABI fingerprint under ohm's manager-private state beside the operation-lease root. Linux fingerprints distinguish glibc from musl; other operating systems use a deterministic non-Linux libc marker. A different digest for the same lock and platform fails closed; a deliberate declaration update creates a new lock identity. Startup requires the installed bytes, provenance, and external record to agree, so deleting optional bytes and rewriting the excluded in-package provenance cannot select an older attested digest. This protects against workspace drift or a writer limited to the project tree, not an attacker who can also modify ohm's private agent state.

All npm resolution and replay commands run without the ambient process environment. ohm supplies only:

- executable and system path variables;
- a private HOME;
- empty npm user and global configuration;
- cache and temporary directories inside the quota-monitored staging root.

Ambient `.npmrc`, registry tokens, lifecycle scripts, and update/audit/fund helpers are unavailable.

Git materialization uses isolated configuration, empty hooks/templates and filters, non-interactive credentials, an explicit protocol allowlist, and no submodules. Materialization is monitored while commands run. It terminates beyond 4,096 filesystem entries, 64 MiB, or the depth bound, then removes partial staging state.

## Transaction and trust model

Install and update use a private staging directory. Before commit, ohm validates:

- bounds and package structure;
- declared resources;
- production dependencies;
- exact runtime entries;
- activation.

A failure removes the staged package and preserves the installed version byte-for-byte. A multi-package update stages and activation-tests the complete selected set before committing any member. If a later filesystem commit fails, ohm reverses earlier swaps.

Runtime code is trusted in-process code. It can use Node.js and any declared production dependency. Project-scoped code is not imported until project trust succeeds. Review the source, package metadata, dependency graph, install scripts, network destinations, and process boundaries before trusting a package.

An activation generation owns all registrations. Failed activation, timeout, successful refresh, package replacement, and host close make its API stale before cleanup starts. `ohm.onDispose` callbacks run once in reverse registration order. Cleanup failures are isolated and reported; later callbacks still run.

## Dependencies and host imports

Put runtime dependencies in `dependencies`; keep tests and build tools in `devDependencies`. Do not ship package-local `node_modules`.

A loaded plugin may import the package root and stable host subpaths published by the installed ohm version, including:

```text
ohm/plugins
ohm/providers
ohm/storage
ohm/tui
```

Keep `ohm` as a peer dependency. For local TypeScript checks or standalone tests,
install the complete same-release package graph into the plugin development
directory using the [SDK archive workflow](sdk.md#install-the-public-package-graph),
with `--ignore-scripts --no-save`. The host aliases runtime imports to its own
installed copy. A global CLI installation alone does not supply local TypeScript
declarations; do not bundle another ohm runtime in the plugin archive.

For an SDK host, a package belongs in the shared settings manager:

```ts
const settingsManager = SettingsManager.inMemory({
  plugins: ["/absolute/path/to/my-plugin"],
});
```

Pass that manager to both `DefaultResourceLoader` and `createAgentSession`, as
shown in [custom SDK resources](sdk.md#custom-resources), and refresh the loader
before creating the session. This loads the package's declared code, prompts,
skills, and themes together. `additionalPluginPaths` selects code entry files;
it does not expand a package's other resource declarations.

## Author workflow and verification

Start a new package with `ohm plugins init ./my-plugin`. The command
copies the bundled TypeScript starter and its tests into a new directory, sets a
package name from the directory name, and keeps it private. Existing paths are
never overwritten, dependencies are not installed, and the parent directory must
exist. Review the copy and install its development dependencies when ready.

Author commands accept a real local package directory. They do not accept a `.tgz` archive as `PACKAGE`. Run the author pipeline from the package root:

```text
ohm plugins test .
ohm plugins preview .
ohm plugins verify .
ohm plugins validate .
ohm plugins inspect .
ohm plugins smoke .
ohm plugins refresh .
ohm plugins report .
ohm plugins pack . /absolute/path/to/artifacts
```

`test` runs the package's explicit `scripts.test` command without npm pretest or
posttest hooks. It installs nothing, has a two-minute timeout, bounds retained
stdout/stderr to 1 MiB each, and cancels the process tree on interruption. The test
script is trusted executable code and can access your account or network.

`preview` opens the normal interactive host with the selected source package,
automatic plugin discovery disabled, automatic network discovery disabled,
and no saved session. It requires a terminal; `preview --json` instead describes
the exact invocation without activating the package. Use `/actions` to exercise
portable actions, invoke commands normally, edit source, then run `/refresh`.
Closing with `/exit` disposes the generation. There is no second preview runtime
or file watcher. Preview uses normal settings, credentials, workspace trust, and
other configured resource discovery; it does not install the package. Offline is
not a network sandbox and does not prevent explicit model or plugin requests.

Here, clean source means the `plugins inspect` npm pack file set has been reviewed and excludes prior archives, package-local `node_modules`, credential files, and unrelated generated files. It does not require a Git repository or a globally clean monorepo. Write archives outside the package root so they cannot enter a later pack file set.

`verify` is the combined source-and-package check. It runs `report`, creates an archive, installs it through the normal package manager into temporary state, loads its resources, activates and replaces any executable generation, and removes the temporary installation. Installation is offline and disables lifecycle scripts; dependencies must already be cached. This tests the actual archived files, including resources and imports omitted by a `files` declaration. It does not alter your configured packages. Temporary directories do not isolate executable plugin code from your account.

`validate` does not import runtime code. `smoke` activates and disposes the source package's factories. `refresh` activates a second valid candidate before disposing the first. `report` aggregates those source-directory checks. For `pack`, the final argument is a destination directory (created when missing); the JSON `artifact` field is the authoritative filename. `pack` publishes the archive only when that filename does not already exist. Use `verify` to test installation and activation of the packed bytes.

`smoke` and `refresh` also load declared skills, prompts, and themes through the
normal resource loader and reject resource diagnostics. Resource-only packages
use the same commands without a dummy factory; their runtime/tool/command/provider
counts are zero. `refresh` reloads their resource generation. Empty packages and
resource diagnostics fail these checks. `verify` also rejects an archive that
omits an enabled resource resolved from the source package. Manifest patterns
retain the normal resolver's selection semantics; an unmatched pattern is not
an assertion that a file must exist.
Unrelated project resources and context files are not part of the author check.

Every successful `init`, `test`, `preview --json`, `verify`, `validate`, `inspect`, `smoke`, `refresh`, `report`, or `pack`
command writes exactly one JSON document plus a trailing newline to standard
output. Without `--json` the document is indented; `--json` selects compact
one-line JSON. The command result shapes are:

| Command | Result |
| --- | --- |
| `init` | New `directory`, package `name`, copied `files`, and `nextActions`. |
| `test` | `status`, `directory`, `exitCode`, bounded `stdout`/`stderr`, `truncated`, and `timedOut`; a failed test also exits nonzero. |
| `preview --json` | `packageId`, `directory`, exact host `argv`, and `nextActions`; no live activation. |
| `verify` | The report shape with an additional `packed` check containing archive hash/files and installed activation/replacement results. Temporary artifacts are removed. |
| `validate` | Package identity and contribution counts, compatibility, integrity, and diagnostics. |
| `inspect` | `validation`, the selected `fileSet`, reviewed `files`, and npm pack metadata when applicable. |
| `smoke` | Package ID, runtime/tool/command/provider counts, and `disposed: true`. |
| `refresh` | The smoke fields plus `refreshed: true` and `warnings`. |
| `report` | Overall `status`, `summary`, `nextActions`, `artifacts`, and ordered `checks` with per-check status and optional detail. |
| `pack` | Absolute `artifact` path, archive `sha256`, and exact npm pack metadata and files. |

A successful command exits zero. A failed `validate`, `inspect`, `smoke`,
`refresh`, or `pack` emits the bounded CLI error on standard error and exits
nonzero instead of printing a result document. `report` and `verify` are deliberately
different: it always prints its aggregate result, sets `status: "error"` when
one or more checks fail, and exits nonzero. Automation must check both the exit
status and the parsed result; do not treat parseable report output as success.

The starter's `npm test` first typechecks `src/index.ts`, then runs a copyable factory-level test. The test uses `node:test`, records public command and tool registrations, and invokes their callbacks without importing private ohm files. This proves focused callback behavior, not package loading, transactional activation, or installed-artifact behavior; use the author commands and installed smoke for those boundaries.

For everyday editing, load a reviewed source copy with `ohm plugins preview PACKAGE`
(or directly with `ohm --plugin PACKAGE`), edit it, run `ohm plugins test PACKAGE`,
and use `/refresh` in that session. Before sharing
the package, run `ohm plugins verify PACKAGE`. Neither the combined
check nor the package test runner invents model requests or invokes arbitrary
registered tools. Add explicit tests for your own cancellation and recovery
contracts; the optional memory and code-review packages show those cases.

The author `refresh` check proves valid-candidate repeat activation and cleanup.
It does not inject a failure or prove live rollback. Verify that separate
boundary in a disposable source copy:

1. Load the reviewed copy with `ohm --plugin PACKAGE_COPY` and establish a
   working command or another observable registration.
2. Change only that copy so its activation throws, then run `/refresh`.
3. Require the refresh to report failure, require the original command to remain
   usable, and confirm that no candidate-only registration or resource appeared.
4. Restore the reviewed source, run `/refresh` again, and confirm one clean
   replacement generation.

Do not perform this test against an installed package, a bundled example, or the
only reviewed source tree. The source-loaded smoke complements the core runtime
rollback test; it does not replace the packed and installed artifact checks.

Also test malformed input, cancellation, activation failure, repeated refresh, cleanup, and the exact installed artifact. A passing source test does not prove that an npm archive contains every declared file.

## Focused examples

The [examples catalog](../examples/README.md) groups every installable package by outcome, host support, authority, and verification level. Each package has one `package.json` declaration; executable packages add a direct factory entry. Combine only the contracts the product actually needs.

The [external execution backend adapters](../examples/execution-backends/README.md) are standalone protocol adapters, not plugin packages.
