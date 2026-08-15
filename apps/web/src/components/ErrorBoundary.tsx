import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught error:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          className="rounded-md border border-[var(--console-error-border)] bg-[var(--console-error-bg)] p-6"
        >
          <h3 className="console-mono mb-2 text-sm font-semibold text-[var(--console-error)]">
            Something went wrong
          </h3>
          <p className="console-mono mb-3 text-xs text-[var(--console-text-secondary)]">
            {this.state.error?.message || "Unknown error"}
          </p>
          {/* A full reload rather than a state reset: it also recovers stale
              lazy chunks after a redeploy, and cannot loop on a
              deterministic render error. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="console-mono rounded border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1 text-xs text-[var(--console-text)]"
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
