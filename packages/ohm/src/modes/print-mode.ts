import { optionalProperties } from "../core/optional-properties.js";
import type { ImageContent } from "@ohm/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { canonicalPublicImages } from "../core/public-image-content.js";
import type { ExtensionError } from "../extensions/direct.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";
import { escapeTerminal } from "../tools/output.js";
import { formatExtensionError, projectExtensionError, type ProjectedExtensionError } from "./extension-error.js";
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
	write?: (text: string) => void;
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
	const write = options.write ?? ((text: string): void => { process.stdout.write(text); });
	let unsubscribe = (): void => undefined;
	let bindingGeneration = 0;
	let headerPending = options.mode === "json";
	let status = 0;
	let latestAssistant: OneShotAssistantMessage | undefined;
	const pendingExtensionErrors: ProjectedExtensionError[] = [];
	const writeExtensionError = (event: ProjectedExtensionError): void => {
		write(`${JSON.stringify(event)}\n`);
	};

	const reportExtensionError = (failure: ExtensionError): void => {
		const event = projectExtensionError(failure);
		if (options.mode === "json" && headerPending) pendingExtensionErrors.push(event);
		else if (options.mode === "json") writeExtensionError(event);
		else console.error(formatExtensionError(failure));
	};

	const bind = async (session: AgentSession): Promise<void> => {
		const generation = ++bindingGeneration;
		await session.bindExtensions({
			mode: options.mode === "json" ? "json" : "print",
			commandContextActions: createAgentSessionRuntimeCommandActions(runtime, session),
			onError: reportExtensionError,
		});
		if (generation !== bindingGeneration) return;
		unsubscribe();
		unsubscribe = options.mode === "json"
			? session.subscribe((event) => { write(`${JSON.stringify(event)}\n`); })
			: (): void => undefined;
		if (headerPending) {
			headerPending = false;
			const header = session.sessionManager.getHeader();
			if (header !== null) write(`${JSON.stringify(header)}\n`);
			for (const event of pendingExtensionErrors.splice(0)) writeExtensionError(event);
		}
		await recoverNonInteractiveSession(session);
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
			await runtime.session.prompt(message.text, images === undefined ? {} : { images });
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
			if (text !== "") write(`${text}\n`);
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
	}

	return status;
}
