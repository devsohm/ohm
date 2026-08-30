import { OHM_VERSION } from "../version.js";

const header = `ohm ${OHM_VERSION} — agent harness with read, bash, edit, write, grep, find, and ls tools`;

const GLOBAL = `${header}

Usage:
  ohm [OPTIONS] [@FILES...] [MESSAGES...]

Commands:
  ohm install SOURCE [-l]      Install a package; add --allow-scripts only after review
  ohm remove SOURCE [-l]       Remove an installed package
  ohm update [SOURCE] [--all]  Update one or all installed packages
  ohm list                     List installed packages
  ohm packages check           Check the trusted project declaration and immutable lock
  ohm packages update --all    Intentionally resolve, lock, and reconcile project packages
  ohm extensions doctor        Diagnose discovered extension resources
  ohm extensions author report Verify a local extension package without installing it
  ohm sessions doctor          Validate the canonical JSONL session files
  ohm diagnostics [FILE]       Create a local redacted support bundle
  ohm logs [--json]            Locate private local operational logs
  ohm stats [--json]           Summarize local aggregate usage and failures
  ohm completions bash|zsh|fish
                                 Generate a static shell completion script
  ohm serve                    Run the authenticated HTTP and SSE service
  ohm config [-l]              Configure package resources
  ohm config path [--scope user|project]
                                 Print the exact settings path
  ohm config edit [--scope user|project]
                                 Safely edit user or trusted-project settings
  ohm config validate [--scope user|project]
                                 Validate settings without changing files
  ohm self-install             Install a source-built private user copy
  ohm self-update              Update that copy; standalone prints its installer command
  ohm uninstall --yes          Fully remove the installed copy and its managed state
  ohm COMMAND --help           Show command-specific help

Model:
      --provider NAME       Provider name
      --model PATTERN       Model ID or provider/model pattern
      --models LIST         Comma-separated exact provider/model scope
      --api-key KEY         API key for this invocation; not persisted
      --thinking LEVEL      off|minimal|low|medium|high|xhigh|max

Sessions:
  -c, --continue            Continue the most recent project session
  -r, --resume              Select a session to resume
      --session REF         Resume a session by exact or partial ID
      --session-id ID       Use this exact project session ID, creating it if needed
      --fork REF            Fork a saved session
      --session-dir DIR     Store and find sessions under DIR
      --workspace DIR       Use DIR as the project workspace
      --all                 With continue/resume/session, search every workspace
      --no-session          Do not save this session
  -n, --name NAME           Set the session display name

Tools and resources:
  -t, --tools LIST          Comma-separated tool allowlist
  -nt, --no-tools           Disable all built-in and extension tools
  -nbt, --no-builtin-tools  Disable built-ins; keep extension tools enabled
  -xt, --exclude-tools LIST Disable selected tools
  -e, --extension PATH      Load an extension; repeatable
  -ne, --no-extensions      Disable automatic extension discovery
      --skill PATH          Load a skill file or directory; repeatable
  -ns, --no-skills          Disable automatic skill discovery
      --prompt-template PATH  Load a prompt template file or directory; repeatable
  -np, --no-prompt-templates  Disable automatic prompt discovery
      --system-prompt TEXT    Replace the built-in system prompt for this invocation
      --append-system-prompt TEXT
                              Append text to the active system prompt
      --theme PATH          Load a theme file or directory; repeatable
      --no-themes           Disable automatic theme discovery
  -nc, --no-context-files   Disable global and project instruction-file discovery

Other:
  -p, --print               Process messages non-interactively and exit
      --mode MODE           Output mode: text, json, or rpc
      --list-models [TEXT]  List models from connected providers and exit
      --export SESSION.jsonl [OUTPUT.html]
                            Convert a saved session to standalone HTML and exit
      --redact              With --export, write a review-required sharing copy
      --no-browser          Print OAuth URLs instead of opening a browser
      --max-steps NUMBER    Maximum model turns in each run
      --max-output-tokens NUMBER
                            Maximum output tokens requested from the model
      --allow-scripts       Run reviewed dependency lifecycle scripts for package install/update
  -a, --approve             Trust project-local resources for this invocation
  -na, --no-approve         Ignore project-local resources for this invocation
      --offline             Disable automatic network refresh/resolution; moving updates fail
      --verbose             Show expanded startup details, overriding quietStartup
  -h, --help                Show this help
  -v, --version             Show version

Examples:
  ohm
  ohm "Read package.json and explain the scripts"
  ohm @issue.md "Implement this change"
  ohm -p "List all TypeScript files under src"
  ohm --continue "Continue the previous task"
  ohm --session SESSION_ID "Continue a saved task"
  ohm --export session.jsonl conversation.html
  ohm --model openai/gpt-5.4-mini --thinking high "Fix the failing tests"
  ohm --tools read,grep,find,ls -p "Review this repository"
`;

const PACKAGE_SOURCE = "SOURCE may be a local directory, npm:SPEC, or an HTTPS/SSH Git repository. Git refs may follow # or the repository path's final @.";

const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  install: `${header}

Usage:
  ohm install SOURCE [-l] [--allow-scripts]

Installs a package for the current user. Use -l to install it for the current project.
${PACKAGE_SOURCE}
Dependency lifecycle scripts remain disabled unless --allow-scripts is provided.
`,
  remove: `${header}

Usage:
  ohm remove SOURCE [-l]

Removes an installed package. Use -l for the current project.
`,
  uninstall: `${header}

Usage:
  ohm uninstall --yes
  ohm self-uninstall --yes

Fully removes the installed product, including its saved configuration,
credentials, sessions, logs, cache, versioned runtimes, and managed command.
Ownership checks prevent removal of a source checkout, project workspace,
external agent-directory override, or unmanaged command.
`,
  "self-install": `${header}

Usage:
  ohm self-install

Builds or installs an independent source-built copy under ~/.ohm without
linking it to the source checkout or using npm's global package directory.
This command is unavailable inside a standalone release.
`,
  "self-update": `${header}

Usage:
  ohm self-update

For a source-built private installation, downloads the latest verified ohm
GitHub release and atomically replaces the application while preserving user
configuration and state. An implicit update never replaces a newer installation
with an older release. A standalone archive instead updates by rerunning the
one-line installer; this command reports that exact verified invocation without
changing the installed runtime.
`,
  "self-uninstall": `${header}

Usage:
  ohm self-uninstall --yes

Alias for the full product uninstall command.
`,
  update: `${header}

Usage:
  ohm update SOURCE [-l] [--allow-scripts]
  ohm update --all [-l] [--allow-scripts]

--allow-scripts applies only to this update transaction's production dependencies.
`,
  list: `${header}

Usage:
  ohm list [-l] [--json]
`,
  packages: `${header}

Usage:
  ohm packages check [--approve]
  ohm packages reconcile [--approve]
  ohm packages update ID... [--approve]
  ohm packages update --all [--approve]

Reads .ohm/packages.json only after workspace trust. Update intentionally
resolves moving npm, Git, and approved local sources and atomically writes an
immutable lock. Reconcile installs only exact locked versions, revisions, and
digests; it never updates moving sources or enables lifecycle scripts.
`,
  extensions: `${header}

Usage:
  ohm extensions [list|doctor|commands|prompts]
  ohm extensions show ID
  ohm extensions author validate|inspect|smoke|refresh|report PACKAGE
  ohm extensions author pack PACKAGE DESTINATION
  ohm extensions author index GALLERY.json
  ohm extensions install SOURCE [-l] [--allow-scripts]
  ohm extensions remove SOURCE [-l]
  ohm extensions update SOURCE [-l] [--allow-scripts]

Inspects discovered resources, verifies extension packages without installing them,
or delegates package management actions. Doctor activates already-trusted extension
code and may initialize runtime state; use --offline unless its network behavior is
explicitly required. Author checks use the same bounded package
staging and in-process public runtime loader as the host. Pack requires package.json.
For author pack, DESTINATION is a directory; the JSON result reports the exact
artifact filename and SHA-256 digest.
Dependency lifecycle scripts remain disabled unless --allow-scripts is provided.
`,
  config: `${header}

Usage:
  ohm config [-l]
  ohm config path [--scope user|project] [--json]
  ohm config edit [--scope user|project]
  ohm config validate [--scope user|project] [--json]

Without an action, opens package resource configuration for user or project scope.
Path reports the exact settings file without creating it. Edit opens the selected
file externally, validates its JSON object, and commits only if the file did not
change concurrently. Validate checks every known setting in the selected merged
scope without writing or creating files. Project edits and validation require
workspace trust. Persistent settings live in ~/.ohm/config.json and
WORKSPACE/.ohm/config.json.
`,
  diagnostics: `${header}

Usage:
  ohm diagnostics [FILE] [--workspace DIR]

Collects bounded local configuration/resource status and operation timings as
JSON. It never reads credential values or session content. It also does not
read operational log records or crash reports, and it omits configuration
values and resource bodies. When FILE is given, creation is exclusive and
owner-only; an existing file is never replaced.
`,
  logs: `${header}

Usage:
  ohm logs [--json]

Shows the configured local observability level and metadata for recognized
private JSONL log files. It also reports bounded metadata for redraw diagnostics,
requested support files, crashes, and sessions. It does not read or print file
contents. Runtime observability defaults to bounded metadata-only debug records.
ohm never sends these logs or aggregate metrics to a remote service.
`,
  stats: `${header}

Usage:
  ohm stats [--json]

Summarizes bounded, metadata-only aggregate snapshots from private local logs.
It reports runs, main model attempts, usage when supported, retries, compactions,
and tool failures. JSON source.processes counts retained runtime-observer
streams, not operating-system processes. No session or message content is read
into the report, and nothing is uploaded.
`,
  sessions: `${header}

Usage:
  ohm sessions doctor [--json] [--all] [--workspace DIR] [--session-dir DIR]

Doctor opens every discovered JSONL session and validates its header and entry
tree. It does not rewrite journals or print message and tool content. Sessions
are direct files; there is no database index or repair command. Without an
explicit directory, doctor uses the normal CLI, environment, and trusted-config
session-directory precedence. --all scans every workspace in the default root,
or every session in the resolved custom directory.
`,
  rpc: `${header}

Usage:
  ohm --mode rpc [OPTIONS]

Runs newline-delimited JSON RPC over standard input and output. Diagnostics and
human-readable status remain on standard error so protocol output stays valid.
`,
  serve: `${header}

Usage:
  ohm serve [--host HOST] [--port PORT] [--workspace DIR] [--session-dir DIR]
              [--approve | --no-approve] [--offline] [--no-extensions]
              [--extension PATH ...]

Runs an authenticated HTTP and SSE service over the canonical agent runtime.
The default address is 127.0.0.1:4317. Set OHM_SERVE_TOKEN to a secret with
at least 32 bytes. The token is never accepted as a command-line argument. New
sessions use the configured default model.
`,
  completions: `${header}

Usage:
  ohm completions bash|zsh|fish

Prints a deterministic completion script to standard output without loading
providers, models, sessions, extensions, or the agent runtime.

Load it in the current shell:
  Bash: source <(ohm completions bash)
  Zsh:  source <(ohm completions zsh)
  Fish: ohm completions fish | source
`,
});

export function renderCliHelp(command?: string): string {
  if (command === undefined || command === "help" || command === "run" || command === "chat") return GLOBAL;
  const value = COMMAND_HELP[command];
  if (value === undefined) throw new Error(`Unknown help topic: ${command}`);
  return value;
}
