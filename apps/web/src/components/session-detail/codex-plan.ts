import { t } from "../../i18n/translate";
import type { PlanPart } from "@codesesh/contract";

export interface CodexPlanDisplay {
  title: "plan";
  secondaryText?: undefined;
  approvalStatus: PlanPart["approval_status"];
  expandable: boolean;
  contentLabel: string;
  contentMarkdown: string;
}

export function buildCodexPlanDisplay(part: PlanPart): CodexPlanDisplay {
  const approvalStatus = part.approval_status;
  const contentMarkdown = part.text.trim();

  return {
    title: "plan",
    secondaryText: undefined,
    approvalStatus,
    expandable: Boolean(contentMarkdown),
    contentLabel: approvalStatus === "fail" ? t("Rejected") : t("Plan"),
    contentMarkdown,
  };
}
