/** Shared horizontal geometry for composer rendering and cursor navigation. */
export function composerGeometry(columns: number, paddingX = 0) {
  const available = Number.isFinite(columns) ? Math.max(1, Math.trunc(columns)) : 1;
  const gutter = available >= 8 ? 2 : 0;
  const requested = Number.isFinite(paddingX) ? Math.max(0, Math.min(3, Math.trunc(paddingX))) : 0;
  const padding = Math.min(requested, Math.floor((available - gutter - 1) / 2));
  return { padding, gutter, width: Math.max(1, available - padding * 2 - gutter) };
}
