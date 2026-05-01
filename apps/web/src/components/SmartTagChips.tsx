import type { CSSProperties } from "react";
import type { SmartTag } from "../lib/api";

export const SMART_TAG_LABELS: Record<SmartTag, string> = {
  bugfix: "bugfix",
  refactoring: "refactoring",
  "feature-dev": "feature-dev",
  testing: "testing",
  docs: "docs",
  "git-ops": "git-ops",
  "build-deploy": "build-deploy",
  exploration: "exploration",
  planning: "planning",
};

export const SMART_TAG_TONES: Record<
  SmartTag,
  { text: string; border: string; background: string; bar: string }
> = {
  bugfix: {
    text: "#B42318",
    border: "#FECDCA",
    background: "#FEF3F2",
    bar: "#F04438",
  },
  refactoring: {
    text: "#6941C6",
    border: "#D9D6FE",
    background: "#F4F3FF",
    bar: "#7A5AF8",
  },
  "feature-dev": {
    text: "#175CD3",
    border: "#B2DDFF",
    background: "#EFF8FF",
    bar: "#2E90FA",
  },
  testing: {
    text: "#027A48",
    border: "#ABEFC6",
    background: "#ECFDF3",
    bar: "#12B76A",
  },
  docs: {
    text: "#B54708",
    border: "#FEDF89",
    background: "#FFFAEB",
    bar: "#F79009",
  },
  "git-ops": {
    text: "#3538CD",
    border: "#C7D7FE",
    background: "#EEF4FF",
    bar: "#444CE7",
  },
  "build-deploy": {
    text: "#C4320A",
    border: "#F9DBAF",
    background: "#FEF6EE",
    bar: "#EF6820",
  },
  exploration: {
    text: "#0E7090",
    border: "#A5F0FC",
    background: "#ECFDFF",
    bar: "#06AED4",
  },
  planning: {
    text: "#C11574",
    border: "#FCCEEE",
    background: "#FDF2FA",
    bar: "#EE46BC",
  },
};

export function getSmartTagTone(tag: SmartTag) {
  return SMART_TAG_TONES[tag];
}

export function getSmartTagChipStyle(tag: SmartTag): CSSProperties {
  const tone = getSmartTagTone(tag);
  return {
    color: tone.text,
    borderColor: tone.border,
    backgroundColor: tone.background,
  };
}

export function SmartTagChips({
  tags,
  limit = 4,
  className = "",
}: {
  tags?: SmartTag[];
  limit?: number;
  className?: string;
}) {
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, limit);
  const remaining = tags.length - visible.length;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {visible.map((tag) => (
        <span
          key={tag}
          className="console-mono rounded-sm border px-1.5 py-0.5 text-[10px] font-medium"
          style={getSmartTagChipStyle(tag)}
        >
          {SMART_TAG_LABELS[tag]}
        </span>
      ))}
      {remaining > 0 ? (
        <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--console-muted)]">
          +{remaining}
        </span>
      ) : null}
    </div>
  );
}
