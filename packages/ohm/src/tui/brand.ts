export function ohmCompactSignature(version: string, unicode = true): string {
  return unicode ? `ohm ${version} · ready` : `ohm ${version} - ready`;
}

export function ohmTerminalLockup(version: string, unicode = true): string {
  return `${ohmCompactSignature(version, unicode)}\nprogrammable agent harness`;
}
