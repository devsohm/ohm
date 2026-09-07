import type {
  PluginAPI,
  PluginProcessId,
  PluginProcessResult,
  PluginProcessStatus,
} from "ohm/plugins";

export async function exerciseManagedProcesses(api: PluginAPI): Promise<PluginProcessResult> {
  const id: PluginProcessId = api.processes.spawn({
    argv: [process.execPath, "--version"],
    stdout: "capture",
    stderr: "capture",
  });
  const status: PluginProcessStatus = api.processes.status(id);
  void [status.state, status.stdoutBytes, status.stderrBytes];
  return await api.processes.wait(id);
}
