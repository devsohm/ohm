import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { isRecordValue, isStringValue } from "./value-checks.mjs";

const MANIFEST_NAME = "third-party-manifest.json";
const BUNDLE_DIRECTORY = "third-party";
const MAX_PACKAGES = 4_096;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const LEGAL_DOCUMENT = /^(?:licen[cs]e|copying|notice|third[-_. ]party)(?:$|[-_. ])/iu;
const ASSET_ROOT = new URL("./third-party-license-assets/", import.meta.url);

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const portable = (root, path) => relative(root, path).split(sep).join("/");
const firstParty = (name) => name === "ohm" || name.startsWith("@ohm/");
const pinnedDocument = (asset, source, digest, removeFinalLf = false) => ({
  asset: new URL(asset, ASSET_ROOT), source, sha256: digest, removeFinalLf,
});
const PROXY_AGENT_NEGOTIATE_NOTICE = Buffer.from(`(The MIT License)

Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`);
const AWS_SDK_LICENSE = pinnedDocument(
  "aws-sdk-js-v3-d760a008-LICENSE.txt",
  "aws/aws-sdk-js-v3/d760a00859a08b5d04590ee047510b49add12361/LICENSE",
  "edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d",
  true,
);
const PACKAGE_DOCUMENT_OVERRIDES = new Map([
  ["proxy-agent-negotiate@1.1.0", {
    license: "MIT",
    documents: [{
      source: "proxy-agents/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/http-proxy-agent/LICENSE",
      sha256: "71368fd0f5b4129191e9afcd1e1ef2dc89a9090d3e4d80bbab92dafd032b3bef",
      bytes: PROXY_AGENT_NEGOTIATE_NOTICE,
    }],
  }],
  ["@aws-sdk/credential-provider-http@3.972.72", { license: "Apache-2.0", documents: [AWS_SDK_LICENSE] }],
  ["@aws-sdk/credential-provider-login@3.972.77", { license: "Apache-2.0", documents: [AWS_SDK_LICENSE] }],
  ["@aws-sdk/nested-clients@3.997.44", { license: "Apache-2.0", documents: [AWS_SDK_LICENSE] }],
  ["data-uri-to-buffer@4.0.1", {
    license: "MIT",
    documents: [pinnedDocument(
      "data-uri-to-buffer-4.0.1-LICENSE.txt",
      "TooTallNate/node-data-uri-to-buffer/85cd8c854aefbf1bb636789d80364cfac8ea1583/README.md#license",
      "3072ef4a004c4f92b37eae61cdc3e27225c0a7d2f5e144700e40b9c5a5a7a9b9",
    )],
  }],
  ["standardwebhooks@1.0.0", {
    license: "MIT",
    documents: [pinnedDocument(
      "standardwebhooks-1.0.0-LICENSE.txt",
      "standard-webhooks/standard-webhooks/929bf0c1928b188287eaf88d0a9f0a4e87df6499/libraries/LICENSE",
      "5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27",
    )],
  }],
]);

async function regularFile(path, maximum, label) {
  const info = await lstat(path);
  assert.ok(info.isFile(), `${label} must be a regular file`);
  assert.ok(info.size <= maximum, `${label} exceeds ${maximum} bytes`);
  return readFile(path);
}

async function packageDocuments(directory, manifest) {
  const override = PACKAGE_DOCUMENT_OVERRIDES.get(`${manifest.name}@${manifest.version}`);
  if (override !== undefined) {
    assert.equal(override.license, manifest.license,
      `Pinned documents for ${manifest.name}@${manifest.version} do not match its license declaration`);
    const documents = [];
    for (const document of override.documents) {
      let bytes = document.bytes;
      if (bytes === undefined) {
        bytes = await regularFile(document.asset, MAX_DOCUMENT_BYTES,
          `Pinned package document for ${manifest.name}@${manifest.version}`);
        if (document.removeFinalLf) {
          assert.equal(bytes.at(-1), 0x0a,
            `Pinned package document for ${manifest.name}@${manifest.version} is missing its storage newline`);
          bytes = bytes.subarray(0, -1);
        }
      }
      assert.equal(sha256(bytes), document.sha256,
        `Pinned package document for ${manifest.name}@${manifest.version} does not match its digest`);
      documents.push({ source: document.source, bytes });
    }
    return documents;
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => LEGAL_DOCUMENT.test(entry.name))
    .sort((left, right) => compare(left.name, right.name));
  assert.ok(entries.length > 0, `Package ${directory} has no license or notice document and no pinned override`);
  const documents = [];
  for (const entry of entries) {
    const bytes = await regularFile(join(directory, entry.name), MAX_DOCUMENT_BYTES, `Package document ${entry.name}`);
    documents.push({ source: entry.name, bytes });
  }
  return documents;
}

async function installedPackages(nodeModulesRoot) {
  const root = resolve(nodeModulesRoot);
  const packages = [];

  const visitPackage = async (directory) => {
    const manifestBytes = await regularFile(
      join(directory, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
      `Package manifest ${directory}`,
    );
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Package manifest ${directory} is invalid JSON`, { cause: error });
    }
    assert.ok(isRecordValue(manifest),
      `Package manifest ${directory} must be an object`);
    assert.ok(isStringValue(manifest.name) && manifest.name !== "", `Package ${directory} has no name`);
    assert.ok(isStringValue(manifest.version) && manifest.version !== "", `Package ${manifest.name} has no version`);
    if (!firstParty(manifest.name)) {
      assert.ok(isStringValue(manifest.license) && manifest.license.trim() !== "",
        `Package ${manifest.name}@${manifest.version} has no license declaration`);
      packages.push({
        path: portable(root, directory),
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        documents: await packageDocuments(directory, manifest),
      });
      assert.ok(packages.length <= MAX_PACKAGES, `Installed package count exceeds ${MAX_PACKAGES}`);
    }
    const nested = join(directory, "node_modules");
    try {
      await visitModules(nested);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };

  const visitScope = async (directory) => {
    const info = await lstat(directory);
    assert.ok(info.isDirectory(), `Package scope ${directory} must be a real directory`);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name))) {
      if (!entry.isDirectory()) throw new Error(`Package ${join(directory, entry.name)} must be a real directory`);
      await visitPackage(join(directory, entry.name));
    }
  };

  async function visitModules(directory) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory(), `node_modules path ${directory} must be a real directory`);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name))) {
      if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) await visitScope(path);
      else {
        if (!entry.isDirectory()) throw new Error(`Package ${path} must be a real directory`);
        await visitPackage(path);
      }
    }
  }

  await visitModules(root);
  return packages.sort((left, right) =>
    compare(left.name, right.name) || compare(left.version, right.version) || compare(left.path, right.path));
}

function documentPath(packagePath, index) {
  return `${BUNDLE_DIRECTORY}/${sha256(packagePath)}/${String(index).padStart(2, "0")}.txt`;
}

async function bundleFiles(directory, root = directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await bundleFiles(path, root));
    else {
      if (!entry.isFile()) throw new Error(`License bundle entry ${path} must be a regular file`);
      result.push(portable(root, path));
    }
  }
  return result;
}

export async function createThirdPartyLicenseBundle(nodeModulesRoot, licensesRoot) {
  const licenses = resolve(licensesRoot);
  const bundleRoot = join(licenses, BUNDLE_DIRECTORY);
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
  const packages = [];
  for (const entry of await installedPackages(nodeModulesRoot)) {
    const documents = [];
    for (const [index, document] of entry.documents.entries()) {
      const path = documentPath(entry.path, index);
      await mkdir(resolve(licenses, path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(resolve(licenses, path), document.bytes, { mode: 0o600 });
      documents.push({
        source: document.source,
        path,
        bytes: document.bytes.byteLength,
        sha256: sha256(document.bytes),
      });
    }
    packages.push({ path: entry.path, name: entry.name, version: entry.version, license: entry.license, documents });
  }
  const manifest = { schemaVersion: 1, packages };
  await writeFile(join(licenses, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await verifyThirdPartyLicenseBundle(nodeModulesRoot, licenses);
  return manifest;
}

export async function verifyThirdPartyLicenseBundle(nodeModulesRoot, licensesRoot) {
  const licenses = resolve(licensesRoot);
  const manifestBytes = await regularFile(join(licenses, MANIFEST_NAME), MAX_MANIFEST_BYTES, "Third-party license manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Third-party license manifest is invalid JSON", { cause: error });
  }
  assert.deepEqual(Object.keys(manifest).sort(), ["packages", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.packages), "Third-party license manifest packages must be an array");

  const expected = await installedPackages(nodeModulesRoot);
  assert.equal(manifest.packages.length, expected.length, "Third-party license package count does not match installed packages");
  const expectedFiles = [];
  for (const [packageIndex, source] of expected.entries()) {
    const entry = manifest.packages[packageIndex];
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["documents", "license", "name", "path", "version"],
      `Third-party license entry ${packageIndex} has an invalid shape`,
    );
    assert.deepEqual(
      { path: entry.path, name: entry.name, version: entry.version, license: entry.license },
      { path: source.path, name: source.name, version: source.version, license: source.license },
      `Third-party license entry ${packageIndex} does not match the installed package`,
    );
    assert.ok(Array.isArray(entry.documents) && entry.documents.length === source.documents.length,
      `Third-party license documents do not match ${source.name}@${source.version}`);
    for (const [documentIndex, sourceDocument] of source.documents.entries()) {
      const document = entry.documents[documentIndex];
      const expectedPath = documentPath(source.path, documentIndex);
      assert.deepEqual(Object.keys(document).sort(), ["bytes", "path", "sha256", "source"]);
      assert.deepEqual(
        document,
        {
          source: sourceDocument.source,
          path: expectedPath,
          bytes: sourceDocument.bytes.byteLength,
          sha256: sha256(sourceDocument.bytes),
        },
        `Third-party license metadata does not match ${source.name}@${source.version}`,
      );
      const copied = await regularFile(resolve(licenses, expectedPath), MAX_DOCUMENT_BYTES, `Bundled license ${expectedPath}`);
      assert.equal(copied.byteLength, document.bytes, `Bundled license ${expectedPath} bytes do not match`);
      assert.equal(sha256(copied), document.sha256, `Bundled license ${expectedPath} digest does not match`);
      expectedFiles.push(expectedPath.slice(`${BUNDLE_DIRECTORY}/`.length));
    }
  }
  assert.deepEqual(
    await bundleFiles(join(licenses, BUNDLE_DIRECTORY)),
    expectedFiles.sort(compare),
    "Third-party license bundle contains missing or unlisted documents",
  );
  return manifest;
}
