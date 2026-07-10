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
  ToolPartState,
  MessagePart,
  Message,
  SessionHead,
  SessionData,
} from "../contract/session.js";

export type ParseSessionResult<T> =
  | { status: "parsed"; data: T }
  | { status: "skipped"; reason?: string }
  | { status: "filtered"; reason?: string };
