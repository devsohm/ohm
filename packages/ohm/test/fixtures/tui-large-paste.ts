import { createHash } from "node:crypto";
import { createRichTuiController } from "../../src/tui/rich-frame-projector.js";

const controller = createRichTuiController({ handleSignals: false });
const timeout = setTimeout(() => {
  controller.close();
  process.stderr.write("paste-pty-timeout\n");
  process.exitCode = 1;
}, 5_000);

controller.start();
void controller.question("paste> ").then((answer) => {
  clearTimeout(timeout);
  controller.close();
  const digest = createHash("sha256").update(answer).digest("hex");
  process.stdout.write(`paste-pty:${Buffer.byteLength(answer)}:${digest}\n`);
}, (cause: unknown) => {
  clearTimeout(timeout);
  controller.close();
  process.stderr.write(`paste-pty-error:${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
