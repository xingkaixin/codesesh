import { useLocale } from "../../hooks/useLocale";
/**
 * Loading placeholder. Mirrors the real grid's box model so that loading → ready
 * swaps content without moving anything.
 */
import { Panel } from "../ui/panel";

const KPI_SLOTS = [0, 1, 2, 3, 4];

function Bar({ className }: { className: string }) {
  useLocale();

  return <span className={`skeleton-shimmer block rounded-sm ${className}`} />;
}

function CardSkeleton({ bodyClassName }: { bodyClassName: string }) {
  useLocale();

  return (
    <Panel className="p-4">
      <Bar className="h-[15px] w-28" />
      <Bar className={`mt-3 ${bodyClassName}`} />
    </Panel>
  );
}

export function OverviewSkeleton() {
  useLocale();

  return (
    <div className="space-y-4" aria-hidden data-testid="overview-skeleton">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {KPI_SLOTS.map((slot) => (
          <Panel key={slot} className="px-4 py-[14px]">
            <Bar className="h-[10px] w-16" />
            <Bar className="mt-[9px] h-[27px] w-24" />
            <Bar className="mt-[7px] h-[11px] w-20" />
          </Panel>
        ))}
      </div>

      <Panel className="p-4">
        <Bar className="h-[15px] w-28" />
        <Bar className="mt-[14px] h-[168px] w-full" />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.45fr_1fr]">
        <CardSkeleton bodyClassName="h-[248px] w-full" />
        <div className="grid content-start gap-4">
          <CardSkeleton bodyClassName="h-[116px] w-full" />
          <CardSkeleton bodyClassName="h-[100px] w-full" />
        </div>
      </div>
    </div>
  );
}
