# Starter extension

This is the smallest runnable, typechecked ohm package and a starter for a distributable extension. It registers:

- the `/example-hello` command;
- the `example_text_length` model tool.

The bundled example is `private` to prevent accidental publication from the ohm repository. A distributable copy should use its own package name and remove `private` only when it is ready to publish. The declared `peerDependencies.ohm` range is the host compatibility gate and prevents a nested ohm runtime.

From this package directory, test callback behavior and then exercise the real package loader without installing it:

```text
npm test
ohm extensions author report .
```

`npm test` typechecks `extensions/index.ts`, then `checks/runtime.test.mjs` uses only Node's test runner and the public extension factory shape. The author report adds validation, staged activation/disposal, and valid-candidate refresh checks.

From the ohm source checkout:

```text
ohm install ./packages/ohm/examples/starter
```

Run `/refresh`, then enter `/example-hello Ada`.

Use `ohm list --json` to find the installed package ID. Remove it with
`ohm remove SOURCE`.

The package has no network, process, credential, or filesystem authority.
