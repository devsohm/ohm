import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../../src/core/json.js";
import { openBedrockSdkStream } from "../../src/providers/bedrock-sdk-transport.js";

interface FakeBedrockClientConfig {
  readonly region?: string;
  readonly requestHandler?: {
    readonly metadata?: { readonly handlerProtocol?: string };
  };
}

test("Bedrock SDK transport advertises HTTP/1.1 through the host-owned request handler", async () => {
  let capturedConfig: FakeBedrockClientConfig | undefined;
  let capturedCommand: JsonObject | undefined;
  let destroyed = false;

  class FakeBedrockRuntimeClient {
    readonly middlewareStack = {
      add(): void {},
    };

    constructor(config: FakeBedrockClientConfig) {
      capturedConfig = config;
    }

    async send(command: { input: JsonObject }): Promise<{
      $metadata: { requestId: string };
      stream: AsyncIterable<never>;
    }> {
      capturedCommand = command.input;
      return {
        $metadata: { requestId: "request-sdk" },
        stream: (async function* (): AsyncGenerator<never> {})(),
      };
    }

    destroy(): void {
      destroyed = true;
    }
  }

  class FakeConverseStreamCommand {
    constructor(readonly input: JsonObject) {}
  }

  const sdkFixture: typeof import("@aws-sdk/client-bedrock-runtime") = JSON.parse(
    "null",
    () => ({
      BedrockRuntimeClient: FakeBedrockRuntimeClient,
      ConverseStreamCommand: FakeConverseStreamCommand,
    }),
  );

  const opened = await openBedrockSdkStream({
    modelId: "model-test",
    body: { messages: [{ role: "user", content: [{ text: "hello" }] }] },
    region: "us-east-1",
    endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
    headers: new Headers(),
    credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    signal: new AbortController().signal,
    fetch: () => {
      throw new Error("the fake SDK must not perform network I/O");
    },
    onResponse(): void {},
    loadSdk: async () => sdkFixture,
  });

  const requestHandler = capturedConfig?.requestHandler;
  assert.equal(requestHandler?.metadata?.handlerProtocol, "http/1.1");
  assert.equal(capturedConfig?.region, "us-east-1");
  assert.deepEqual(capturedCommand, {
    modelId: "model-test",
    messages: [{ role: "user", content: [{ text: "hello" }] }],
  });
  assert.equal(opened.requestId, "request-sdk");
  for await (const _event of opened.stream) {
    // Consume the owned stream so its client is disposed.
  }
  assert.equal(destroyed, true);
});
