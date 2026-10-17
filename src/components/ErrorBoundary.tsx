import { Component, type ReactNode } from "react";
import { reportClientError } from "../lib/telemetry";
import { emergencyEmit } from "../lib/heapForensics";

/**
 * UI bug vs memory exhaustion (#793). OOM surfaces as RangeError
 * ("Array buffer allocation failed", "Invalid array length", "Maximum call
 * stack") or engine "out of memory" messages; those get the preallocated,
 * hint-free forensic census instead of a full report that would allocate more.
 */
export function isLikelyOom(error: unknown): boolean {
  const msg = String((error as Error)?.message ?? error).toLowerCase();
  return (
    (error instanceof RangeError && /allocation|array length|buffer|call stack/.test(msg)) ||
    /out of memory|oom|allocation failed/.test(msg)
  );
}

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    if (isLikelyOom(error)) {
      emergencyEmit();
      return;
    }
    const traceId = reportClientError(error, errorInfo.componentStack || undefined);
    console.error("[ErrorBoundary] Component error caught:", { error, traceId });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          role="alert"
          aria-label="Application error"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "24px",
            fontFamily: "system-ui, -apple-system, sans-serif",
            background: "#ECE0CC",
            color: "#234B4E",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "50%",
              background: "rgba(255,122,107,0.15)",
              border: "1px solid rgba(255,122,107,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "20px",
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#FF7A6B"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2
            style={{
              margin: "0 0 8px",
              fontFamily: "'Instrument Serif', serif",
              fontWeight: 400,
              fontSize: "26px",
              color: "#234B4E",
            }}
          >
            Something went wrong
          </h2>
          <p
            style={{
              margin: "0 0 24px",
              fontSize: "14px",
              lineHeight: 1.55,
              color: "#5a554c",
              maxWidth: "400px",
            }}
          >
            An unexpected error occurred. Please try reloading the page.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "12px 28px",
              borderRadius: "10px",
              border: "none",
              background: "#FF7A6B",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 700,
              cursor: "pointer",
              minHeight: "44px",
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
