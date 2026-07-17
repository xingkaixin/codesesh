import { registerAgent } from "./registry.js";
import { ClaudeCodeAgent } from "./claudecode.js";
import { OpenCodeAgent } from "./opencode.js";
import { KimiAgent } from "./kimi.js";
import { CodexAgent } from "./codex.js";
import { CursorAgent } from "./cursor.js";
import { PiAgent } from "./pi.js";
import { ZCodeAgent } from "./zcode.js";

registerAgent({
  icon: "/icon/agent/claudecode.svg",
  create: () => new ClaudeCodeAgent(),
});

registerAgent({
  icon: "/icon/agent/opencode.svg",
  create: () => new OpenCodeAgent(),
});

registerAgent({
  icon: "/icon/agent/zcode.svg",
  create: () => new ZCodeAgent(),
});

registerAgent({
  icon: "/icon/agent/kimi.svg",
  create: () => new KimiAgent(),
});

registerAgent({
  icon: "/icon/agent/codex.svg",
  create: () => new CodexAgent(),
});

registerAgent({
  icon: "/icon/agent/pi.svg",
  create: () => new PiAgent(),
});

registerAgent({
  icon: "/icon/agent/cursor.svg",
  create: () => new CursorAgent(),
});
