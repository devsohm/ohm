# Starter plugin

Start here to make your first runtime plugin. This package registers:

- `/example-hello Ada`, which shows `Hello, Ada.` without a model request;
- `example_text_length`, a model tool that counts Unicode code points in a
  string of at most 4,096 characters.

## Create and test your copy

You need ohm, Node.js, and npm available in your terminal. Run this from the
existing directory where you want to create the plugin. `my-plugin` must not
already exist:

```sh
ohm plugins init ./my-plugin
cd my-plugin
```

`init` copies this starter and sets its package name to `my-plugin`. It does
not install dependencies or activate the plugin. Review these files first:

| File | What to change |
| --- | --- |
| `src/index.ts` | The command and tool registrations |
| `checks/runtime.test.mjs` | Their expected behavior |
| `package.json` | Package name, dependencies, supported ohm versions, and entry path |

Then, still inside `my-plugin`, install the four verified package archives from
the same ohm release, following [SDK package installation](https://github.com/devsohm/ohm/blob/main/packages/ohm/docs/sdk.md#install-the-public-package-graph).
Pass `--ignore-scripts --no-save` to that `npm install` command. It also installs
this starter's declared development dependencies. A global `ohm` executable
does not make its types available to a local TypeScript project, and the ohm
package graph is distributed through GitHub Releases rather than npm.

Run the checks after installation:

```sh
ohm plugins test .
```

Expect a successful report with two passing behavior tests after TypeScript
checks the factory. The command runs the package's explicit `scripts.test`;
it does not install missing dependencies. For this starter, `npm test` runs
the same typecheck and tests directly. The tests exercise the callbacks with a
small fake host, so no credentials or model calls are needed.

## Try it in the real host

From the same directory, open an interactive preview:

```sh
ohm plugins preview .
```

At the ohm prompt, enter:

```text
/example-hello Ada
```

You should see `Hello, Ada.`. With no argument, the command greets
`developer`. This is a plugin command, not a prompt sent to a model.

For your first edit, change the greeting in `src/index.ts` and its
expected value in `checks/runtime.test.mjs`. Run `ohm plugins test .` in
another terminal **inside `my-plugin`**, then enter `/refresh` in the preview
and invoke `/example-hello Ada` again. `/exit` closes the preview and disposes
the plugin generation.

The preview workspace is your shell's current directory; the package argument
only selects what to load. To try the plugin against another workspace, run
`ohm plugins preview /absolute/path/to/my-plugin` from that workspace.
Preview requires a terminal. Add `--json` to inspect its invocation without
starting it.

Preview does not install the package or save a session. It disables automatic
plugin and network discovery, but is **not a sandbox or a network block**:
plugin code and ordinary model prompts still have their normal capabilities.
This starter's callbacks perform no network, process, credential, or file I/O.

## Add resources and UI to the same plugin

Keep the existing factory when you add a prompt, skill, theme, or UI. Declare
fixed resource paths beside `ohm.entrypoints` in the same `package.json`:

```json
{
  "ohm": {
    "entrypoints": ["src/index.ts"],
    "prompts": ["prompts"],
    "skills": ["skills"],
    "themes": ["themes"]
  }
}
```

Create the corresponding files using the [prompt](https://github.com/devsohm/ohm/blob/main/packages/ohm/docs/prompt-templates.md#make-one-prompt),
[skill](https://github.com/devsohm/ohm/blob/main/packages/ohm/docs/skills.md#directory-shape-and-frontmatter), and
[theme](https://github.com/devsohm/ohm/blob/main/packages/ohm/docs/themes.md#semantic-token-format) formats. No extra factory or
registration call is needed for fixed resource paths. Add UI in the existing
command or an event callback; check `context.ui.capabilities` before selecting a
surface, as the [UI surfaces example](https://github.com/devsohm/ohm/blob/main/packages/ohm/examples/ui-surfaces/README.md) demonstrates.

Run `ohm plugins verify .`, preview the package, then use `/resources` to inspect
the loaded resources. Invoke prompts as `/NAME`, skills as `/skill:NAME`, and
select a custom theme through `/settings`. Prompt and skill invocations send a
model request; the starter command remains an explicit callback. Use `/refresh`
after editing any of the package's resources.

## Check the distributable package

Back in your shell, inside `my-plugin`, run:

```sh
ohm plugins verify .
```

Expect successful `validate`, `inspect`, `smoke`, `refresh`, and `packed`
checks. These validate the package, inspect its archive, activate and dispose
its factories, and check generation replacement in both source and a temporary
packed installation. They do not replace the behavior tests or publish
anything. Verification uses cached npm dependencies and disables install
lifecycle scripts; a missing cache entry can make the packed check fail.

Both the bundled starter and an initialized copy are `private` to prevent
accidental publication. Use your own package name, keep `peerDependencies.ohm`
as the supported-host compatibility range, and remove `private` only when
you intend to publish. The plugin uses the host's runtime; do not bundle a
second ohm runtime.
