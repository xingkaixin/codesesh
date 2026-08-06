/**
 * Visibility switch for sub-sessions on the project timeline. It only chooses
 * how children are shown — it never changes the parent's aggregates.
 */
import type { SubSessionMode } from "../../lib/session-timeline";
import { SegmentedControl } from "../ui/segmented-control";

const MODE_OPTIONS = [
  { value: "collapsed", label: "折叠" },
  { value: "expanded", label: "全部展开" },
  { value: "hidden", label: "隐藏" },
] as const satisfies readonly { value: SubSessionMode; label: string }[];

export function SubSessionModeSwitch({
  mode,
  onChange,
}: {
  mode: SubSessionMode;
  onChange: (mode: SubSessionMode) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="console-eyebrow">子会话</span>
      <SegmentedControl
        options={MODE_OPTIONS}
        value={mode}
        onChange={onChange}
        size="sm"
        ariaLabel="子会话显示方式"
      />
    </div>
  );
}
