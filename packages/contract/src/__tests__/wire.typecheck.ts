import type { MessagePart, PublicSessionHead, SessionReference } from "../index.js";

declare const reference: SessionReference;
declare const session: PublicSessionHead;

// @ts-expect-error Session references remain immutable in the browser API.
reference.agentName = "codex";
// @ts-expect-error Session identity cannot be replaced after construction.
session.reference = reference;

// @ts-expect-error A plan only supports the existing success/fail states.
const invalidPlan: MessagePart = { type: "plan", text: "plan", approval_status: "pending" };
// @ts-expect-error An image must contain a URL or data with a MIME type.
const emptyImage: MessagePart = { type: "image" };

export type InvalidWireExamples = typeof invalidPlan | typeof emptyImage;
