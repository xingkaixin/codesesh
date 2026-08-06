/**
 * Mirrors the reader's real two-column grid (288px filter aside + stream) so
 * loading → ready does not shift the page.
 */
const SKELETON_MESSAGES = [
  { id: "1", roleWidth: "w-14", timeWidth: "w-20", bodyWidths: ["w-full", "w-10/12", "w-7/12"] },
  { id: "2", roleWidth: "w-16", timeWidth: "w-24", bodyWidths: ["w-9/12", "w-7/12"] },
  {
    id: "3",
    roleWidth: "w-14",
    timeWidth: "w-16",
    bodyWidths: ["w-full", "w-11/12", "w-8/12", "w-5/12"],
  },
  { id: "4", roleWidth: "w-16", timeWidth: "w-20", bodyWidths: ["w-10/12", "w-8/12"] },
  { id: "5", roleWidth: "w-14", timeWidth: "w-24", bodyWidths: ["w-full", "w-10/12", "w-9/12"] },
];

const SKELETON_FILTER_ROWS = ["w-8/12", "w-7/12", "w-9/12", "w-6/12", "w-10/12", "w-7/12"];

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`skeleton-shimmer rounded-sm ${className}`} />;
}

export function SessionDetailSkeleton() {
  return (
    <div className="mx-auto grid min-h-full w-full max-w-[1440px] gap-6 px-2 md:px-4 min-[1025px]:grid-cols-[288px_minmax(0,1fr)] min-[1025px]:items-start">
      <div className="hidden rounded-lg border border-[var(--console-border)] bg-[var(--console-surface-muted)] p-3 min-[1025px]:block">
        <SkeletonBlock className="h-2.5 w-20" />
        <div className="mt-4 space-y-2.5">
          {SKELETON_FILTER_ROWS.map((width, index) => (
            <div key={`${index}-${width}`} className="flex items-center gap-2.5">
              <SkeletonBlock className="size-3.5 shrink-0" />
              <SkeletonBlock className={`h-3 ${width}`} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        {SKELETON_MESSAGES.map((item) => (
          <article
            key={item.id}
            className="w-full border-l-2 border-[var(--console-thread)] pl-4 pr-3 md:pr-5"
          >
            <div className="flex gap-4">
              <div className="shrink-0 pt-1">
                <div className="flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                  <SkeletonBlock className="size-3.5" />
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex items-center gap-3">
                  <SkeletonBlock className={`${item.roleWidth} h-3`} />
                  <SkeletonBlock className={`${item.timeWidth} h-2.5`} />
                </div>
                <div className="rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 shadow-[var(--shadow-raised)]">
                  <div className="space-y-2">
                    {item.bodyWidths.map((w) => (
                      <SkeletonBlock key={`${item.id}-${w}`} className={`${w} h-3`} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
