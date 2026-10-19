/**
 * Loading placeholder. Mirrors the real grid's box model so that loading → ready
 * swaps content without moving anything.
 */
import { Panel } from "../ui/panel";

function Bar({ className }: { className: string }) {
  return <span className={`skeleton-shimmer block rounded-sm ${className}`} />;
}

function CardSkeleton({ bodyClassName }: { bodyClassName: string }) {
  return (
    <Panel>
      <div className="flex min-h-12 items-center border-b border-[var(--console-border)] px-[18px]">
        <Bar className="h-[14px] w-28" />
      </div>
      <div className="p-[18px]">
        <Bar className={bodyClassName} />
      </div>
    </Panel>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-4" aria-hidden data-testid="overview-skeleton">
      <Panel className="overflow-hidden">
        <div className="grid md:grid-cols-3">
          {[0, 1, 2].map((slot) => (
            <div
              key={slot}
              className={
                slot > 0
                  ? "border-t border-[var(--console-border)] px-6 pt-5 pb-4 md:border-t-0 md:border-l"
                  : "px-6 pt-5 pb-4"
              }
            >
              <Bar className="h-3 w-16" />
              <Bar className="mt-2.5 h-9 w-32" />
              <Bar className="mt-2 h-3 w-24" />
              <Bar className="mt-3 h-[58px] w-full" />
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--console-border)] px-6 py-4">
          <Bar className="h-3.5 w-28" />
          <Bar className="mt-3 h-3.5 w-full" />
          <Bar className="mt-3 h-8 w-full" />
        </div>
      </Panel>

      <CardSkeleton bodyClassName="h-[300px] w-full" />

      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton bodyClassName="h-[200px] w-full" />
        <CardSkeleton bodyClassName="h-[200px] w-full" />
      </div>

      <CardSkeleton bodyClassName="h-[300px] w-full" />
    </div>
  );
}
