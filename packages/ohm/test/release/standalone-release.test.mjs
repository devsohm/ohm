import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  createStandaloneInstallPlan,
  parseStandaloneArguments,
  standaloneProductionInstallTimeoutMs,
} from "../../../../scripts/build-standalone.mjs";
import {
  assertStandaloneProductionGraph,
  createStandaloneProductionLock,
} from "../../../../scripts/standalone-production-lock.mjs";
import { assertSpdxReleaseSbom, finalizeRelease } from "../../../../scripts/finalize-release.mjs";
import {
  assertStandaloneArchiveListing,
  createStandaloneArchive,
  createTarHeader,
} from "../../../../scripts/standalone-archive.mjs";
import {
  createThirdPartyLicenseBundle,
  verifyThirdPartyLicenseBundle,
} from "../../../../scripts/third-party-licenses.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");
const RELEASE_MANIFEST_KEYS = [
  "schemaVersion", "product", "version", "tag", "packaging", "node", "nodeRuntime", "archive", "archives",
  "source", "standalones", "checksumFile", "releaseNotes", "targets",
];
const PINNED_LICENSE_ASSETS = [
  "aws-sdk-js-v3-d760a008-LICENSE.txt",
  "data-uri-to-buffer-4.0.1-LICENSE.txt",
  "standardwebhooks-1.0.0-LICENSE.txt",
];
const SHARP_LIBVIPS_BINARY_PACKAGES = [
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@img/sharp-libvips-linux-arm64",
  "@img/sharp-libvips-linux-x64",
];

function parseTarEntries(buffer) {
  const entries = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    entries.push({ path: prefix === "" ? name : `${prefix}/${name}`, type });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("standalone argument parsing requires explicit staging and output directories", () => {
  assert.throws(() => parseStandaloneArguments([]), /--directory is required/u);
  assert.throws(
    () => parseStandaloneArguments(["--directory", ".release", "--output", ".standalone", "--output", "again"]),
    /--output may be specified only once/u,
  );
  const parsed = parseStandaloneArguments([
    "--directory", ".release", "--output", ".standalone", "--runtime-root", ".runtime",
  ]);
  assert.deepEqual(parsed, {
    directory: resolve(REPOSITORY_ROOT, ".release"),
    output: resolve(REPOSITORY_ROOT, ".standalone"),
    runtimeRoot: resolve(REPOSITORY_ROOT, ".runtime"),
  });
});

test("standalone dependency installation uses npm ci without unlocked archive arguments", () => {
  const plan = createStandaloneInstallPlan(resolve("isolated"));
  assert.equal(plan.environment.npm_config_offline, "false");
  assert.equal(plan.environment.npm_config_prefer_offline, "true");
  assert.equal(plan.args[0], "ci");
  assert.equal(plan.args.includes("install"), false);
  assert.equal(plan.args.includes("--package-lock=false"), false);
  assert.equal(plan.args.includes("--offline"), false);
  assert.equal(plan.args.includes("--offline=false"), true);
  assert.equal(plan.args.includes("--prefer-offline"), true);
  assert.equal(Object.keys(plan.environment).some((name) => /(?:token|secret|password)/iu.test(name)), false);
});

test("pinned standalone license assets retain canonical LF checkout bytes", async () => {
  const attributes = await readFile(resolve(REPOSITORY_ROOT, ".gitattributes"), "utf8");
  assert.match(attributes, /^scripts\/third-party-license-assets\/\*\.txt text eol=lf$/mu);
  for (const name of PINNED_LICENSE_ASSETS) {
    const bytes = await readFile(resolve(REPOSITORY_ROOT, "scripts", "third-party-license-assets", name));
    assert.equal(bytes.includes(0x0d), false, `${name} contains a carriage return`);
  }
});

test("standalone production lock is a closed projection of the committed workspace lock", async () => {
  const workspaceLock = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "package-lock.json"), "utf8"));
  const packageGraph = [
    ["@ohm/terminal", "packages/terminal"],
    ["@ohm/models", "packages/models"],
    ["@ohm/kernel", "packages/kernel"],
    ["ohm", "packages/ohm"],
  ];
  const packageManifests = Object.fromEntries(await Promise.all(packageGraph.map(async ([name, directory]) => [
    name,
    JSON.parse(await readFile(resolve(REPOSITORY_ROOT, directory, "package.json"), "utf8")),
  ])));
  const archives = packageGraph.map(([name], index) => ({
    name,
    version: packageManifests[name].version,
    file: `${name.replaceAll("@", "").replaceAll("/", "-")}-${packageManifests[name].version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`,
  }));

  const productionLock = createStandaloneProductionLock({ workspaceLock, packageManifests, archives });
  assert.equal(productionLock.lockfileVersion, 3);
  assert.deepEqual(
    productionLock.packages[""].dependencies,
    Object.fromEntries(archives.map(({ name, file }) => [name, `file:archives/${file}`])),
  );
  assert.equal(productionLock.packages["node_modules/typebox"].version, "1.3.17");
  assert.match(productionLock.packages["node_modules/typebox"].integrity, /^sha512-/u);
  assert.equal(
    Object.values(productionLock.packages).some((entry) => entry?.dev === true || entry?.peer === true),
    false,
  );

  const drifted = structuredClone(workspaceLock);
  drifted.packages["node_modules/typebox"].version = "9.9.9";
  assert.throws(
    () => createStandaloneProductionLock({ workspaceLock: drifted, packageManifests, archives }),
    /Locked registry URL.*typebox@9\.9\.9/u,
  );
  const unlocked = structuredClone(workspaceLock);
  delete unlocked.packages["node_modules/typebox"].integrity;
  assert.throws(
    () => createStandaloneProductionLock({ workspaceLock: unlocked, packageManifests, archives }),
    /typebox.*integrity/u,
  );
  const shortIntegrity = structuredClone(workspaceLock);
  shortIntegrity.packages["node_modules/typebox"].integrity = "sha512-AA==";
  assert.throws(
    () => createStandaloneProductionLock({ workspaceLock: shortIntegrity, packageManifests, archives }),
    /typebox.*64 bytes/u,
  );
  assert.throws(
    () => createStandaloneProductionLock({
      workspaceLock,
      packageManifests,
      archives: [...archives, archives[0]],
    }),
    /exactly one archive per package/u,
  );
  assert.throws(
    () => createStandaloneProductionLock({
      workspaceLock,
      packageManifests,
      archives: archives.map((archive, index) => ({
        ...archive,
        file: index === 1 ? archives[0].file : archive.file,
      })),
    }),
    /archive filenames must be unique/u,
  );
});

test("standalone graph verification rejects missing, changed, and untracked packages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-graph-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const modules = resolve(root, "node_modules");
  const alpha = resolve(modules, "alpha");
  const internal = ["@ohm/terminal", "@ohm/models", "@ohm/kernel", "ohm"];
  const internalRoots = internal.map((name) => resolve(modules, ...name.split("/")));
  await Promise.all([alpha, ...internalRoots].map(async (path) => await mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(resolve(alpha, "package.json"), `${JSON.stringify({ name: "alpha", version: "1.0.0" })}\n`),
    ...internal.map((name, index) => writeFile(
      resolve(internalRoots[index], "package.json"),
      `${JSON.stringify({ name, version: "1.0.0" })}\n`,
    )),
  ]);
  const integrity = (byte) => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
  const lock = {
    name: "ohm-standalone-production",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "ohm-standalone-production",
        version: "1.0.0",
        dependencies: Object.fromEntries(internal.map((name) => [name, `file:archives/${name.replaceAll("@", "").replaceAll("/", "-")}.tgz`])),
      },
      "node_modules/@ohm/terminal": {
        version: "1.0.0",
        resolved: "file:archives/ohm-terminal.tgz",
        integrity: integrity(1),
      },
      "node_modules/@ohm/models": {
        version: "1.0.0",
        resolved: "file:archives/ohm-models.tgz",
        integrity: integrity(2),
      },
      "node_modules/@ohm/kernel": {
        version: "1.0.0",
        resolved: "file:archives/ohm-kernel.tgz",
        integrity: integrity(3),
      },
      "node_modules/ohm": {
        version: "1.0.0",
        resolved: "file:archives/ohm.tgz",
        integrity: integrity(4),
        dependencies: { alpha: "1.0.0" },
        optionalDependencies: { "optional-win": "1.0.0" },
      },
      "node_modules/alpha": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
        integrity: integrity(5),
      },
      "node_modules/optional-win": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/optional-win/-/optional-win-1.0.0.tgz",
        integrity: integrity(6),
        optional: true,
        os: ["win32"],
        dependencies: { "win-child": "1.0.0" },
      },
      "node_modules/optional-linux": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/optional-linux/-/optional-linux-1.0.0.tgz",
        integrity: integrity(7),
        optional: true,
        libc: ["glibc"],
        os: ["linux"],
      },
      "node_modules/win-child": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/win-child/-/win-child-1.0.0.tgz",
        integrity: integrity(8),
        optional: true,
      },
    },
  };
  lock.packages["node_modules/ohm"].optionalDependencies["optional-linux"] = "1.0.0";

  await assert.rejects(
    assertStandaloneProductionGraph(modules, lock, { platform: "linux", arch: "x64" }),
    /missing locked package optional-linux/u,
  );
  const optionalLinux = resolve(modules, "optional-linux");
  await mkdir(optionalLinux);
  await writeFile(resolve(optionalLinux, "package.json"), `${JSON.stringify({
    name: "optional-linux", version: "1.0.0",
  })}\n`);
  await assert.doesNotReject(assertStandaloneProductionGraph(modules, lock, { platform: "linux", arch: "x64" }));
  await writeFile(resolve(alpha, "package.json"), `${JSON.stringify({ name: "alpha", version: "1.0.1" })}\n`);
  await assert.rejects(
    assertStandaloneProductionGraph(modules, lock, { platform: "linux", arch: "x64" }),
    /alpha.*version/u,
  );
  await writeFile(resolve(alpha, "package.json"), `${JSON.stringify({ name: "alpha", version: "1.0.0" })}\n`);
  const rogue = resolve(modules, "rogue");
  await mkdir(rogue);
  await writeFile(resolve(rogue, "package.json"), `${JSON.stringify({ name: "rogue", version: "1.0.0" })}\n`);
  await assert.rejects(
    assertStandaloneProductionGraph(modules, lock, { platform: "linux", arch: "x64" }),
    /not present in the production lock/u,
  );
  await rm(rogue, { recursive: true });
  await rm(alpha, { recursive: true });
  await assert.rejects(
    assertStandaloneProductionGraph(modules, lock, { platform: "linux", arch: "x64" }),
    /missing locked package alpha/u,
  );
});

test("standalone content attestation rejects same-version byte and inventory drift", async (context) => {
  const {
    assertStandaloneProductionContent,
    createStandaloneProductionContent,
  } = await import("../../../../scripts/standalone-production-payload.mjs");
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-content-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const modules = resolve(root, "node_modules");
  const product = resolve(modules, "ohm");
  await mkdir(resolve(product, "dist"), { recursive: true });
  await Promise.all([
    writeFile(resolve(product, "package.json"), `${JSON.stringify({ name: "ohm", version: "1.0.0" })}\n`),
    writeFile(resolve(product, "dist/index.js"), "export const value = 1;\n"),
  ]);

  const expected = await createStandaloneProductionContent(modules);
  await assert.doesNotReject(assertStandaloneProductionContent(modules, expected));
  await writeFile(resolve(product, "dist/index.js"), "export const value = 2;\n");
  await assert.rejects(assertStandaloneProductionContent(modules, expected), /content.*differs/u);
  await writeFile(resolve(product, "dist/index.js"), "export const value = 1;\n");
  await writeFile(resolve(product, "dist/extra.js"), "unexpected\n");
  await assert.rejects(assertStandaloneProductionContent(modules, expected), /content.*differs/u);
});

test("standalone build and verification probe and attest the actual payload", async () => {
  const [{ verifyStandaloneProductionCapabilities }, buildSource, verificationSource] = await Promise.all([
    import("../../../../scripts/standalone-production-payload.mjs"),
    readFile(resolve(REPOSITORY_ROOT, "scripts/build-standalone.mjs"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, "scripts/verify-release-artifact.mjs"), "utf8"),
  ]);
  assert.equal(verifyStandaloneProductionCapabilities instanceof Function, true);
  assert.match(buildSource, /const productionModules = resolve\(payloadRoot, "lib\/node_modules"\)/u);
  assert.match(buildSource, /export TMPDIR TMP TEMP/u);
  assert.ok(buildSource.includes('[ -d "$HOME/.ohm" ] && [ ! -L "$HOME/.ohm" ] || exit 1'));
  assert.ok(buildSource.includes('if [ ! -e "$HOME/.ohm/tmp" ] && [ ! -L "$HOME/.ohm/tmp" ]'));
  assert.ok(buildSource.includes("fs.lstatSync(temporary)"));
  assert.ok(buildSource.includes("if errorlevel 1 exit /b 1"));
  assert.ok(buildSource.includes('TMPDIR="$HOME/.ohm/tmp"'));
  assert.ok(buildSource.includes('set "TMPDIR=%USERPROFILE%\\\\.ohm\\\\tmp"'));
  assert.ok(buildSource.includes('set "TMP=%USERPROFILE%\\\\.ohm\\\\tmp"'));
  assert.ok(buildSource.includes('set "TEMP=%USERPROFILE%\\\\.ohm\\\\tmp"'));
  const buildContent = buildSource.indexOf("createStandaloneProductionContent(productionModules)");
  const buildProbe = buildSource.indexOf("verifyStandaloneProductionCapabilities({");
  const buildRecheck = buildSource.indexOf("assertStandaloneProductionContent(productionModules, productionContent)");
  const buildArchive = buildSource.indexOf("createStandaloneArchive(payloadRoot");
  assert.ok(buildContent >= 0 && buildContent < buildProbe && buildProbe < buildRecheck && buildRecheck < buildArchive);
  assert.match(buildSource, /verifyStandaloneProductionCapabilities\(\{[\s\S]*?packageRoot: resolve\(payloadRoot,/u);
  assert.match(verificationSource, /assertStandaloneProductionContent\([\s\S]*?standaloneRoot/u);
  assert.match(verificationSource, /verifyStandaloneProductionCapabilities\(\{[\s\S]*?packageRoot: resolve\(standaloneRoot,/u);
  assert.match(verificationSource, /assertStandaloneProductionContent\([\s\S]*?paths\.install/u);
});

test("SPDX release validation accepts prerequisites and rejects invalid graphs", () => {
  const version = "1.2.3";
  const valid = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `ohm-workspace@${version}`,
    documentNamespace: "https://example.invalid/spdx/ohm-1.2.3",
    packages: [
      {
        SPDXID: "SPDXRef-Package-ohm-workspace-1.2.3",
        name: "ohm-workspace",
        versionInfo: version,
      },
      {
        SPDXID: "SPDXRef-Package-peer-1.0.0",
        name: "peer",
        versionInfo: "1.0.0",
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package-ohm-workspace-1.2.3",
      },
      {
        spdxElementId: "SPDXRef-Package-peer-1.0.0",
        relationshipType: "PREREQUISITE_FOR",
        relatedSpdxElement: "SPDXRef-Package-ohm-workspace-1.2.3",
      },
    ],
  };
  assert.doesNotThrow(() => assertSpdxReleaseSbom(valid, version));
  assert.throws(
    () => assertSpdxReleaseSbom({ ...valid, packages: [] }, version),
    /must contain packages/u,
  );
  assert.throws(
    () => assertSpdxReleaseSbom({ ...valid, relationships: [] }, version),
    /must contain dependency relationships/u,
  );
  assert.throws(
    () => assertSpdxReleaseSbom({ ...valid, packages: [{}] }, version),
    /package.*identity/u,
  );
  assert.throws(
    () => assertSpdxReleaseSbom({ ...valid, relationships: [{}] }, version),
    /relationship.*identity/u,
  );
  assert.throws(
    () => assertSpdxReleaseSbom({
      ...valid,
      relationships: [
        valid.relationships[0],
        { ...valid.relationships[1], relationshipType: "INVALID" },
      ],
    }, version),
    /relationship type is invalid/u,
  );
  assert.throws(
    () => assertSpdxReleaseSbom({
      ...valid,
      relationships: [{
        ...valid.relationships[0],
        relatedSpdxElement: "SPDXRef-Package-missing",
      }],
    }, version),
    /unknown SPDX element/u,
  );
  assert.throws(
    () => assertSpdxReleaseSbom({
      ...valid,
      packages: [...valid.packages, {
        SPDXID: "SPDXRef-Package-detached-1.0.0",
        name: "detached",
        versionInfo: "1.0.0",
      }],
    }, version),
    /relationship graph is incomplete/u,
  );
});

test("standalone dependency installation allows the established Windows release budget", () => {
  assert.equal(standaloneProductionInstallTimeoutMs("win32"), 10 * 60_000);
  assert.equal(standaloneProductionInstallTimeoutMs("linux"), 300_000);
  assert.equal(standaloneProductionInstallTimeoutMs("darwin"), 300_000);
});

test("standalone third-party license bundle covers and verifies the exact installed packages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-licenses-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const modules = resolve(root, "node_modules");
  const licenses = resolve(root, "LICENSES");
  const alpha = resolve(modules, "alpha");
  const beta = resolve(alpha, "node_modules", "@scope", "beta");
  await Promise.all([
    mkdir(alpha, { recursive: true }),
    mkdir(beta, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(alpha, "package.json"), `${JSON.stringify({ name: "alpha", version: "1.0.0", license: "MIT" })}\n`),
    writeFile(resolve(alpha, "LICENSE"), "alpha license\n"),
    writeFile(resolve(alpha, "NOTICE.txt"), "alpha notice\n"),
    writeFile(resolve(beta, "package.json"), `${JSON.stringify({ name: "@scope/beta", version: "2.0.0", license: "Apache-2.0" })}\n`),
    writeFile(resolve(beta, "COPYING"), "beta license\n"),
  ]);

  const manifest = await createThirdPartyLicenseBundle(modules, licenses);
  assert.deepEqual(manifest.packages.map(({ name, version }) => `${name}@${version}`), [
    "@scope/beta@2.0.0",
    "alpha@1.0.0",
  ]);
  assert.equal(manifest.packages.every(({ documents }) => documents.length > 0), true);
  await assert.doesNotReject(verifyThirdPartyLicenseBundle(modules, licenses));

  const copied = resolve(licenses, manifest.packages[0].documents[0].path);
  await writeFile(copied, "tampered\n");
  await assert.rejects(verifyThirdPartyLicenseBundle(modules, licenses), /digest|bytes/u);

  const fallback = resolve(modules, "fallback");
  await mkdir(fallback);
  await writeFile(resolve(fallback, "package.json"), `${JSON.stringify({
    name: "fallback", version: "3.0.0", license: "MIT",
  })}\n`);
  await writeFile(resolve(fallback, "README.md"), "## License\n\nUnverified README text.\n");
  await assert.rejects(
    createThirdPartyLicenseBundle(modules, licenses),
    /fallback has no license or notice document and no pinned override/u,
  );
});

test("standalone license bundle pins the missing proxy-agent-negotiate notice", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-license-override-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const modules = resolve(root, "node_modules");
  const licenses = resolve(root, "LICENSES");
  const dependency = resolve(modules, "proxy-agent-negotiate");
  await mkdir(dependency, { recursive: true });
  await writeFile(resolve(dependency, "package.json"), `${JSON.stringify({
    name: "proxy-agent-negotiate", version: "1.1.0", license: "MIT",
  })}\n`);
  await writeFile(resolve(dependency, "LICENSE"), "wrong installed license\n");

  const manifest = await createThirdPartyLicenseBundle(modules, licenses);
  assert.equal(manifest.packages.length, 1);
  assert.equal(manifest.packages[0].documents.length, 1);
  assert.equal(manifest.packages[0].documents[0].bytes, 1_102);
  assert.equal(manifest.packages[0].documents[0].sha256, "71368fd0f5b4129191e9afcd1e1ef2dc89a9090d3e4d80bbab92dafd032b3bef");
  await assert.doesNotReject(verifyThirdPartyLicenseBundle(modules, licenses));

  const copied = resolve(licenses, manifest.packages[0].documents[0].path);
  await writeFile(copied, "tampered\n");
  await assert.rejects(verifyThirdPartyLicenseBundle(modules, licenses), /digest|bytes/u);

  const unknown = resolve(modules, "unknown");
  await mkdir(unknown);
  await writeFile(resolve(unknown, "package.json"), `${JSON.stringify({
    name: "unknown", version: "1.0.0", license: "MIT",
  })}\n`);
  await assert.rejects(
    createThirdPartyLicenseBundle(modules, licenses),
    /Package .*unknown has no license or notice document and no pinned override/u,
  );
});

test("standalone license bundle records exact Sharp libvips binaries without bundled documents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-sharp-libvips-license-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const modules = resolve(root, "node_modules");
  const licenses = resolve(root, "LICENSES");
  for (const name of SHARP_LIBVIPS_BINARY_PACKAGES) {
    const directory = resolve(modules, ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "package.json"), `${JSON.stringify({
      name, version: "1.3.2", license: "LGPL-3.0-or-later",
    })}\n`);
  }

  const manifest = await createThirdPartyLicenseBundle(modules, licenses);
  assert.deepEqual(
    manifest.packages.map(({ name, version, license, documents }) => ({ name, version, license, documents })),
    SHARP_LIBVIPS_BINARY_PACKAGES.map((name) => ({
      name, version: "1.3.2", license: "LGPL-3.0-or-later", documents: [],
    })),
  );
  await assert.doesNotReject(verifyThirdPartyLicenseBundle(modules, licenses));

  const nearMiss = resolve(modules, "@img", "sharp-libvips-linux-x64", "package.json");
  await writeFile(nearMiss, `${JSON.stringify({
    name: "@img/sharp-libvips-linux-x64", version: "1.3.3", license: "LGPL-3.0-or-later",
  })}\n`);
  await assert.rejects(
    createThirdPartyLicenseBundle(modules, licenses),
    /sharp-libvips-linux-x64 has no license or notice document and no pinned override/u,
  );
});

test("standalone license overrides pin exact production notices before installed fallbacks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-license-pins-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const modules = resolve(root, "node_modules");
  const licenses = resolve(root, "LICENSES");
  const packages = [
    { name: "@aws-sdk/credential-provider-http", version: "3.972.72", license: "Apache-2.0" },
    { name: "@aws-sdk/credential-provider-login", version: "3.972.77", license: "Apache-2.0" },
    { name: "@aws-sdk/nested-clients", version: "3.997.44", license: "Apache-2.0" },
    { name: "data-uri-to-buffer", version: "4.0.1", license: "MIT" },
    { name: "standardwebhooks", version: "1.0.0", license: "MIT" },
  ];
  for (const entry of packages) {
    const directory = resolve(modules, ...entry.name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "package.json"), `${JSON.stringify(entry)}\n`);
    await writeFile(resolve(directory, "LICENSE"), "wrong installed license\n");
    await writeFile(resolve(directory, "README.md"), "wrong installed README\n");
  }

  const manifest = await createThirdPartyLicenseBundle(modules, licenses);
  assert.deepEqual(
    manifest.packages.map(({ name, version, documents }) => ({
      identity: `${name}@${version}`,
      documents: documents.map(({ source, bytes, sha256: digest }) => ({ source, bytes, sha256: digest })),
    })),
    [
      {
        identity: "@aws-sdk/credential-provider-http@3.972.72",
        documents: [{
          source: "aws/aws-sdk-js-v3/d760a00859a08b5d04590ee047510b49add12361/LICENSE",
          bytes: 11_352,
          sha256: "edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d",
        }],
      },
      {
        identity: "@aws-sdk/credential-provider-login@3.972.77",
        documents: [{
          source: "aws/aws-sdk-js-v3/d760a00859a08b5d04590ee047510b49add12361/LICENSE",
          bytes: 11_352,
          sha256: "edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d",
        }],
      },
      {
        identity: "@aws-sdk/nested-clients@3.997.44",
        documents: [{
          source: "aws/aws-sdk-js-v3/d760a00859a08b5d04590ee047510b49add12361/LICENSE",
          bytes: 11_352,
          sha256: "edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d",
        }],
      },
      {
        identity: "data-uri-to-buffer@4.0.1",
        documents: [{
          source: "TooTallNate/node-data-uri-to-buffer/85cd8c854aefbf1bb636789d80364cfac8ea1583/README.md#license",
          bytes: 1_108,
          sha256: "3072ef4a004c4f92b37eae61cdc3e27225c0a7d2f5e144700e40b9c5a5a7a9b9",
        }],
      },
      {
        identity: "standardwebhooks@1.0.0",
        documents: [{
          source: "standard-webhooks/standard-webhooks/929bf0c1928b188287eaf88d0a9f0a4e87df6499/libraries/LICENSE",
          bytes: 1_088,
          sha256: "5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27",
        }],
      },
    ],
  );
  await assert.doesNotReject(verifyThirdPartyLicenseBundle(modules, licenses));
});

test("standalone tar headers normalize owner, timestamp, and executable mode", () => {
  const header = createTarHeader({ path: "ohm/bin/ohm", bytes: 7, mode: 0o755, type: "0" });
  assert.equal(header.subarray(100, 108).toString("ascii"), "0000755\0");
  assert.equal(header.subarray(108, 116).toString("ascii"), "0000000\0");
  assert.equal(header.subarray(116, 124).toString("ascii"), "0000000\0");
  assert.equal(header.subarray(136, 148).toString("ascii"), "00000000000\0");
  assert.equal(header.subarray(265, 269).toString("ascii"), "root");
});

test("standalone archive verification rejects traversal, non-portable paths, and unsafe types", () => {
  const root = "ohm-v0.0.0-linux-x64";
  assert.doesNotThrow(() => assertStandaloneArchiveListing(
    [`${root}/`, `${root}/bin/ohm`],
    ["drwxr-xr-x root/root 0 fixture", "-rwxr-xr-x root/root 1 fixture"],
    root,
  ));
  for (const entry of [`${root}/../outside`, `${root}/dir\\..\\outside`, `${root}//outside`]) {
    assert.throws(
      () => assertStandaloneArchiveListing([`${root}/`, entry], ["drwxr-xr-x fixture"], root),
      /(?:non-portable|traversal)/u,
    );
  }
  for (const type of ["l", "h", "p", "b", "c"]) {
    assert.throws(
      () => assertStandaloneArchiveListing([`${root}/`], [`${type}rwxr-xr-x fixture`], root),
      /unsupported entry type/u,
    );
  }
});

test("standalone archive bytes are deterministic for identical content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-archive-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = resolve(root, "payload");
  await mkdir(resolve(source, "bin"), { recursive: true });
  await writeFile(resolve(source, "BUILD-METADATA.json"), "{\n  \"schemaVersion\": 1\n}\n");
  await writeFile(resolve(source, "bin/ohm"), "#!/bin/sh\n", { mode: 0o755 });
  const longName = `${"dependency-generated-name-".repeat(5)}.js`;
  await writeFile(resolve(source, longName), "export {};\n");
  const first = resolve(root, "first.tar.gz");
  const second = resolve(root, "second.tar.gz");
  await createStandaloneArchive(source, first, "ohm-v0.0.0-linux-x64");
  await createStandaloneArchive(source, second, "ohm-v0.0.0-linux-x64");
  assert.deepEqual(await readFile(first), await readFile(second));
  const tar = gunzipSync(await readFile(first));
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.includes(Buffer.from(`path=ohm-v0.0.0-linux-x64/${longName}\n`)), true);
  assert.equal(tar.subarray(-1024).every((byte) => byte === 0), true);
});

test("standalone archives materialize safe file symlinks and reject unsafe roots or targets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-links-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = resolve(root, "payload");
  await mkdir(resolve(source, "bin"), { recursive: true });
  await mkdir(resolve(source, "lib/node_modules/.bin"), { recursive: true });
  await writeFile(resolve(source, "bin/ohm"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink("../../../bin/ohm", resolve(source, "lib/node_modules/.bin/ohm"));
  await link(resolve(source, "bin/ohm"), resolve(source, "bin/ohm-hardlink"));
  const archive = resolve(root, "standalone.tar.gz");

  await createStandaloneArchive(source, archive, "ohm-v0.0.0-linux-x64");
  const entries = parseTarEntries(gunzipSync(await readFile(archive)));
  assert.equal(entries.find(({ path }) => path.endsWith("/lib/node_modules/.bin/ohm"))?.type, "0");
  assert.equal(entries.find(({ path }) => path.endsWith("/bin/ohm-hardlink"))?.type, "0");
  assert.equal(entries.some(({ type }) => type === "1" || type === "2"), false);

  await symlink(root, resolve(root, "ancestor-alias"), "dir");
  await assert.doesNotReject(
    createStandaloneArchive(
      resolve(root, "ancestor-alias/payload"),
      resolve(root, "aliased-ancestor.tar.gz"),
      "ohm-v0.0.0-linux-x64",
    ),
  );
  await assert.rejects(
    createStandaloneArchive(source, resolve(root, "bad-root.tar.gz"), ".."),
    /one portable path component/u,
  );
  await symlink(source, resolve(root, "linked-payload"), "dir");
  await assert.rejects(
    createStandaloneArchive(resolve(root, "linked-payload"), resolve(root, "linked-root.tar.gz"), "ohm-v0.0.0-linux-x64"),
    /source must be a real directory/u,
  );
  await writeFile(resolve(root, "outside"), "outside\n");
  await symlink(resolve(root, "outside"), resolve(source, "escaping-link"));
  await assert.rejects(
    createStandaloneArchive(source, resolve(root, "escaping.tar.gz"), "ohm-v0.0.0-linux-x64"),
    /symlink escapes its payload/u,
  );
});

test("release finalization records every target archive in the updater schema", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-release-finalize-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const directory = resolve(root, "release");
  const standaloneDirectory = resolve(root, "standalone");
  await Promise.all([mkdir(directory), mkdir(standaloneDirectory)]);
  const policy = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "packages/ohm/release/platforms.json"), "utf8"));
  const version = "9.8.7";
  const npmContents = Buffer.from("npm archive fixture\n");
  const npmArchive = {
    name: "ohm",
    version,
    file: `ohm-${version}.tgz`,
    sha256: createHash("sha256").update(npmContents).digest("hex"),
    integrity: "sha512-fixture",
    bytes: npmContents.length,
  };
  const sourceContents = Buffer.from("source archive fixture\n");
  const source = {
    schemaVersion: 1,
    file: `ohm-v${version}-source.tar.gz`,
    root: `ohm-v${version}`,
    commit: "1".repeat(40),
    sha256: createHash("sha256").update(sourceContents).digest("hex"),
    bytes: sourceContents.length,
  };
  await writeFile(resolve(directory, npmArchive.file), npmContents);
  await writeFile(resolve(directory, source.file), sourceContents);
  const sbomFile = `ohm-v${version}.spdx.json`;
  await writeFile(resolve(directory, sbomFile), `${JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `ohm-workspace@${version}`,
    documentNamespace: "urn:uuid:nondeterministic-fixture",
    creationInfo: {
      created: "2026-07-25T15:21:37.124Z",
      creators: ["Tool: npm"],
    },
    packages: [{ SPDXID: "SPDXRef-Package", name: "ohm-workspace", versionInfo: version }],
    relationships: [{
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package",
    }],
  }, null, 2)}\n`);
  await writeFile(resolve(directory, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 4,
    product: "ohm",
    version,
    tag: `v${version}`,
    packaging: "github-release",
    node: ">=26.7.0",
    nodeRuntime: policy.nodeRuntime.version,
    archive: npmArchive,
    archives: [npmArchive],
    source,
    standalones: [],
    checksumFile: "SHA256SUMS",
    releaseNotes: "RELEASE_NOTES.md",
    targets: policy.targets,
  }, null, 2)}\n`);
  for (const target of policy.targets) {
    const file = `ohm-v${version}-${target.platform}-${target.arch}.tar.gz`;
    const contents = Buffer.from(`${target.platform}/${target.arch}\n`);
    await writeFile(resolve(standaloneDirectory, file), contents);
    await writeFile(resolve(standaloneDirectory, `${file}.json`), `${JSON.stringify({
      schemaVersion: 1,
      product: "ohm",
      version,
      platform: target.platform,
      arch: target.arch,
      node: policy.nodeRuntime.version,
      entrypoint: target.platform === "win32" ? "bin/ohm.cmd" : "bin/ohm",
      file,
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length,
    }, null, 2)}\n`);
  }

  await finalizeRelease({ directory, standaloneDirectory });
  const finalized = JSON.parse(await readFile(resolve(directory, "release-manifest.json"), "utf8"));
  assert.equal(finalized.schemaVersion, 4);
  assert.deepEqual(Object.keys(finalized).sort(), [...RELEASE_MANIFEST_KEYS].sort());
  assert.equal(Object.hasOwn(finalized, "sbom"), false);
  assert.deepEqual(
    finalized.standalones.map(({ platform, arch }) => ({ platform, arch })),
    policy.targets.map(({ platform, arch }) => ({ platform, arch })),
  );
  const checksums = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    checksums.trimEnd().split("\n").map((line) => line.slice(66)),
    [npmArchive.file, source.file, ...finalized.standalones.map(({ file }) => file), sbomFile],
  );
  const marker = JSON.parse(await readFile(resolve(directory, ".ohm-release-output.json"), "utf8"));
  assert.equal(marker.archives.length, 3 + policy.targets.length);
});
