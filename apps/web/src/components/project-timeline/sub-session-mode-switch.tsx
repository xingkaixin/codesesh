/**
 * Visibility switch for sub-sessions on the project timeline. It only chooses
 * how children are shown — it never changes the parent's aggregates.
 */
import type { SubSessionMode } from "../../lib/session-timeline";
import { SegmentedControl } from "../ui/segmented-control";

const MODE_OPTIONS = [
  { value: "collapsed", label: "Collapsed" },
  { value: "expanded", label: "Expand all" },
  { value: "hidden", label: "Hidden" },
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
      <span className="console-eyebrow">Sub-sessions</span>
      <SegmentedControl
        options={MODE_OPTIONS}
        value={mode}
        onChange={onChange}
        size="sm"
        ariaLabel="Sub-session display"
      />
    </div>
  );
}
