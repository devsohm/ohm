import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const liveSuite = process.env.OHM_LIVE === "1"
  || process.env.OHM_LIVE_DOGFOOD === "1"
  || process.env.OHM_LIVE_SESSION === "1"
  || process.env.npm_lifecycle_event === "test:live"
  || process.env.npm_lifecycle_event === "test:live:session";
const liveAuthPathKey = Symbol.for("ohm.test.live-auth-path");
const npmCachePathKey = Symbol.for("ohm.test.npm-cache-path");
const originalHome = homedir();
Reflect.deleteProperty(globalThis, liveAuthPathKey);
Reflect.deleteProperty(globalThis, npmCachePathKey);
Object.defineProperty(globalThis, npmCachePathKey, {
  configurable: true,
  enumerable: false,
  value: process.env.npm_config_cache?.trim() || (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(originalHome, "AppData", "Local"), "npm-cache")
    : join(originalHome, ".npm")),
  writable: false,
});
if (liveSuite) {
  const configuredAgentDirectory = process.env.OHM_HOME?.trim();
  const expandedAgentDirectory = configuredAgentDirectory === undefined || configuredAgentDirectory === ""
    ? join(originalHome, ".ohm")
    : configuredAgentDirectory === "~"
      ? originalHome
      : configuredAgentDirectory.startsWith("~/")
        ? join(originalHome, configuredAgentDirectory.slice(2))
        : isAbsolute(configuredAgentDirectory)
          ? configuredAgentDirectory
          : resolve(configuredAgentDirectory);
  Object.defineProperty(globalThis, liveAuthPathKey, {
    configurable: true,
    enumerable: false,
    value: join(expandedAgentDirectory, "auth.json"),
    writable: false,
  });
}
delete process.env.OHM_TEST_LIVE_AUTH_PATH;

const canonicalTemporaryDirectory = realpathSync(process.env.RUNNER_TEMP ?? tmpdir());
const isolatedRoot = mkdtempSync(join(canonicalTemporaryDirectory, "ohm-test-home-"));
process.env.TMPDIR = isolatedRoot;
process.env.TMP = isolatedRoot;
process.env.TEMP = isolatedRoot;
const isolatedHome = join(isolatedRoot, "home");
if (!liveSuite && process.platform === "linux") {
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(isolatedRoot, "unavailable-secret-service")}`;
}
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = join(isolatedRoot, "config");
process.env.XDG_STATE_HOME = join(isolatedRoot, "state");
process.env.XDG_CACHE_HOME = join(isolatedRoot, "cache");
process.env.XDG_DATA_HOME = join(isolatedRoot, "data");
process.env.OHM_HOME = join(isolatedHome, ".ohm");
process.env.OHM_TEST_ISOLATED_ROOT = isolatedRoot;
process.once("exit", () => rmSync(isolatedRoot, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
}));
