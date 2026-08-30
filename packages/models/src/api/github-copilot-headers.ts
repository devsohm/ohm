export function githubCopilotHeaders(token: string, editorVersion = "ohm/0.1.0") {
  return { authorization: `Bearer ${token}`, "editor-version": editorVersion, "user-agent": editorVersion };
}
