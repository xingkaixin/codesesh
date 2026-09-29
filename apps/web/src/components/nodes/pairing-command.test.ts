import { describe, expect, it } from "vitest";
import { pairingCommand } from "./pairing-command";

describe("pairingCommand", () => {
  it("supports local and LAN HTTP and offers foreground or background commands", () => {
    expect(pairingCommand("http://127.0.0.1:4521", "local", false)).toBe(
      'codesesh worker --hub "http://127.0.0.1:4521" --pair-token-stdin',
    );
    expect(pairingCommand("http://office.local:4521", "lan", true)).toBe(
      'codesesh worker start --hub "http://office.local:4521" --pair-token-stdin',
    );
    expect(pairingCommand("http://192.168.1.10:4521", "lan", false)).not.toBeNull();
    expect(pairingCommand("https://history.example.com", "public", false)).not.toBeNull();
  });
  it("rejects incompatible scopes, credentials, paths and shell syntax", () => {
    expect(pairingCommand("http://example.com", "public", false)).toBeNull();
    expect(pairingCommand("http://localhost:4521", "lan", false)).toBeNull();
    expect(pairingCommand("http://192.168.1.10", "local", false)).toBeNull();
    for (const address of [
      "http://user:secret@localhost",
      "http://localhost/path",
      "http://localhost/?token=x",
      "http://a'$(whoami).local",
    ]) {
      expect(pairingCommand(address, "lan", false)).toBeNull();
    }
  });
});
