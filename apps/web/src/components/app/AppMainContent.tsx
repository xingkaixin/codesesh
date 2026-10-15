import type { ReactNode } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";

export function AppMainContent({
  locationPath,
  mode,
  searchActive,
  sessionCount,
  intro,
  children,
}: {
  locationPath: string;
  mode: string;
  searchActive: boolean;
  sessionCount: number;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="console-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-7 md:px-6">
      {intro ? <div className="mb-5 flex flex-col gap-4">{intro}</div> : null}
      <ErrorBoundary key={locationPath}>
        <RenderProfiler
          id="MainContent"
          detail={{ mode, search: searchActive, sessions: sessionCount }}
        >
          {children}
        </RenderProfiler>
      </ErrorBoundary>
    </section>
  );
}
