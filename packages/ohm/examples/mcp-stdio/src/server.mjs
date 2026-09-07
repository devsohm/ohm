import { fileURLToPath } from "node:url";

/**
 * Copy this package and replace the fixture argv plus this explicit mapping.
 * Remote tools not present in toolNames are never registered with ohm.
 */
export default Object.freeze({
  id: "fixture",
  argv: Object.freeze([
    process.execPath,
    fileURLToPath(new URL("../fixture/server.mjs", import.meta.url)),
  ]),
  env: Object.freeze({}),
  toolNames: Object.freeze({
    "fixture.echo": "example_mcp_echo",
    "fixture.add": "example_mcp_add",
    "fixture.slow": "example_mcp_slow",
    "fixture.cancelled": "example_mcp_cancelled",
    "fixture.catalog-change": "example_mcp_catalog_change",
    "fixture.state": "example_mcp_state",
    "fixture.pid": "example_mcp_pid",
    "fixture.client-request": "example_mcp_client_request",
    "fixture.malformed": "example_mcp_malformed",
    "fixture.oversized": "example_mcp_oversized",
    "fixture.die": "example_mcp_die",
  }),
  requestTimeoutMs: 30_000,
});
