export function githubCopilotHeaders(token: string, editorVersion = "ohm/0.1.1") {
  return { authorization: `Bearer ${token}`, "editor-version": editorVersion, "user-agent": editorVersion };
}
