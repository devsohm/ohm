import { createRichTuiController } from "../../src/tui/rich-frame-projector.js";

const controller = createRichTuiController({ handleSignals: false });
const timeout = setTimeout(() => {
  controller.close();
  process.stderr.write("keyboard-pty-timeout\n");
  process.exitCode = 1;
}, 5_000);

controller.start();
void controller.question("keyboard> ").then((answer) => {
  clearTimeout(timeout);
  controller.close();
  process.stdout.write(`keyboard-pty:${answer}\n`);
}, (cause: unknown) => {
  clearTimeout(timeout);
  controller.close();
  process.stderr.write(`keyboard-pty-error:${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
