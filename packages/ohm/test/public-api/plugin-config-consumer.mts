import {
  PluginConfigConflictError,
  createPluginConfigStore,
  type PluginConfigSnapshot,
  type PluginConfigStore,
} from "ohm/plugins";

declare const userRoot: string;
declare const workspaceRoot: string;

export const extensionConfigStore: PluginConfigStore = createPluginConfigStore({
  roots: { user: userRoot, workspace: workspaceRoot },
  writable: () => true,
});

export async function replaceExtensionConfig(
  prior: PluginConfigSnapshot,
): Promise<PluginConfigSnapshot> {
  try {
    return await extensionConfigStore.replace("workspace", { version: 1 }, {
      expectedRevision: prior.revision,
    });
  } catch (error) {
    if (error instanceof PluginConfigConflictError) {
      void error.currentRevision;
    }
    throw error;
  }
}
