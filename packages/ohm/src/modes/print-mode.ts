import { optionalProperties } from "../core/optional-properties.js";
import type { ImageContent } from "@ohm/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { canonicalPublicImages } from "../core/public-image-content.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";
import { escapeTerminal } from "../tools/output.js";
import { createPrintOutput } from "./print-output.js";
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
	/** A returned promise must settle; it backpressures generation and shutdown. */
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
	const output = createPrintOutput(options.mode, options.write);
	let bindingGeneration = 0;
	let status = 0;
	let latestAssistant: OneShotAssistantMessage | undefined;

	const bind = async (session: AgentSession): Promise<void> => {
		const generation = ++bindingGeneration;
		await session.bindPlugins({
			mode: options.mode === "json" ? "json" : "print",
			commandContextActions: createAgentSessionRuntimeCommandActions(runtime, session),
			onError: output.reportPluginError,
		}, output.signal);
		if (generation !== bindingGeneration) return;
		await output.bind(session);
		if (generation !== bindingGeneration) return;
		await recoverNonInteractiveSession(session, output.signal);
	};

	runtime.setBeforeSessionInvalidate(() => {
		bindingGeneration += 1;
		output.unbind();
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
				signal: output.signal,
				...optionalProperties(images === undefined ? undefined : { images }),
			});
			await output.drain();
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
			if (text !== "") await output.write(`${text}\n`);
		}
	} catch (error) {
		status = 1;
		console.error(safeDiagnostic(error));
	} finally {
		bindingGeneration += 1;
		output.unbind();
		runtime.setBeforeSessionInvalidate(undefined);
		runtime.setRebindSession(undefined);
		try {
			await runtime.dispose();
		} catch (error) {
			status = 1;
			console.error(safeDiagnostic(error));
		}
		try {
			await output.close();
		} catch (error) {
			if (status === 0) console.error(safeDiagnostic(error));
			status = 1;
		}
	}

	return status;
}
