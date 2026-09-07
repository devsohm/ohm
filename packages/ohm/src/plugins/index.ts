export * from "./direct.js";
export * from "./compat.js";
export * from "./config-store.js";
export * from "./model-boundary.js";

export { PluginCatalog } from "./catalog.js";
export { pluginGalleryInstallSource, parsePluginGalleryIndex } from "./gallery.js";
export {
  PROJECT_PACKAGE_DECLARATION,
  PROJECT_PACKAGE_INSTALL_ROOT,
  PROJECT_PACKAGE_LOCK,
  ProjectPackageManager,
  mergeProjectPackageResourceFilters,
  parseProjectPackageDeclaration,
  parseProjectPackageLock,
  projectPackageDeclarationSha256,
  projectPackageResourceFilters,
} from "./project-packages.js";
export { builtinSlashCommands, isBuiltinSlashCommand } from "./reserved.js";

export type {
  ProviderAmbientAuthMethod,
  ProviderApiKeyAuthMethod,
  ProviderAuthDescriptor,
  ProviderAuthDescriptorMethod,
  ProviderDeviceAuthMethod,
  ProviderPkceAuthMethod,
  ProviderAuthenticatedRequestPolicy,
  ProviderRequestAwsSigV4Auth,
  ProviderRequestHeaderAuth,
} from "../auth/provider-descriptor.js";

export type {
  PluginGalleryContributionCounts,
  PluginGalleryIndex,
  PluginGalleryMedia,
  PluginGalleryPackage,
  PluginGallerySource,
} from "./gallery.js";
export type {
  InstalledProjectPackage,
  ProjectPackageCatalogEntry,
  ProjectPackageCheckResult,
  ProjectPackageCheckStatus,
  ProjectPackageCommand,
  ProjectPackageCommands,
  ProjectPackageDeclaration,
  ProjectPackageDeclarationEntry,
  ProjectPackageDeclarationSource,
  ProjectPackageLock,
  ProjectPackageLockEntry,
  ProjectPackageManagerOptions,
  ProjectPackageProvenance,
  ProjectPackageReconcileResult,
  ProjectPackageResolvedSource,
  ProjectPackageUpdateOptions,
} from "./project-packages.js";
export {
  renderPluginCommand,
  renderPluginPrompt,
  validateTemplatePlaceholders,
} from "./templates.js";
export { loadPromptTemplates, loadThemes } from "./loose-resources.js";
export type { LooseResourceLoadOptions } from "./loose-resources.js";
export type {
  PluginBundle,
  PluginContributionCounts,
  PluginDiagnostic,
  PluginDiagnosticSeverity,
  PluginDoctorReport,
  PluginMetadata,
  PluginPromptTemplate,
  PluginRuntimeEntry,
  PluginScope,
  PluginSlashCommand,
  PluginStatus,
  PluginTheme,
} from "./types.js";
