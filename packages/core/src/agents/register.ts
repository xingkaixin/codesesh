import { registerAgent } from "./registry.js";
import { ClaudeCodeAgent, resolveClaudeCodeDataRoot } from "./claudecode.js";
import { OpenCodeAgent, resolveOpenCodeDataRoot } from "./opencode.js";
import { KimiAgent, resolveKimiDataRoot } from "./kimi.js";
import { CodexAgent, resolveCodexDataRoot } from "./codex.js";
import { CursorAgent, resolveCursorDataRoot } from "./cursor.js";
import { PiAgent, resolvePiDataRoot } from "./pi.js";
import { ZCodeAgent, resolveZCodeDataRoot } from "./zcode.js";

registerAgent({
  icon: "/icon/agent/claudecode.svg",
  iconColored: true,
  resolveDataRoot: resolveClaudeCodeDataRoot,
  resumeCommandPrefix: "claude --resume",
  toolStrategy: "custom",
  create: () => new ClaudeCodeAgent(),
});

registerAgent({
  icon: "/icon/agent/opencode.svg",
  resolveDataRoot: resolveOpenCodeDataRoot,
  resumeCommandPrefix: "opencode -s",
  toolStrategy: "custom",
  create: () => new OpenCodeAgent(),
});

registerAgent({
  icon: "/icon/agent/zcode.svg",
  resolveDataRoot: resolveZCodeDataRoot,
  resumeCommandPrefix: null,
  toolStrategy: "custom",
  create: () => new ZCodeAgent(),
});

registerAgent({
  icon: "/icon/agent/kimi.svg",
  resolveDataRoot: resolveKimiDataRoot,
  resumeCommandPrefix: "kimi -r",
  toolStrategy: "custom",
  create: () => new KimiAgent(),
});

registerAgent({
  icon: "/icon/agent/codex.svg",
  resolveDataRoot: resolveCodexDataRoot,
  resumeCommandPrefix: "codex resume",
  toolStrategy: "custom",
  create: () => new CodexAgent(),
});

registerAgent({
  icon: "/icon/agent/pi.svg",
  resolveDataRoot: resolvePiDataRoot,
  resumeCommandPrefix: "pi --session",
  toolStrategy: "custom",
  create: () => new PiAgent(),
});

registerAgent({
  icon: "/icon/agent/cursor.svg",
  resolveDataRoot: resolveCursorDataRoot,
  resumeCommandPrefix: null,
  toolStrategy: "custom",
  create: () => new CursorAgent(),
});
