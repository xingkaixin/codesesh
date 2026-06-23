import { registerAgent } from "./registry.js";
import { ClaudeCodeAgent } from "./claudecode.js";
import { OpenCodeAgent } from "./opencode.js";
import { KimiAgent } from "./kimi.js";
import { CodexAgent } from "./codex.js";
import { CursorAgent } from "./cursor.js";
import { PiAgent } from "./pi.js";
import { ZCodeAgent } from "./zcode.js";

registerAgent({
  name: "claudecode",
  displayName: "Claude Code",
  icon: "/icon/agent/claudecode.svg",
  create: () => new ClaudeCodeAgent(),
});

registerAgent({
  name: "opencode",
  displayName: "OpenCode",
  icon: "/icon/agent/opencode.svg",
  create: () => new OpenCodeAgent(),
});

registerAgent({
  name: "zcode",
  displayName: "ZCode",
  icon: "/icon/agent/zcode.svg",
  create: () => new ZCodeAgent(),
});

registerAgent({
  name: "kimi",
  displayName: "Kimi-Cli",
  icon: "/icon/agent/kimi.svg",
  create: () => new KimiAgent(),
});

registerAgent({
  name: "codex",
  displayName: "Codex",
  icon: "/icon/agent/codex.svg",
  create: () => new CodexAgent(),
});

registerAgent({
  name: "pi",
  displayName: "Pi",
  icon: "/icon/agent/pi.svg",
  create: () => new PiAgent(),
});

registerAgent({
  name: "cursor",
  displayName: "Cursor",
  icon: "/icon/agent/cursor.svg",
  create: () => new CursorAgent(),
});
