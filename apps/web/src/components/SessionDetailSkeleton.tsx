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

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`rounded-sm bg-[var(--console-border)] ${className}`} />;
}

export function SessionDetailSkeleton() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-2 md:px-4">
      <div className="flex flex-1 flex-col gap-8">
        {SKELETON_MESSAGES.map((item) => (
          <article
            key={item.id}
            className="w-full border-l-2 border-[var(--console-thread)] pl-4 pr-3 md:pr-5"
          >
            <div className="flex gap-4">
              <div className="shrink-0 pt-1">
                <div className="flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
                  <div className="size-3.5 rounded-sm bg-[var(--console-border-strong)] animate-pulse motion-reduce:animate-none" />
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex items-center gap-3">
                  <SkeletonBlock
                    className={`${item.roleWidth} h-3 animate-pulse motion-reduce:animate-none`}
                  />
                  <SkeletonBlock
                    className={`${item.timeWidth} h-2.5 animate-pulse motion-reduce:animate-none`}
                  />
                </div>
                <div className="rounded-sm border border-[var(--console-border)] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                  <div className="space-y-2">
                    {item.bodyWidths.map((w) => (
                      <SkeletonBlock
                        key={`${item.id}-${w}`}
                        className={`${w} h-3 animate-pulse motion-reduce:animate-none`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="min-h-24 flex-1 rounded-sm border border-[var(--console-border)] bg-white/60 animate-pulse motion-reduce:animate-none" />
    </div>
  );
}
