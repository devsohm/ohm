import {
  createDefaultCredentialStore,
  type DefaultCredentialStoreOptions,
} from "../../src/auth/default-store.js";
import type { CredentialStore } from "../../src/auth/types.js";
import { STRING_VALUE } from "../../src/core/value-schemas.js";
import { Check } from "typebox/value";

const liveAuthPathKey = Symbol.for("ohm.test.live-auth-path");
const capturedPathDescriptor = Reflect.getOwnPropertyDescriptor(globalThis, liveAuthPathKey);
const capturedPath = capturedPathDescriptor !== undefined && "value" in capturedPathDescriptor
  ? capturedPathDescriptor.value
  : undefined;
Reflect.deleteProperty(globalThis, liveAuthPathKey);

export async function liveCredentialStore(options: { allowPlatformKeychain?: boolean } = {}): Promise<CredentialStore> {
  if (!Check(STRING_VALUE, capturedPath) || capturedPath === "") {
    throw new Error("Live tests require an isolated setup with a captured authentication path");
  }
  const storeOptions: DefaultCredentialStoreOptions = { createLocalKey: false };
  if (options.allowPlatformKeychain !== undefined) {
    storeOptions.allowPlatformKeychain = options.allowPlatformKeychain;
  }
  return await createDefaultCredentialStore(capturedPath, storeOptions);
}
