# Task prompts

An optional, prompt-only package: three Markdown templates declared through
`ohm.prompts`. It contains no executable code or globally enabled commands
and does not change the core system prompt.

From the repository root, try it for one invocation without installing:

```sh
ohm --prompt-template ./packages/ohm/examples/task-prompts/prompts
```

For a persistent, trusted project installation, run:

```sh
ohm plugins install ./packages/ohm/examples/task-prompts -l
```

Then start ohm or run `/refresh` in an existing session. Omitting `-l` selects
the current user's package scope, not the project. Use `ohm plugins prompts`
to inspect discovered templates. Relative package paths are resolved from the
directory where you run the install command.

```text
/review-change
/review-change "src/storage" "cancellation and durability"
/diagnose-issue "resume opens an empty session" "src/storage"
/implement-change "reject an invalid history cursor" "src/storage"
```

| Command | Missing arguments |
| --- | --- |
| `/review-change [SCOPE] [FOCUS]` | Reviews tracked staged and unstaged changes against `HEAD`; focuses on correctness, regressions, and data safety. Untracked files are excluded. |
| `/diagnose-issue "SYMPTOM" [SCOPE]` | Asks for the missing symptom; scope defaults to the current workspace. |
| `/implement-change "OUTCOME" [SCOPE]` | Asks for the missing outcome; scope defaults to the current workspace. |

Quote each argument containing spaces with single or double quotes. Arguments
after the first two become additional context. Substitution happens once:
placeholder-looking text supplied as an argument remains literal. Arguments
are task descriptions, not shell commands.

Review and diagnosis request read-only investigation, not implementation.
Implementation permits only the requested scoped edits and relevant checks;
it does not authorize commits, publishing, destructive changes, or external
writes. These are model instructions, not tool restrictions or a sandbox.
Normal host permissions still apply, and model requests may incur provider costs.

In a source checkout with the ohm workspace dependencies available, run:

```sh
npm test --prefix packages/ohm/examples/task-prompts
```

The tests use public loaders and rendering APIs, make no model requests, and
check names, defaults, quoted arguments, one-pass substitution, and the
read-versus-edit boundaries. Runtime resources are declarative Markdown;
`checks` contains verification code executed only when you run the test command
and is included in the package archive.
