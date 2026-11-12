import { Component, type ErrorInfo, type ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import { primaryButtonClass } from "./AuthLayout.tsx";

/**
 * The last resort, for a screen that can't load or crashes, such as when Tend stopped
 * before the editor's code arrived. Anything typed is kept on this device, so reloading is safe.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">
          <FormattedMessage id="problem.title" />
        </h1>
        <p className="mt-4 text-lg text-muted">
          <FormattedMessage id="problem.reload" />
        </p>
        <button
          type="button"
          className={`${primaryButtonClass} mt-6`}
          onClick={() => window.location.reload()}
        >
          <FormattedMessage id="common.tryAgain" />
        </button>
      </main>
    );
  }
}
