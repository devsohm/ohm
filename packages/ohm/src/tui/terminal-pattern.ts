/** Builds terminal-control expressions from runtime strings so they remain explicit boundary data. */
export function terminalPattern(pattern: string, flags?: string): RegExp {
  return new RegExp(pattern, flags);
}
