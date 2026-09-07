import type { RuntimeDiscoverableResource, RuntimeDiscoveryView, RuntimePluginHost } from "../plugins/runtime.js";
import { optionalProperties } from "./optional-properties.js";
import type { ResourceLoader } from "./resource-loader.js";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.js";

export function runtimeDiscoveryView(
  host: Pick<RuntimePluginHost, "commands">,
  loader: Pick<ResourceLoader, "getPrompts" | "getSkills">,
): RuntimeDiscoveryView {
  const maximumPerKind = 512;
  const runtimeCommands = host.commands();
  const prompts = loader.getPrompts().prompts;
  const skills = loader.getSkills().skills;
  const commandResources: RuntimeDiscoverableResource[] = [
    ...BUILTIN_SLASH_COMMANDS.map((command): RuntimeDiscoverableResource => ({
      kind: "command",
      source: "builtin",
      name: command.name,
      ...optionalProperties(command.description === undefined ? undefined : { description: command.description }),
      ...optionalProperties(command.argumentHint === undefined ? undefined : { argumentHint: command.argumentHint }),
    })),
    ...runtimeCommands.map((command): RuntimeDiscoverableResource => ({
      kind: "command",
      source: "runtime_extension",
      name: command.name,
      extensionId: command.extensionId,
      ...optionalProperties(command.description === undefined ? undefined : { description: command.description }),
      ...optionalProperties(command.argumentHint === undefined ? undefined : { argumentHint: command.argumentHint }),
    })),
  ];
  const promptResources = prompts.map((prompt): RuntimeDiscoverableResource => ({
    kind: "prompt",
    name: prompt.name,
    extensionId: prompt.sourceInfo.source,
    ...optionalProperties(prompt.description === undefined || prompt.description === "" ? undefined : { description: prompt.description }),
    ...optionalProperties(prompt.argumentHint === undefined ? undefined : { argumentHint: prompt.argumentHint }),
  }));
  const skillResources = skills.map((skill): RuntimeDiscoverableResource => ({
    kind: "skill",
    name: skill.name,
    description: skill.description,
    scope: skill.sourceInfo.scope === "user" ? "user" : "workspace",
    trusted: true,
    disableModelInvocation: skill.disableModelInvocation,
  }));
  return {
    resources: [
      ...commandResources.slice(0, maximumPerKind),
      ...promptResources.slice(0, maximumPerKind),
      ...skillResources.slice(0, maximumPerKind),
    ],
    truncated: commandResources.length > maximumPerKind
      || promptResources.length > maximumPerKind
      || skillResources.length > maximumPerKind,
    omitted: {
      commands: Math.max(0, commandResources.length - maximumPerKind),
      prompts: Math.max(0, promptResources.length - maximumPerKind),
      skills: Math.max(0, skillResources.length - maximumPerKind),
    },
  };
}
