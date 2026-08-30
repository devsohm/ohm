import { createFixtureProtocol } from "./protocol.mjs";

const versionIndex = process.argv.indexOf("--protocol-version");
const protocol = createFixtureProtocol({
  exit: (code) => process.exit(code),
  protocolVersion: versionIndex < 0 ? "2025-06-18" : process.argv[versionIndex + 1],
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  sendRaw: (frame) => process.stdout.write(frame),
});

let buffer = "";
const keepAlive = setInterval(() => undefined, 60_000);
process.stdin.setEncoding("utf8");
process.stdin.once("end", () => {
  clearInterval(keepAlive);
  protocol.close();
});
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const frame = buffer.slice(0, newline).replace(/\r$/u, "");
    buffer = buffer.slice(newline + 1);
    try {
      protocol.handle(JSON.parse(frame));
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      process.exitCode = 1;
      process.stdin.pause();
      break;
    }
  }
});
process.stdin.resume();
