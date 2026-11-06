import { type ReactNode, useEffect, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ApiError, errorText, OFFLINE } from "../lib/api.ts";

// Where focus last followed a navigation. Module-level so the first load, and
// StrictMode's repeated effects, don't count as navigating.
let lastPath: string | null = window.location.pathname;

/** The centred page used by setup and sign-in. Messages come from `<screen>.title` and `.pageTitle`. */
export function AuthLayout({
  screen,
  title,
  step,
  focusHeading = true,
  focusOnMount = false,
  children,
}: {
  screen: string;
  /** Replaces the `<screen>.title` message, for headings with a name in them. */
  title?: string;
  step?: 1 | 2 | 3;
  /** Off when the screen focuses its own first field instead. */
  focusHeading?: boolean;
  /** For a screen that replaces another without the address changing. */
  focusOnMount?: boolean;
  children: ReactNode;
}) {
  const intl = useIntl();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The link just used is gone from the page, so without this, focus falls back to
  // the top of the document and screen readers announce nothing.
  useEffect(() => {
    if (focusOnMount) {
      headingRef.current?.focus();
      return;
    }
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading, focusOnMount]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4 py-12">
      <title>{intl.formatMessage({ id: `${screen}.pageTitle` })}</title>
      <svg aria-hidden="true" viewBox="0 0 32 32" className="mb-6 size-10 fill-brand">
        <path d="M15 30V17C9 17 5 13 5 7c6 0 10 4 10 9v-3c0-5 4-9 11-9 0 7-4 11-9 11v15z" />
      </svg>
      {step && (
        <p className="mb-1 text-sm font-medium text-muted">
          <FormattedMessage id="setup.step" values={{ step, total: 3 }} />
        </p>
      )}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl font-semibold tracking-tight break-words outline-none"
      >
        {title ?? <FormattedMessage id={`${screen}.title`} />}
      </h1>
      {children}
    </main>
  );
}

/** Shown while the first answer from the server is on its way. */
export function Loading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4 py-12 text-muted"
    >
      <FormattedMessage id="common.loading" />
    </main>
  );
}

/** Replaces a screen that can't show anything until the server answers. */
export function CannotReachTend({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const intl = useIntl();
  const answered = error instanceof ApiError && error.code !== OFFLINE;

  // Whatever comes back next has to take focus, even at the same address.
  useEffect(
    () => () => {
      lastPath = null;
    },
    [],
  );

  return (
    <AuthLayout screen={answered ? "problem" : "offline"} focusOnMount>
      <p role="alert" className="mt-3 text-lg text-muted">
        {errorText(error, intl.formatMessage({ id: "offline.body" }))}
      </p>
      <div className="mt-8">
        <button type="button" disabled={retrying} onClick={onRetry} className={primaryButtonClass}>
          <FormattedMessage id={retrying ? "common.trying" : "common.tryAgain"} />
        </button>
      </div>
    </AuthLayout>
  );
}

export const primaryButtonClass =
  "min-h-11 rounded-lg bg-brand px-5 font-medium text-paper hover:bg-brand-strong focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";

export const secondaryButtonClass =
  "min-h-11 rounded-lg border border-muted px-4 font-medium hover:border-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand";

export const textLinkClass =
  "-mx-2 inline-flex min-h-11 items-center px-2 text-brand underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-brand";
