export function modelColor(model: string): string {
  // FNV-1a binds color to the model ID, independent of rankings and filters.
  let hash = 2166136261;
  for (const character of model) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `oklch(0.65 0.16 ${(hash >>> 0) % 360})`;
}
