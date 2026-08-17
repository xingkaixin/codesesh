import type { SessionDetail, SessionHead } from "../../../types/index.js";
import { createSessionIdentity } from "../../../contract/session-reference.js";

export const TEST_NOW = 1_700_000_000_000;

export function makeSessionHead(
  id: string,
  overrides: Partial<SessionHead> = {},
): SessionHead & Pick<SessionDetail, "reference"> {
  const identity = createSessionIdentity(
    overrides.reference ?? { agentName: "codex", sessionId: id },
  );
  return {
    ...identity,
    title: `Session ${id}`,
    directory: "/workspace/project",
    project_identity: {
      kind: "path",
      key: "/workspace/project",
      displayName: "project",
    },
    time_created: TEST_NOW,
    time_updated: TEST_NOW + 1,
    stats: {
      message_count: 1,
      total_input_tokens: 2,
      total_output_tokens: 3,
      total_cost: 0.01,
      cost_source: "recorded",
    },
    ...overrides,
    ...identity,
  };
}

export function makeSessionData(id: string, text = "visible text"): SessionDetail {
  const head = makeSessionHead(id);
  return {
    ...head,
    messages: [
      {
        id: `${id}-message`,
        role: "user",
        time_created: TEST_NOW,
        parts: [{ type: "text", text }],
      },
    ],
  };
}
