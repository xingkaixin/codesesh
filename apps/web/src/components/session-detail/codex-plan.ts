import type { PlanPart } from "../../lib/api";

export type CodexPlanApprovalStatus = "success" | "fail";

export interface CodexPlanDisplay {
  title: "plan";
  secondaryText?: undefined;
  approvalStatus: CodexPlanApprovalStatus;
  expandable: boolean;
  contentLabel: "Plan" | "Rejected";
  contentMarkdown: string;
}

export function buildCodexPlanDisplay(part: PlanPart): CodexPlanDisplay {
  const approvalStatus: CodexPlanApprovalStatus =
    part.approval_status === "fail" ? "fail" : "success";
  const contentMarkdown = part.text.trim();

  return {
    title: "plan",
    secondaryText: undefined,
    approvalStatus,
    expandable: Boolean(contentMarkdown),
    contentLabel: approvalStatus === "fail" ? "Rejected" : "Plan",
    contentMarkdown,
  };
}
