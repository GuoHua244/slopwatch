import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

type BoundaryState = { error: unknown };

/** Last-resort boundary: a render crash shows the error and a way out
 * instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the crash on the console even when the render below is what the
    // user sees.
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error !== null && error !== undefined) {
      return (
        <main className="full">
          <p className="empty">
            {error instanceof Error ? error.message : String(error)} — reload
            the page to try again.
          </p>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
