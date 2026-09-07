import { optionalProperties } from "../core/optional-properties.js";
import { resolve } from "node:path";

import type { Api, Model } from "@ohm/models";

import { getAgentDir } from "../config/paths.js";
import {
	DefaultResourceLoader,
	type ResourcePluginsResult,
	type ResourceLoader,
} from "../core/resource-loader.js";
import {
	RuntimeObservability,
	resolveObservabilityLevel,
	type ObservabilitySink,
} from "../core/observability.js";
import { SettingsManager, type ThinkingLevel } from "../core/settings-manager.js";
import { runtimeDiscoveryView } from "../core/runtime-discovery.js";
import type { SessionStartEvent } from "../plugins/direct.js";
import {
	ensurePluginRuntimeHost,
	getPluginRuntimeHost,
} from "../plugins/compat.js";
import {
	protocolFromPublicApi,
} from "../plugins/model-boundary.js";
import {
	bindDirectProviderWireLifecycle,
	directToolRendererBinding,
	type RuntimePluginHost,
} from "../plugins/runtime.js";
import { providerAdapterFromModels } from "../providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../providers/model-compat.js";
import { modelRuntimeForInternalRegistry } from "../providers/model-runtime-ownership.js";
import type { ProviderModel } from "../providers/models.js";
import { ModelRegistry as PublicModelRegistry } from "../providers/public-model-registry.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { ProviderWireLifecycleHost } from "../providers/wire.js";
import { AgentSession } from "../service/agent-session.js";
import {
	deferAgentSessionSelection,
} from "../service/agent-session-owner.js";
import { getDefaultSessionDir, SessionManager } from "../storage/session-manager.js";
import { allToolNames } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/backend.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import { customToolInventory } from "../tools/custom-tool-inventory.js";
import {
	createHarnessToolFromDefinition,
	isHarnessTool,
	type AgentSessionTool,
} from "../tools/direct-tool.js";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd(). */
	cwd?: string;
	/** Global configuration directory. Default: ~/.ohm. */
	agentDir?: string;
	/** Canonical model/auth runtime. */
	modelRuntime?: PublicModelRegistry | ModelRuntime;
	/** Lifecycle host already connected to a caller-owned model transport. */
	providerWireLifecycle?: ProviderWireLifecycleHost;
	/** Initial model. Restored session state and configured defaults are used when omitted. */
	model?: ProviderModel | Model<Api>;
	/** Exact provider/model allowlist for this session; an empty list means all models. */
	modelScope?: readonly string[];
	/** Initial thinking level. */
	thinkingLevel?: ThinkingLevel;
	/** Suppress every tool, or only the default built-ins. */
	noTools?: "all" | "builtin";
	/** Exact active-tool allowlist. */
	tools?: string[];
	/** Tool names removed after the allowlist/default policy. */
	excludeTools?: string[];
	/** Custom tools registered alongside built-ins and extension tools. */
	customTools?: AgentSessionTool[];
	/** Optional host-owned execution boundary for the tools it explicitly claims. */
	toolBackend?: ToolExecutionBackend;
	/** Optional host-owned gate for model-requested tool effects. */
	toolAuthorizationHandler?: ToolAuthorizationHandler;
	/** Resource loader. Default: DefaultResourceLoader with normal discovery. */
	resourceLoader?: ResourceLoader;
	/** Session manager. Default: a new persistent session for cwd. */
	sessionManager?: SessionManager;
	/** Settings manager. Default: SettingsManager.create(cwd, agentDir). */
	settingsManager?: SettingsManager;
	/** Metadata supplied to the initial extension session_start event. */
	sessionStartEvent?: SessionStartEvent;
	/** Caller-owned destination for metadata-only records. Omit to keep SDK sessions silent. */
	observabilitySink?: ObservabilitySink;
}

export type LoadPluginsResult = ResourcePluginsResult;

export interface CreateAgentSessionResult {
	session: AgentSession;
	pluginsResult: LoadPluginsResult;
	modelFallbackMessage?: string;
}

const STABLE_DEFAULT_MODEL = "gpt-5.6-sol";

function publicRuntime(value: PublicModelRegistry | ModelRuntime): ModelRuntime {
	return value instanceof ModelRuntime
		? value
		: modelRuntimeForInternalRegistry(value.internalRegistry());
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function findConfiguredModel(
	models: readonly Model<Api>[],
	settings: SettingsManager,
): Model<Api> | undefined {
	const provider = settings.getDefaultProvider();
	const id = settings.getDefaultModel();
	if (id === undefined) return undefined;
	return models.find((model) => model.id === id && (provider === undefined || model.provider === provider));
}

function stableDefault(models: readonly Model<Api>[]): Model<Api> | undefined {
	return models.find((model) => model.provider === "openai-codex" && model.id === STABLE_DEFAULT_MODEL)
		?? models.find((model) => model.provider === "openai" && model.id === STABLE_DEFAULT_MODEL)
		?? models.find((model) => model.id === STABLE_DEFAULT_MODEL);
}

function implicitDefault(models: readonly Model<Api>[]): Model<Api> | undefined {
	return stableDefault(models)
		?? models[0];
}

/** Create one directly composed AgentSession without terminal ownership. */
export async function createAgentSession(
	options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const cwd = resolve(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const settings = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const ownedModelRuntime = options.modelRuntime === undefined
		? await ModelRuntime.create({
			authPath: resolve(agentDir, "auth.json"),
			modelsPath: resolve(agentDir, "model-providers.json"),
		})
		: undefined;
	const modelRuntime = ownedModelRuntime ?? publicRuntime(options.modelRuntime!);
	const models = modelRuntime.models();
	const providers = new ProviderRegistry(
		models.getProviders().map((provider) => providerAdapterFromModels(models, provider.id)),
	);
	const manager = options.sessionManager
		?? SessionManager.create(cwd, settings.getSessionDir() ?? getDefaultSessionDir(cwd, agentDir));
	const loader = options.resourceLoader ?? new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
	let session: AgentSession | undefined;
	let pluginsResult: ResourcePluginsResult | undefined;
	let observability: RuntimeObservability | undefined;
	const wireCleanups = new Set<() => void>();
	let ownedPluginHost: RuntimePluginHost | undefined;
	let servicesDisposed = false;
	const disposeServices = async (): Promise<void> => {
		if (servicesDisposed) return;
		servicesDisposed = true;
		const failures: unknown[] = [];
		for (const cleanup of wireCleanups) {
			try { cleanup(); }
			catch (error) { failures.push(error); }
		}
		wireCleanups.clear();
		try { await ownedPluginHost?.close(); }
		catch (error) { failures.push(error); }
		try { await observability?.close(); }
		catch (error) { failures.push(error); }
		try { await ownedModelRuntime?.close(); }
		catch (error) { failures.push(error); }
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "SDK session cleanup failed");
	};
	try {
		if (options.providerWireLifecycle !== undefined && options.modelRuntime === undefined) {
			throw new Error("providerWireLifecycle requires a caller-supplied modelRuntime");
		}
		if (options.resourceLoader === undefined) await loader.refresh();
		pluginsResult = loader.getPlugins();
		const suppliedHost = getPluginRuntimeHost(pluginsResult.runtime);
		const pluginHost = suppliedHost ?? ensurePluginRuntimeHost(pluginsResult.runtime, cwd);
		if (options.resourceLoader === undefined || suppliedHost === undefined) ownedPluginHost = pluginHost;
		const configureHost = (host: RuntimePluginHost): void => {
			if (options.resourceLoader === undefined) ownedPluginHost = host;
			host.setDirectDiscoveryHandler((signal) => {
				signal?.throwIfAborted();
				return runtimeDiscoveryView(host, loader);
			});
			if (options.providerWireLifecycle === undefined) return;
			const cleanup = bindDirectProviderWireLifecycle(host, options.providerWireLifecycle);
			wireCleanups.add(cleanup);
			host.addRegistrationCleanup(() => {
				wireCleanups.delete(cleanup);
				cleanup();
			});
		};
		configureHost(pluginHost);
		observability = options.observabilitySink === undefined
			? undefined
			: new RuntimeObservability(options.observabilitySink, {
				mode: "sdk",
				level: resolveObservabilityLevel(settings.getObservabilityLevel()),
				closeSink: false,
			});
		const customInputs = options.customTools ?? [];
		const custom = customToolInventory(customInputs);
		const harnessTools = customInputs.map((tool) => isHarnessTool(tool)
			? tool
			: createHarnessToolFromDefinition(tool, () => {
				if (session === undefined) throw new Error("SDK tool context is not ready");
				return session.createReplacedSessionContext();
			}));
		const renderer = directToolRendererBinding(
			custom.direct,
			cwd,
			(diagnostic) => pluginHost?.addDiagnostic({
				extensionId: "sdk",
				sourcePath: "<sdk:custom-tool>",
				message: diagnostic.message,
			}),
		);
		const callerNames = custom.names;
		const extensionToolNames = pluginHost.tools().map((tool) => tool.definition.name);
		const explicitToolPolicy = options.tools !== undefined
			|| options.noTools !== undefined
			|| options.excludeTools !== undefined;
		const selectedNames = options.tools !== undefined
			? options.tools
			: options.noTools === "all"
				? []
				: options.noTools === "builtin"
					? [...callerNames, ...extensionToolNames]
					: [...allToolNames, ...callerNames, ...extensionToolNames];
		session = await AgentSession.create({
			sessionManager: manager,
			providers,
			modelRegistry: modelRuntime.internalRegistry(),
			...optionalProperties(options.providerWireLifecycle === undefined ? undefined : { providerWireLifecycle: options.providerWireLifecycle }),
			resourceLoader: loader,
			pluginsResult,
			workspace: cwd,
			agentDirectory: agentDir,
			settingsManager: settings,
			projectTrusted: settings.isProjectTrusted(),
			...optionalProperties(observability === undefined ? undefined : { observability }),
			...optionalProperties(harnessTools.length === 0 ? undefined : { tools: harnessTools }),
			...optionalProperties(renderer === undefined ? undefined : { toolRendererBinding: renderer }),
			...optionalProperties(explicitToolPolicy ? {
				initialToolSelection: {
					names: [...new Set(selectedNames)],
					excludedNames: [...new Set(options.excludeTools ?? [])],
					activatePluginToolsOnBind: options.tools === undefined && options.noTools !== "all",
				},
			} : undefined),
			...optionalProperties(options.toolBackend === undefined ? undefined : { toolBackend: options.toolBackend }),
			...optionalProperties(options.toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
			...optionalProperties(options.modelScope === undefined ? undefined : { modelScope: options.modelScope }),
			...optionalProperties(options.sessionStartEvent === undefined ? undefined : { sessionStartEvent: options.sessionStartEvent }),
			refresh: async () => {
				const host = getPluginRuntimeHost(loader.getPlugins().runtime);
				if (host !== undefined) configureHost(host);
			},
		}, { dispose: disposeServices });
		const activeSession = session;

		const persistedSelection = manager.getPersistedSelection();
		const persisted = persistedSelection.model;
		const missingPersisted = persisted !== null && session.nativeModel === undefined;
		const available = modelRuntime.getAvailableSnapshot()
			.filter((model) => activeSession.isModelInScope(model.provider, model.id));
		const configuredCandidate = findConfiguredModel(modelRuntime.getModels(), settings);
		const configured = configuredCandidate !== undefined
			&& session.isModelInScope(configuredCandidate.provider, configuredCandidate.id)
			? configuredCandidate
			: undefined;
		const restoredInScope = session.model !== undefined
			&& session.isModelInScope(session.model.provider, session.model.id);
		const selected = options.model
			?? (restoredInScope ? undefined : configured)
			?? (restoredInScope ? undefined : implicitDefault(available));
		if (selected === undefined && !restoredInScope && session.modelScopeSelectors.length > 0) {
			throw new Error(`No available model matches the active scope: ${session.modelScopeSelectors.join(", ")}`);
		}
		const thinkingModel = selected ?? (restoredInScope ? session.model : undefined);
		const selectedModelThinking = selected === undefined || thinkingModel === undefined
			? undefined
			: settings.getModelThinkingLevel(thinkingModel.provider, thinkingModel.id);
		const requestedThinking = options.thinkingLevel
			?? selectedModelThinking
			?? (persistedSelection.hasPersistedThinking
				? session.thinkingLevel
				: thinkingModel === undefined
					? settings.getDefaultThinkingLevel() ?? "medium"
					: settings.getModelThinkingLevel(thinkingModel.provider, thinkingModel.id)
						?? settings.getDefaultThinkingLevel()
						?? "medium");
		if (session.suspendedRun === undefined) {
			if (selected !== undefined) await session.setModel(selected);
			session.setThinkingLevel(requestedThinking);
		} else {
			const restoredModel = session.model;
			const pendingModel = selected === undefined || (
				restoredModel !== undefined &&
				restoredModel.provider === selected.provider &&
				restoredModel.id === selected.id &&
				protocolFromPublicApi(restoredModel.api) === protocolFromPublicApi(selected.api)
			) ? undefined : selected;
			deferAgentSessionSelection(session, {
				...optionalProperties(pendingModel === undefined ? undefined : { model: pendingModel }),
				...optionalProperties(requestedThinking === session.thinkingLevel ? undefined : { thinkingLevel: requestedThinking }),
			});
		}
		if (options.resourceLoader === undefined) await session.bindPlugins({ mode: "sdk" });

		const fallbackModel = session.model ?? (session.suspendedRun === undefined ? undefined : selected);
		const fallback = missingPersisted && fallbackModel !== undefined
			? `Could not restore model ${persisted.provider}/${persisted.modelId}. Using ${modelKey(fallbackModel)}.`
			: undefined;
		return {
			session,
			pluginsResult,
			...optionalProperties(fallback === undefined ? undefined : { modelFallbackMessage: fallback }),
		};
	} catch (error) {
		if (session !== undefined) await session.close().catch(() => undefined);
		else manager.closeV4Store();
		if (session === undefined) {
			pluginsResult?.runtime.invalidate("Plugin runtime disposed after SDK construction failure");
		}
		await disposeServices().catch(() => undefined);
		throw error;
	}
}

export { AgentSession, parseSkillBlock } from "../service/agent-session.js";
export type {
	AgentSessionAgent,
	AgentSessionAgentState,
	AgentSessionBashResult,
	AgentSessionConfig,
	AgentSessionEnvelopeListener,
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionInputImage,
	AgentSessionModel,
	AgentSessionModelCycleOptions,
	AgentSessionModelCycleResult,
	AgentSessionModelMutationOptions,
	AgentSessionOptions,
	AgentSessionOwnership,
	AgentSessionRefreshOptions,
	AgentSessionPromptOptions,
	AgentSessionReplacedContext,
	AgentSessionRun,
	AgentSessionState,
	AgentSessionStats,
	AgentSessionToolInfo,
	AgentSessionTreeNavigationResult,
	AgentSessionUsageBreakdownEntry,
	PluginBindings,
	ParsedSkillBlock,
	PromptOptions,
	SessionStats,
} from "../service/agent-session.js";
export { SessionManager } from "../storage/session-manager.js";
export type { ReadonlySessionManager } from "../storage/session-manager.js";
export type { SessionBranchQuery } from "../storage/types.js";
export { DefaultResourceLoader, loadProjectContextFiles } from "../core/resource-loader.js";
export type { ResourcePluginsResult, ResourceLoader } from "../core/resource-loader.js";
export { loadPromptTemplates } from "../core/prompt-templates.js";
export type { PromptTemplate } from "../core/prompt-templates.js";
export { formatSkillsForPrompt, loadSkills, loadSkillsFromDir } from "../core/skills.js";
export type {
	LoadSkillsFromDirOptions,
	LoadSkillsOptions,
	LoadSkillsResult,
	Skill,
	SkillFrontmatter,
} from "../core/skills.js";
export { discoverSkills, discoverSkillsDetailed, loadSkill } from "../context/skills.js";
export { SettingsManager } from "../core/settings-manager.js";
export type { FullscreenScrollbar, PersistedSettings, ThinkingLevel } from "../core/settings-manager.js";
export { ModelRegistry } from "../providers/public-model-registry.js";
export { ModelRuntime } from "../providers/model-compat.js";
export { inspectAgentSession, type AgentSessionInspection } from "../service/session-inspection.js";
export type { ProviderModel } from "../providers/models.js";
export type { ProviderWireLifecycleHost } from "../providers/wire.js";
export { defineTool } from "../plugins/direct.js";
export type {
	DurableToolEffect,
	ResourceClaim,
	ToolDefinition,
	ToolRecoveryContext,
	ToolRecoveryContract,
	ToolRecoveryMode,
	ToolRecoveryResult,
} from "../plugins/direct.js";
export type { ToolContext } from "../tools/types.js";
export { createHarnessToolFromDefinition, isHarnessTool } from "../tools/direct-tool.js";
export type { AgentSessionTool, AgentTool } from "../tools/direct-tool.js";
export type { HarnessTool } from "../tools/types.js";
export {
	allToolNames,
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
	createTool,
	createToolDefinition,
} from "../tools/catalog.js";
export type { Tool, ToolDef, ToolName, ToolsOptions } from "../tools/catalog.js";
export { withFileMutationQueue } from "../tools/file-mutation-queue.js";
export type { ToolExecutionBackend } from "../tools/backend.js";
export type {
	ToolAuthorizationContext,
	ToolAuthorizationDecision,
	ToolAuthorizationHandler,
	ToolAuthorizationOwner,
	ToolAuthorizationRequest,
} from "../tools/approval.js";
export {
	AgentSessionRuntime,
	SessionImportFileNotFoundError,
	createAgentSessionRuntime,
} from "../service/agent-session-runtime.js";
export type {
	AgentSessionRuntimeLifecycle,
	AgentSessionRuntimeDiagnostic,
	AgentSessionRuntimeServices,
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
	SessionGuardResult,
} from "../service/agent-session-runtime.js";
export {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../service/agent-session-services.js";
export type {
	AgentSessionServices,
	CreateAgentSessionFromServicesOptions,
	CreateAgentSessionServicesOptions,
} from "../service/agent-session-services.js";
