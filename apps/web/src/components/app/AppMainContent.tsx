import type { ReactNode } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { RenderProfiler } from "../RenderProfiler";

export function AppMainContent({
  locationPath,
  mode,
  searchActive,
  sessionCount,
  children,
}: {
  locationPath: string;
  mode: string;
  searchActive: boolean;
  sessionCount: number;
  children: ReactNode;
}) {
  return (
    <section className="console-scrollbar bg-grid min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
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
