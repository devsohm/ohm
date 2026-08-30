import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";

import { Type } from "typebox";
import { Text } from "ohm/tui";

import { discoverProfiles } from "./profiles.mjs";
import {
  MAX_CONCURRENCY,
  MAX_TASKS,
  chainedTask,
  currentCliPrefix,
  mapConcurrent,
  runChildAgent,
  truncateUtf8,
  validateTask,
} from "./runner.mjs";

const BUILTIN_PROFILES = fileURLToPath(new URL("../profiles", import.meta.url));

const taskSchema = Type.Object({
  profile: Type.String({ minLength: 1, maxLength: 64 }),
  task: Type.String({ minLength: 1, maxLength: 16_384 }),
}, { additionalProperties: false });

const modeSchema = Type.Union([
  Type.Literal("single"),
  Type.Literal("parallel"),
  Type.Literal("chain"),
]);

async function catalog(context) {
  const projectTrusted = context.isProjectTrusted();
  let profiles = await discoverProfiles({
    builtinRoot: BUILTIN_PROFILES,
    userRoot: `${context.paths.userData}/profiles`,
    workspaceRoot: `${context.paths.workspaceData}/profiles`,
    projectTrusted,
  });
  if (projectTrusted && !context.isProjectTrusted()) {
    profiles = await discoverProfiles({
      builtinRoot: BUILTIN_PROFILES,
      userRoot: `${context.paths.userData}/profiles`,
      workspaceRoot: `${context.paths.workspaceData}/profiles`,
      projectTrusted: false,
    });
    return { profiles, projectTrusted: false };
  }
  return { profiles, projectTrusted };
}

function catalogText(profiles, projectTrusted) {
  const lines = profiles.map((profile) => `- ${profile.name} [${profile.scope}]: ${profile.description}`);
  if (!projectTrusted) lines.push("- Workspace profiles are disabled because this project is not trusted.");
  return lines.join("\n");
}

function modelReference(model) {
  return model === undefined ? undefined : `${model.provider}/${model.id}`;
}

function updateReporter(onUpdate, index, profile) {
  return (progress) => {
    const activity = progress.phase === "tool"
      ? `using ${progress.tool}`
      : progress.phase === "writing"
        ? "writing"
        : "finishing";
    const preview = progress.text === undefined ? "" : `\n${truncateUtf8(progress.text, 1_024, "…")}`;
    const details = { index, profile: profile.name, phase: progress.phase };
    if (progress.tool !== undefined) details.tool = progress.tool;
    onUpdate?.({
      content: [{ type: "text", text: `${profile.name} · ${activity}${preview}` }],
      details,
    });
  };
}

function selectedTasks(input, profiles) {
  const mode = input.mode ?? "single";
  if (mode === "single" && input.tasks.length !== 1) throw new Error("Single mode requires exactly one task");
  if (input.tasks.length < 1 || input.tasks.length > MAX_TASKS) throw new Error(`Provide from 1 through ${MAX_TASKS} tasks`);
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const available = profiles.map((profile) => profile.name).join(", ");
  return {
    mode,
    tasks: input.tasks.map((entry) => {
      const profile = byName.get(entry.profile);
      if (profile === undefined) throw new Error(`Unknown specialist profile ${JSON.stringify(entry.profile)}. Available: ${available || "none"}`);
      return { profile, task: validateTask(entry.task) };
    }),
  };
}

export default function activate(ohm) {
  ohm.registerTool({
    name: "example_list_specialists",
    label: "List specialist profiles",
    description: "List the bounded specialist profiles available to this session.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_callId, _input, signal, _onUpdate, context) {
      signal?.throwIfAborted();
      const { profiles, projectTrusted } = await catalog(context);
      const text = catalogText(profiles, projectTrusted);
      return {
        content: [{ type: "text", text }],
        details: {
          profiles: profiles.map(({ name, description, scope, model, thinking, tools }) => {
            const entry = { name, description, scope, tools: [...tools] };
            if (model !== undefined) entry.model = model;
            if (thinking !== undefined) entry.thinking = thinking;
            return entry;
          }),
          workspaceProfilesLoaded: projectTrusted,
        },
      };
    },
    renderCall() { return new Text("Discover specialist profiles", 0, 0); },
    renderResult(result) {
      return new Text(result.content.find((block) => block.type === "text")?.text ?? "No specialist profiles", 0, 0);
    },
  });

  ohm.registerTool({
    name: "example_delegate_specialists",
    label: "Delegate to specialists",
    description: `Run one to ${MAX_TASKS} bounded specialist tasks in single, parallel, or chain mode. Call example_list_specialists first to discover profile names.`,
    parameters: Type.Object({
      mode: Type.Optional(modeSchema),
      tasks: Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_callId, input, signal, onUpdate, context) {
      signal?.throwIfAborted();
      const { profiles } = await catalog(context);
      const selected = selectedTasks(input, profiles);
      const cliPrefix = currentCliPrefix();
      const fallbackModel = modelReference(context.model);
      const common = {
        processes: ohm.processes,
        cliPrefix,
        cwd: await realpath(context.cwd),
        fallbackModel,
        fallbackThinking: context.thinkingLevel,
      };

      let reports;
      if (selected.mode === "parallel") {
        reports = await mapConcurrent(selected.tasks, MAX_CONCURRENCY, async (entry, index, childSignal) => await runChildAgent({
          ...common,
          task: entry.task,
          profile: entry.profile,
          signal: childSignal,
          onProgress: updateReporter(onUpdate, index, entry.profile),
        }), signal);
      } else if (selected.mode === "chain") {
        reports = [];
        let previous;
        for (const [index, entry] of selected.tasks.entries()) {
          signal?.throwIfAborted();
          const report = await runChildAgent({
            ...common,
            task: chainedTask(entry.task, previous),
            profile: entry.profile,
            signal,
            onProgress: updateReporter(onUpdate, index, entry.profile),
          });
          reports.push(report);
          previous = report.text;
        }
      } else {
        const entry = selected.tasks[0];
        reports = [await runChildAgent({
          ...common,
          task: entry.task,
          profile: entry.profile,
          signal,
          onProgress: updateReporter(onUpdate, 0, entry.profile),
        })];
      }

      const response = reports.map((report) => `## ${report.profile}\n\n${report.text}`).join("\n\n");
      return {
        content: [{ type: "text", text: response }],
        details: { mode: selected.mode, reports },
      };
    },
    renderCall(input) {
      const mode = input.mode ?? "single";
      return new Text(`Delegate ${input.tasks.length} specialist task${input.tasks.length === 1 ? "" : "s"} · ${mode}`, 0, 0);
    },
    renderResult(result, options) {
      const reports = Array.isArray(result.details?.reports) ? result.details.reports : [];
      if (!options.expanded) return new Text(`${reports.length} specialist report${reports.length === 1 ? "" : "s"} completed`, 0, 0);
      return new Text(result.content.find((block) => block.type === "text")?.text ?? "No specialist report", 0, 0);
    },
  });
}
