export function getPnpmInvocation(platform = process.platform) {
  const windows = platform === "win32";
  return { executable: windows ? "pnpm.cmd" : "pnpm", shell: windows };
}
