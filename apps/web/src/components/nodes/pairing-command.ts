export type ConnectionScope = "local" | "lan" | "public";

export function pairingCommand(
  address: string,
  scope: ConnectionScope,
  background: boolean,
): string | null {
  try {
    const url = new URL(address);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(url.origin)) return null;
    const local =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      (url.hostname.startsWith("127.") &&
        url.hostname.split(".").every((part) => /^\d+$/.test(part)));
    if (scope === "local" && !local) return null;
    if (scope === "lan" && local) return null;
    if (scope === "public" && (url.protocol !== "https:" || local)) return null;
    return `codesesh worker${background ? " start" : ""} --hub "${url.origin}" --pair-token-stdin`;
  } catch {
    return null;
  }
}
