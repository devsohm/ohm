import { optionalProperties } from "../core/optional-properties.js";
import { createServeSessionRuntime } from "../serve/session-runtime.js";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import type { PluginCommandContextActions } from "../plugins/direct.js";
import type { RuntimeInlinePlugin } from "../plugins/runtime.js";
import {
  withGracefulTermination,
  type GracefulTerminationContext,
} from "../process/graceful-termination.js";
import {
  assertValidServeToken,
  startServeServer,
  type ServeSessionFactory,
  type ServeSessionRuntime,
} from "../serve/server.js";
import { SessionManager } from "../storage/session-manager.js";
import type { AgentSession, PluginBindings } from "../service/agent-session.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import {
  portablePresentationRemoveEvent,
  type PortablePresentationEvent,
} from "../interfaces/portable-presentation.js";
import {
  flagBoolean,
  flagPositiveSafeInteger,
  flagString,
  flagStrings,
  type ManagementArguments,
} from "./management-args.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import { loadRuntime } from "./runtime.js";
import { pluginResourceOptions } from "./plugin-flags.js";
import { resolveStartupSessionDirectory } from "./session-startup.js";

const DEFAULT_SERVE_HOST = "127.0.0.1";
const DEFAULT_SERVE_PORT = 4_317;
const LOOPBACK_SERVE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ServeCommandOptions {
  pluginFactories?: readonly RuntimeInlinePlugin[];
  projectTrustResolver?: ProjectTrustResolver;
  environment?: NodeJS.ProcessEnv;
  /** Optional caller-owned gate for model-requested tool effects in every served session. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

interface ProductServeFactoryOptions {
  baseWorkspace: string;
  environment: NodeJS.ProcessEnv;
  pluginFactories: readonly RuntimeInlinePlugin[];
  pluginPaths: readonly string[];
  pluginCode: boolean;
  skills: boolean;
  promptTemplates: boolean;
  themes: boolean;
  explicitPluginResources: { skills: boolean; prompts: boolean; themes: boolean };
  offline: boolean;
  toolAuthorizationHandler?: ToolAuthorizationHandler;
  projectTrustResolver?: ProjectTrustResolver;
  sessionDirectory?: string;
  requestShutdown(): void;
}

type ProductServeRuntime = Awaited<ReturnType<typeof loadRuntime>>;

function servePluginBindings(
  runtime: ProductServeRuntime,
  requestShutdown: () => void,
  rebindSubscriptions: (session: AgentSession) => void,
): PluginBindings {
  const commandContextActions: PluginCommandContextActions = {
    async waitForIdle(signal) {
      signal?.throwIfAborted();
      await runtime.session.waitForIdle();
      signal?.throwIfAborted();
    },
    async newSession(_options, signal) {
      signal?.throwIfAborted();
      return { cancelled: true };
    },
    async fork(_entryId, _options, signal) {
      signal?.throwIfAborted();
      return { cancelled: true };
    },
    async navigateTree(targetId, options, signal) {
      signal?.throwIfAborted();
      if (!runtime.session.isIdle) return { cancelled: true };
      const result = await runtime.session.navigateTree(targetId, options);
      signal?.throwIfAborted();
      return { cancelled: result.cancelled };
    },
    async switchSession(_sessionPath, _options, signal) {
      signal?.throwIfAborted();
      return { cancelled: true };
    },
    async refresh(signal) {
      signal?.throwIfAborted();
      try {
        await runtime.refresh({
          ...optionalProperties(signal === undefined ? undefined : { signal }),
          beforeSessionStart(session) {
            rebindSubscriptions(session);
            session.updatePluginBindings(servePluginBindings(runtime, requestShutdown, rebindSubscriptions));
          },
        });
      } finally {
        rebindSubscriptions(runtime.session);
      }
      signal?.throwIfAborted();
    },
  };
  return {
    mode: "serve",
    commandContextActions,
    shutdownHandler: requestShutdown,
    onError(error) {
      process.stderr.write(
        `${defaultSecretRedactor.redact(`Plugin error (${error.extensionPath}): ${error.error}`)}\n`,
      );
    },
  };
}

function serveToken(environment: NodeJS.ProcessEnv): string {
  const token = environment.OHM_SERVE_TOKEN;
  if (token === undefined) throw new Error("OHM_SERVE_TOKEN is required");
  try {
    assertValidServeToken(token);
  } catch (error) {
    throw new Error(
      `OHM_SERVE_TOKEN is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  defaultSecretRedactor.register(token);
  return token;
}

export function assertLoopbackServeHost(host: string): void {
  if (!LOOPBACK_SERVE_HOSTS.has(host)) {
    throw new Error("--host must be 127.0.0.1, localhost, or ::1; ohm serve does not provide TLS");
  }
}

function servePort(argumentsValue: ManagementArguments): number {
  const port = flagPositiveSafeInteger(argumentsValue, "port") ?? DEFAULT_SERVE_PORT;
  if (port > 65_535) throw new Error("--port must be an integer from 1 through 65535");
  return port;
}

async function existingWorkspace(path: string): Promise<string> {
  const candidate = resolve(path);
  const details = await stat(candidate);
  if (!details.isDirectory()) throw new Error(`Serve workspace is not a directory: ${candidate}`);
  return await realpath(candidate);
}

async function selectConfiguredServeModel(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  signal: AbortSignal,
): Promise<void> {
  const reference = runtime.session.model?.id ?? runtime.settings.getDefaultModel();
  if (reference === undefined) return;
  const provider = runtime.session.model?.provider ?? runtime.settings.getDefaultProvider();
  const model = await runtime.session.resolveModel(reference, {
    ...optionalProperties(provider === undefined ? undefined : { provider }),
    signal,
  });
  signal.throwIfAborted();
  await runtime.session.setModel(model);
}

function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveWait) => {
    signal.addEventListener("abort", () => resolveWait(), { once: true });
  });
}

async function createProductServeSessionFactory(
  options: ProductServeFactoryOptions,
): Promise<ServeSessionFactory> {
  const baseWorkspace = await existingWorkspace(options.baseWorkspace);

  const resolveWorkspace = async (requested: string | undefined): Promise<string> =>
    requested === undefined ? baseWorkspace : await existingWorkspace(requested);

  const sessionDirectoryFor = async (workspace: string): Promise<string | undefined> => {
    const projectTrusted = options.projectTrustResolver === undefined
      ? undefined
      : await options.projectTrustResolver.isTrusted(workspace);
    return await resolveStartupSessionDirectory(
      options.sessionDirectory === undefined ? {} : { sessionDir: options.sessionDirectory },
      workspace,
      {
        environment: options.environment,
        ...optionalProperties(projectTrusted === undefined ? undefined : { projectTrusted }),
      },
    );
  };

  const load = async (
    manager: SessionManager,
    sessionDirectory: string | undefined,
    signal: AbortSignal,
  ): Promise<ServeSessionRuntime> => {
    let runtime: Awaited<ReturnType<typeof loadRuntime>>;
    try {
      runtime = await loadRuntime({
        localObservabilityMode: "serve",
        signal,
        workspace: manager.getCwd(),
        sessionManager: manager,
        ...optionalProperties(sessionDirectory === undefined ? undefined : { sessionDirectory }),
        pluginCode: options.pluginCode,
        pluginPaths: options.pluginPaths,
        pluginFactories: options.pluginFactories,
        ...optionalProperties(options.projectTrustResolver === undefined ? undefined : { projectTrustResolver: options.projectTrustResolver }),
        skills: options.skills,
        promptTemplates: options.promptTemplates,
        themes: options.themes,
        explicitPluginResources: options.explicitPluginResources,
        pluginRuntime: true,
        offline: options.offline,
        ...optionalProperties(options.toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
      });
    } catch (error) {
      try {
        manager.closeV4Store();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Serve runtime loading and session cleanup failed",
        );
      }
      throw error;
    }
    try {
      runtime.setPluginShutdownHandler(options.requestShutdown);
      let modelReady = false;
      let modelSelection: Promise<void> | undefined;
      let closeFlight: Promise<void> | undefined;
      const subscriptionRebinds = new Set<(session: AgentSession) => void>();
      const subscriptions = new Set<() => void>();
      const retainSubscription = (rebind: (session: AgentSession) => void, detach: () => void) => {
        const unsubscribe = () => {
          if (!subscriptions.delete(unsubscribe)) return;
          subscriptionRebinds.delete(rebind);
          detach();
        };
        subscriptionRebinds.add(rebind);
        subscriptions.add(unsubscribe);
        return unsubscribe;
      };
      const rebindSubscriptions = (session: AgentSession) => {
        if (closeFlight !== undefined) return;
        for (const rebind of subscriptionRebinds) rebind(session);
      };
      const ensureModel = async (signal: AbortSignal): Promise<void> => {
        if (modelReady) return;
        modelSelection ??= selectConfiguredServeModel(runtime, signal);
        try {
          await modelSelection;
          modelReady = true;
        } finally {
          if (!modelReady) modelSelection = undefined;
        }
      };
      const close = (): Promise<void> => {
        closeFlight ??= (async () => {
          const failures: unknown[] = [];
          for (const unsubscribe of subscriptions) {
            try { unsubscribe(); } catch (error) { failures.push(error); }
          }
          try {
            await runtime.runtimePlugins.dispatch("session_shutdown", { reason: "quit" });
          } catch (error) {
            failures.push(error);
          }
          try {
            await runtime.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "Serve runtime shutdown failed");
          }
        })();
        return closeFlight;
      };
      return createServeSessionRuntime(() => runtime.session, {
        onEvent(listener) {
          let session = runtime.session;
          let detach = session.onEvent(listener);
          return retainSubscription((replacement) => {
            if (session === replacement) return;
            const nextDetach = replacement.onEvent(listener);
            detach();
            session = replacement;
            detach = nextDetach;
          }, () => detach());
        },
        onPortablePresentation(listener) {
          let session = runtime.session;
          const views = new Map<string, { owner: string; id: string; revision: number }>();
          const remember = (event: PortablePresentationEvent) => {
            const id = event.operation === "show" ? event.presentation.id : event.presentationId;
            const key = `${event.owner}\u0000${id}`;
            if (event.operation === "remove") views.delete(key);
            else views.set(key, { owner: event.owner, id, revision: event.presentation.revision });
          };
          const forward = (event: PortablePresentationEvent) => {
            remember(event);
            listener(event);
          };
          let detach = session.onPortablePresentation(forward);
          for (const event of session.listPortablePresentations()) remember(event);
          return retainSubscription((replacement) => {
            if (session === replacement) return;
            const nextDetach = replacement.onPortablePresentation(forward);
            detach();
            session = replacement;
            detach = nextDetach;
            // Generation revisions can restart. Remove old views before publishing
            // replacement snapshots, retaining only their identity metadata here.
            for (const view of views.values()) {
              listener(portablePresentationRemoveEvent(view.owner, view.id, view.revision));
            }
            views.clear();
            for (const event of replacement.listPortablePresentations()) forward(event);
          }, () => { detach(); views.clear(); });
        },
        async start(startSignal) {
          startSignal.throwIfAborted();
          await runtime.session.bindPlugins(
            servePluginBindings(runtime, options.requestShutdown, rebindSubscriptions),
            startSignal,
          );
          startSignal.throwIfAborted();
          if (runtime.session.suspendedRun !== undefined) {
            const recovery = await runtime.session.recoverInterruptedRun({ signal: startSignal });
            startSignal.throwIfAborted();
            if (!recovery.recovered) return;
          }
          startSignal.throwIfAborted();
          await ensureModel(startSignal);
        },
        async recoverInterruptedRun(recoveryOptions = {}) {
          const recovery = await runtime.session.recoverInterruptedRun(recoveryOptions);
          if (runtime.session.suspendedRun === undefined) {
            await ensureModel(recoveryOptions.signal ?? new AbortController().signal);
          }
          return recovery;
        },
        close,
      });
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  };

  return {
    async resolveWorkspace(workspace, signal) {
      signal.throwIfAborted();
      const resolved = await resolveWorkspace(workspace);
      signal.throwIfAborted();
      return resolved;
    },
    async create(request, signal) {
      signal.throwIfAborted();
      const workspace = request.workspace ?? baseWorkspace;
      const sessionDirectory = await sessionDirectoryFor(workspace);
      signal.throwIfAborted();
      return await load(
        SessionManager.create(workspace, sessionDirectory),
        sessionDirectory,
        signal,
      );
    },
    async open(request, signal) {
      signal.throwIfAborted();
      const workspace = request.workspace ?? baseWorkspace;
      const sessionDirectory = await sessionDirectoryFor(workspace);
      signal.throwIfAborted();
      const session = (await SessionManager.list(workspace, sessionDirectory))
        .find((candidate) => candidate.id === request.sessionId);
      signal.throwIfAborted();
      if (session === undefined) return undefined;
      return await load(
        SessionManager.open(session.path, sessionDirectory, workspace),
        sessionDirectory,
        signal,
      );
    },
  };
}

async function runServeOperation(
  argumentsValue: ManagementArguments,
  termination: GracefulTerminationContext,
  options: ServeCommandOptions,
): Promise<void> {
  if (argumentsValue.positionals.length > 0) {
    throw new Error("serve does not accept positional arguments");
  }
  const environment = options.environment ?? process.env;
  const token = serveToken(environment);
  const requestedHost = flagString(argumentsValue, "host") ?? DEFAULT_SERVE_HOST;
  assertLoopbackServeHost(requestedHost);
  const host = requestedHost === "localhost" ? DEFAULT_SERVE_HOST : requestedHost;
  const port = servePort(argumentsValue);
  const sessionDirectory = flagString(argumentsValue, "session-dir");
  const requestedShutdown = new AbortController();
  const sessionFactory = await createProductServeSessionFactory({
    baseWorkspace: flagString(argumentsValue, "workspace") ?? process.cwd(),
    environment,
    pluginFactories: options.pluginFactories ?? [],
    pluginPaths: flagStrings(argumentsValue, "plugin"),
    ...pluginResourceOptions({
      noPlugins: flagBoolean(argumentsValue, "no-plugins"),
      noPluginCode: flagBoolean(argumentsValue, "no-plugin-code"),
    }),
    offline: flagBoolean(argumentsValue, "offline")
      || /^(?:1|true|yes)$/iu.test(environment.OHM_OFFLINE ?? ""),
    ...optionalProperties(options.toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
    ...optionalProperties(options.projectTrustResolver === undefined ? undefined : { projectTrustResolver: options.projectTrustResolver }),
    ...optionalProperties(sessionDirectory === undefined ? undefined : { sessionDirectory }),
    requestShutdown() {
      requestedShutdown.abort(new Error("Serve shutdown requested by an extension"));
    },
  });
  termination.throwIfTerminated();
  const server = await startServeServer({ host, port, token, sessionFactory });
  const uninstallTermination = termination.onTerminate(() => {
    void server.close().catch(() => undefined);
  });
  try {
    writeMachineOutput(`ohm serve listening at ${server.origin}\n`);
    await waitForShutdown(AbortSignal.any([termination.signal, requestedShutdown.signal]));
  } finally {
    uninstallTermination();
    await server.close();
  }
}

export async function runServeCommand(
  argumentsValue: ManagementArguments,
  options: ServeCommandOptions = {},
): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await runServeOperation(argumentsValue, termination, options);
  });
}
