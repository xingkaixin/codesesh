import { t } from "../i18n/translate";
import { useLocale } from "../hooks/useLocale";
import type { CSSProperties } from "react";
import { SMART_TAGS, type SmartTag } from "../lib/api";

// SmartTag values double as the --tag-{tone}-* CSS variable names in
// index.css, which owns the actual color values.
export const SMART_TAG_TONES: Record<
  SmartTag,
  { text: string; border: string; background: string; bar: string }
> = Object.fromEntries(
  SMART_TAGS.map((tag) => [
    tag,
    {
      text: `var(--tag-${tag}-text)`,
      border: `var(--tag-${tag}-border)`,
      background: `var(--tag-${tag}-background)`,
      bar: `var(--tag-${tag}-bar)`,
    },
  ]),
) as Record<SmartTag, { text: string; border: string; background: string; bar: string }>;

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
  useLocale();

  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, limit);
  const remaining = tags.length - visible.length;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {visible.map((tag) => (
        <span
          key={t(tag)}
          className="console-mono rounded-sm border px-1.5 py-0.5 text-[10px] font-medium"
          style={getSmartTagChipStyle(tag)}
        >
          {t(tag)}
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
