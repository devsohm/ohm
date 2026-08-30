import type { PackageDiagnostic, ResolvedPaths } from "./package-manager.js";

export const PREPARED_PACKAGE_DISCOVERY: unique symbol = Symbol("prepared-package-discovery");

export interface PreparedPackageDiscovery {
	readonly diagnostics: readonly PackageDiagnostic[];
	readonly resolved: ResolvedPaths;
}

export interface InternalResourceLoaderOptions {
	[PREPARED_PACKAGE_DISCOVERY]?: PreparedPackageDiscovery;
}
