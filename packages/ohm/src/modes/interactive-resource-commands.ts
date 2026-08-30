import { optionalProperties } from "../core/optional-properties.js";
import type { ImageBlock } from "../core/types.js";
import { renderExtensionCommand, renderExtensionPrompt } from "../extensions/templates.js";
import type { ExtensionPromptTemplate, ExtensionSlashCommand } from "../extensions/types.js";
import type { AgentSession } from "../service/agent-session.js";

export interface InteractiveResourceCatalog {
  command(name: string): ExtensionSlashCommand | undefined;
  prompt(name: string): ExtensionPromptTemplate | undefined;
}

export interface InteractiveResourceSlash {
  kind: "runtime" | "static-command" | "static-prompt" | "prompt" | "skill";
  name: string;
  args: string;
  input: string;
  prompt: string;
}

export interface InteractiveResourceSession {
  extensionRunner: { getRuntimeHost(): { hasCommand(name: string): boolean } };
  promptTemplates: readonly { name: string }[];
  settingsManager: { getEnableSkillCommands(): boolean };
  resourceLoader: { getSkills(): { skills: readonly { name: string }[] } };
  prompt: AgentSession["prompt"];
}

function parseResourceSlash(input: string): { name: string; args: string; input: string } | undefined {
  const normalized = input.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(normalized);
  if (match === null) return undefined;
  return { name: match[1]!, args: match[2] ?? "", input: normalized };
}

/** Resolve only registered extension, prompt-template, and enabled skill commands. */
export function resolveInteractiveResourceSlash(
  session: InteractiveResourceSession,
  input: string,
  catalog?: InteractiveResourceCatalog,
): InteractiveResourceSlash | undefined {
  const parsed = parseResourceSlash(input);
  if (parsed === undefined) return undefined;
  const runtime = session.extensionRunner.getRuntimeHost();
  if (runtime.hasCommand(parsed.name)) return { kind: "runtime", ...parsed, prompt: parsed.input };
  const staticCommand = catalog?.command(parsed.name);
  if (staticCommand !== undefined) {
    return {
      kind: "static-command",
      ...parsed,
      prompt: renderExtensionCommand(staticCommand, parsed.args),
    };
  }
  const staticPrompt = catalog?.prompt(parsed.name);
  if (staticPrompt !== undefined) {
    return {
      kind: "static-prompt",
      ...parsed,
      prompt: renderExtensionPrompt(staticPrompt, parsed.args),
    };
  }
  if (session.promptTemplates.some((prompt) => prompt.name === parsed.name)) {
    return { kind: "prompt", ...parsed, prompt: parsed.input };
  }
  const skillName = parsed.name.startsWith("skill:") ? parsed.name.slice("skill:".length) : undefined;
  if (
    skillName !== undefined && skillName !== "" && session.settingsManager.getEnableSkillCommands()
    && session.resourceLoader.getSkills().skills.some((skill) => skill.name === skillName)
  ) {
    return { kind: "skill", ...parsed, prompt: parsed.input };
  }
  return undefined;
}

/** Execute command preflight now and admit any generated prompt as one follow-up. */
export async function dispatchActiveInteractiveResourceSlash(
  session: Pick<InteractiveResourceSession, "prompt">,
  route: InteractiveResourceSlash,
  images: readonly ImageBlock[],
  signal: AbortSignal,
): Promise<void> {
  await session.prompt(route.prompt, {
    ...optionalProperties(images.length === 0 ? undefined : { images }),
    signal,
    source: "interactive",
    streamingBehavior: "followUp",
  });
}
