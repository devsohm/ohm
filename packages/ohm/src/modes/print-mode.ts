import { optionalProperties } from "../core/optional-properties.js";
import type { ImageContent } from "@ohm/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { canonicalPublicImages } from "../core/public-image-content.js";
import type { PluginError } from "../plugins/direct.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { projectSessionWireEvent } from "../interfaces/session-wire.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";
import { escapeTerminal } from "../tools/output.js";
import { formatPluginError, projectPluginError, type ProjectedPluginError } from "./plugin-error.js";
import { recoverNonInteractiveSession } from "./noninteractive-recovery.js";
import {
	captureOneShotAssistantBoundary,
	latestOneShotAssistant,
	type OneShotAssistantMessage,
} from "./one-shot-assistant.js";

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: readonly string[];
	initialMessage?: string;
	initialImages?: readonly ImageContent[];
	write?: ((text: string) => void) | ((text: string) => Promise<void>);
}

function safeDiagnostic<Value>(value: Value): string {
	return escapeTerminal(defaultSecretRedactor.redact(errorMessage(value)));
}

function assistantFailure(assistant: OneShotAssistantMessage | undefined): string | undefined {
	if (assistant === undefined) return undefined;
	if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return undefined;
	return assistant.errorMessage ?? `Request ${assistant.stopReason}`;
}

function finalAssistantText(assistant: OneShotAssistantMessage | undefined): string {
	if (assistant === undefined) return "";
	return assistant.content
		.flatMap((block) => block.type === "text" ? [block.text] : [])
		.join("");
}

/** Run a caller-owned session as a one-shot text or JSON event stream. */
export async function runPrintMode(
	runtime: AgentSessionRuntime,
	options: PrintModeOptions,
): Promise<number> {
	const outputAbort = new AbortController();
	const writeOutput = options.write ?? ((text: string): Promise<void> => new Promise((resolve, reject) => {
		writeMachineOutput(text, (error) => {
			if (error === undefined || error === null) resolve();
			else reject(error);
		});
	}));
	let outputTail = Promise.resolve();
	const write = (text: string): Promise<void> => {
		outputTail = outputTail.then(async () => { await writeOutput(text); });
		// Cancel without awaiting the run from its own event listener; the drain reports the failure.
		void outputTail.catch((error) => { outputAbort.abort(error); });
		return outputTail;
	};
	let unsubscribe = (): void => undefined;
	let bindingGeneration = 0;
	let headerPending = options.mode === "json";
	let status = 0;
	let latestAssistant: OneShotAssistantMessage | undefined;
	const pendingPluginErrors: ProjectedPluginError[] = [];
	const writePluginError = (event: ProjectedPluginError): void => {
		void write(`${JSON.stringify(event)}\n`);
	};

	const reportPluginError = (failure: PluginError): void => {
		const event = projectPluginError(failure);
		if (options.mode === "json" && headerPending) pendingPluginErrors.push(event);
		else if (options.mode === "json") writePluginError(event);
		else console.error(formatPluginError(failure));
	};

	const bind = async (session: AgentSession): Promise<void> => {
		const generation = ++bindingGeneration;
		await session.bindPlugins({
			mode: options.mode === "json" ? "json" : "print",
			commandContextActions: createAgentSessionRuntimeCommandActions(runtime, session),
			onError: reportPluginError,
		}, outputAbort.signal);
		if (generation !== bindingGeneration) return;
		unsubscribe();
		unsubscribe = options.mode === "json"
			? session.subscribe(async (event) => { await write(`${JSON.stringify(projectSessionWireEvent(event))}\n`); })
			: (): void => undefined;
		if (headerPending) {
			headerPending = false;
			const header = session.sessionManager.getHeader();
			if (header !== null) await write(`${JSON.stringify(header)}\n`);
			for (const event of pendingPluginErrors.splice(0)) writePluginError(event);
			await outputTail;
		}
		if (generation !== bindingGeneration) return;
		await recoverNonInteractiveSession(session, outputAbort.signal);
	};

	runtime.setBeforeSessionInvalidate(() => {
		bindingGeneration += 1;
		unsubscribe();
		unsubscribe = (): void => undefined;
	});
	runtime.setRebindSession(bind);

	try {
		await bind(runtime.session);

		const messages: Array<{ text: string; images?: readonly ImageContent[] }> = [];
		if (options.initialMessage !== undefined) {
			messages.push({
				text: options.initialMessage,
				...optionalProperties(options.initialImages === undefined ? undefined : { images: options.initialImages }),
			});
		}
		for (const message of options.messages ?? []) messages.push({ text: message });

		for (const message of messages) {
			const boundary = captureOneShotAssistantBoundary(runtime.session);
			const images = message.images === undefined
				? undefined
				: canonicalPublicImages(message.images, "initialImages");
			await runtime.session.prompt(message.text, {
				signal: outputAbort.signal,
				...optionalProperties(images === undefined ? undefined : { images }),
			});
			await outputTail;
			const assistant = latestOneShotAssistant(boundary, runtime.session);
			latestAssistant = assistant;
			const failure = assistantFailure(assistant);
			if (failure === undefined) continue;
			if (options.mode === "text") console.error(safeDiagnostic(failure));
			status = 1;
			break;
		}

		if (status === 0 && options.mode === "text") {
			const text = finalAssistantText(latestAssistant);
			if (text !== "") await write(`${text}\n`);
		}
	} catch (error) {
		status = 1;
		console.error(safeDiagnostic(error));
	} finally {
		bindingGeneration += 1;
		unsubscribe();
		runtime.setBeforeSessionInvalidate(undefined);
		runtime.setRebindSession(undefined);
		try {
			await runtime.dispose();
		} catch (error) {
			status = 1;
			console.error(safeDiagnostic(error));
		}
		try {
			await outputTail;
		} catch (error) {
			if (status === 0) console.error(safeDiagnostic(error));
			status = 1;
		}
	}

	return status;
}
