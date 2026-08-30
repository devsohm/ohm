import { renderTranscript } from "../../src/tui/layout.js";
import { projectRichTuiFrame } from "../../src/tui/rich-frame-projector.js";
import { createTheme } from "../../src/tui/theme.js";

const columns = process.stdout.columns ?? 80;
const theme = createTheme("signal", { color: true, unicode: true });
const rendered = renderTranscript([{
  id: "pty-user",
  kind: "user",
  text: "你好🙂 alpha beta\n\nomega",
}], columns, theme, { outputPad: 1 });
const imageOnly = renderTranscript([{
  id: "pty-image-only-user",
  kind: "user",
  text: "",
  images: [{
    key: "pty-image-only-user:image:0",
    block: { type: "image", mediaType: "image/png", data: Buffer.from("fixture").toString("base64") },
  }],
}], columns, theme, { outputPad: 1 });
const tool = renderTranscript([{
  id: "pty-wide-tool",
  kind: "tool",
  title: "bash",
  text: "wide tool output",
  status: "completed",
  toolData: { input: { command: "npm test" } },
}], columns, theme, { outputPad: 1 });
const richFrame = projectRichTuiFrame({
  view: {
    context: { active: false, status: "idle" },
    transcript: [{ id: "rich-pty-user", kind: "user", text: "你好🙂 alpha beta\n\nomega" }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  },
  size: { columns, rows: 20 },
  theme,
  transcriptOptions: { outputPad: 1 },
  themeName: "signal",
  color: true,
  unicode: true,
  thinkingExpanded: false,
  toolDetailsExpanded: false,
  hideReasoningBlock: false,
  editorPaddingX: 0,
  outputPad: 1,
  codeBlockIndent: "",
});
if (richFrame === undefined) throw new Error("Rich user-message fixture did not fit the PTY");

process.stdout.write([
  `user-message-start\n${rendered}\nuser-message-end`,
  `rich-user-message-start\n${richFrame.text}\nrich-user-message-end`,
  `image-only-message-start\n${imageOnly}\nimage-only-message-end`,
  `tool-card-start\n${tool}\ntool-card-end`,
  "",
].join("\n"));
