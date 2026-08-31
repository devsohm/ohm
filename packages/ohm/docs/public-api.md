# Public Node.js API policy

ohm ships ESM for Node.js 26.7.0 or newer. The package `exports` map is the supported import boundary. Paths inside `dist/` are implementation details, even when they are present in an archive.

The supported public entry points are:

```text
ohm
ohm/auth
ohm/config
ohm/context
ohm/core
ohm/embedding
ohm/extensions
ohm/images
ohm/interfaces
ohm/rpc-entry
ohm/modes
ohm/net
ohm/process
ohm/prompts
ohm/providers
ohm/service
ohm/serve
ohm/sdk
ohm/storage
ohm/testing
ohm/tools
ohm/tui
ohm/package.json
```

Public subpaths have these stability classes:

| Stability class | Subpaths | Intended use |
| --- | --- | --- |
| Application stable | `ohm`, `ohm/embedding`, `ohm/interfaces`, `ohm/modes`, `ohm/sdk` | Task-level embedding, ready-made modes, composition, and RPC clients. Prefer these boundaries for applications. |
| Executable stable | `ohm/rpc-entry` | Starts the newline-delimited RPC process directly. Importing this entry runs the process; it is not a library namespace. |
| Advanced stable | `ohm/auth`, `ohm/config`, `ohm/context`, `ohm/core`, `ohm/extensions`, `ohm/images`, `ohm/net`, `ohm/process`, `ohm/prompts`, `ohm/providers`, `ohm/service`, `ohm/serve`, `ohm/storage`, `ohm/tools`, `ohm/tui` | Low-level composition. These APIs can carry more host authority and require the caller to own lifecycle and invariants. |
| Test stable | `ohm/testing` | Deterministic fixtures. Supported for tests, but not presented as production provider transports. |
| Metadata stable | `ohm/package.json` | Package metadata only. |

All five classes are covered by the compatibility rules below; “advanced” and “test” describe scope, not permission for silent breaking changes. No exported subpath is currently experimental. A future experimental entry point must say so in both its public declarations and documentation.

The advanced `ohm/storage` boundary exposes `SessionManager.openSnapshot(path, cwdOverride?)` for cross-session reads. It returns a `ReadonlySessionManager` capture, excludes writer methods from its type, and does not acquire the journal's writer slot. The capture contains only state committed when it opened; open another snapshot to observe later commits. A caller that bypasses the type with a cast still cannot commit through the snapshot at runtime.

`ohm/images` contains two deliberately separate surfaces: the clipboard/preprocessing helpers used by chat prompts and the image-generation provider/catalog/registry API. Image generation does not share or mutate the chat provider registry. See [Image generation](image-generation.md) for the credential, failure, retry, and lifecycle contracts.

The machine-readable source of this list is [`release/public-subpaths.json`](https://github.com/devsohm/ohm/blob/main/packages/ohm/release/public-subpaths.json), and the release check requires it to exactly match `package.json`.

The export map above describes ordinary consumers. Managed extension runtime entries can value-import all 21 code-bearing library entry points. They cannot value-import:

- the executable `ohm/rpc-entry`;
- the metadata-only `ohm/package.json`;
- an unlisted subpath;
- a deeper internal `ohm/*` path.

The allowed code-bearing entry points are `ohm`, `ohm/auth`, `ohm/config`, `ohm/context`, `ohm/core`, `ohm/embedding`, `ohm/extensions`, `ohm/images`, `ohm/interfaces`, `ohm/modes`, `ohm/net`, `ohm/process`, `ohm/prompts`, `ohm/providers`, `ohm/service`, `ohm/serve`, `ohm/sdk`, `ohm/storage`, `ohm/testing`, `ohm/tools`, and `ohm/tui`.

ohm resolves these specifiers to the running host. This keeps one canonical host instance when an installed extension lives outside ohm's dependency tree. Type-only authoring imports remain governed by TypeScript and the package export map.

Each JavaScript entry point is ESM-only and has a matching TypeScript declaration entry.

Adding an export is compatible within a minor release. Removing or renaming an entry point, export, method, required field, or accepted value is a breaking API change. Before 1.0, such a change requires a minor version increase. It also requires a `Breaking` section and migration instructions in the changelog. Patch releases must remain backward compatible. After 1.0, breaking changes require a major version.

The root also exposes documented aliases and thin adapters. See [Root API aliases and adapters](api-aliases.md) for their classification and native contracts.

Experimental behavior is not exempt merely because its TypeScript type is broad. An API is experimental only when its public documentation and declaration both say so. Deep imports, unpublished source paths, and test helpers outside `ohm/testing` have no compatibility guarantee.

## Named-export conformance

[`release/public-named-export-inventory.json`](https://github.com/devsohm/ohm/blob/main/packages/ohm/release/public-named-export-inventory.json) is the fixed compatibility baseline for every named binding on the 21 code-bearing entry points. It classifies each binding as a runtime value or a type-only declaration. Release tests fail on additions, removals, runtime/type classification changes, missing declarations, duplicate names, or an `any`/compiler-error type.

The distribution conformance test imports every entry point from the built package and compares its exact namespace keys with that baseline. It then uses every unique runtime identity: classes are exercised through inheritance (and exported error classes are constructed), constants are read according to their runtime kind, and ordinary functions are invoked in an isolated offline process with bounded settlement. Functions that own sessions, subprocesses, terminal state, keychain probing, or interactive modes instead receive deterministic contract fixtures with asserted results or owned cancellation behavior. The same test asks the TypeScript checker to resolve every runtime and type-only symbol from the built declarations.

This evidence supplements focused behavioral suites; it does not claim that a generic invalid-input probe replaces feature-specific tests. The route-level evidence inventory remains in [`release/public-runtime-export-inventory.json`](https://github.com/devsohm/ohm/blob/main/packages/ohm/release/public-runtime-export-inventory.json), while the named-export test prevents a public binding from being covered only by a filename or test-title substring.
