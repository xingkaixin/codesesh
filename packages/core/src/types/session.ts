export type {
  SessionStats,
  CostSource,
  SmartTag,
  FileActivityKind,
  SessionFileActivity,
  SessionFileActivityOccurrence,
  ProjectIdentityKind,
  ProjectIdentity,
  ProjectIdentityRef,
  ProjectGroup,
  MessageTokens,
  ToolPartStatus,
  ToolPartState,
  TextPart,
  ReasoningPart,
  PlanPart,
  ImageDataPart,
  ImageUrlPart,
  ImagePart,
  ToolPart,
  MessagePart,
  Message,
  SessionHead,
  IdentifiedSessionHead,
  SessionDetail,
  IdentifiedSessionDetail,
} from "../contract/session.js";
export type { SessionReference } from "../contract/session-reference.js";

export type ParseSessionResult<T> =
  | { status: "parsed"; data: T }
  | { status: "skipped"; reason?: string }
  | { status: "filtered"; reason?: string };
