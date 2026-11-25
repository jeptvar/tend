import { type ReactNode, useEffect, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ApiError, OFFLINE } from "../lib/api.ts";
import { focusNextScreen, useNavigationFocus } from "./focus.ts";
import { OpenConnection } from "./OpenConnection.tsx";
import { Problem } from "./Problem.tsx";

/** Tend's mark. */
export function Leaf({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`shrink-0 ${className}`}>
      <path d="M15 30V17C9 17 5 13 5 7c6 0 10 4 10 9v-3c0-5 4-9 11-9 0 7-4 11-9 11v15z" />
    </svg>
  );
}

const STEPS = [1, 2, 3] as const;

/**
 * The page used by setup and for signing in, with Tend's own beside it on a wide window, and
 * above it on any other. Messages come from `<screen>.title` and `.pageTitle`.
 */
export function AuthLayout({
  screen,
  title,
  step,
  wide = false,
  focusHeading = true,
  focusOnMount = false,
  children,
}: {
  screen: string;
  /** Replaces the `<screen>.title` message, for headings with a name in them. */
  title?: string;
  step?: 1 | 2 | 3;
  /** For something to look at, rather than a form. */
  wide?: boolean;
  /** Off when the screen focuses its own first field instead. */
  focusHeading?: boolean;
  /** For a screen that replaces another without the address changing. */
  focusOnMount?: boolean;
  children: ReactNode;
}) {
  const intl = useIntl();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useNavigationFocus(headingRef, { enabled: focusHeading, always: focusOnMount });

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <title>{intl.formatMessage({ id: `${screen}.pageTitle` })}</title>
      <header
        className={`side relative flex shrink-0 overflow-hidden px-5 py-3.5 lg:sticky lg:top-0 lg:h-dvh lg:flex-col lg:justify-between lg:p-14 ${
          wide ? "lg:w-[34%]" : "lg:w-[46%]"
        }`}
      >
        <Leaf className="absolute -right-10 bottom-0 h-[58%] fill-white/8 max-lg:hidden" />
        <p className="flex items-center gap-2.5 text-xl font-bold text-white">
          <Leaf className="size-8 fill-leaf" />
          <FormattedMessage id="auth.tend" />
        </p>
        <div className="relative max-w-md max-lg:hidden">
          <p className="text-4xl leading-[1.1] font-bold tracking-tight text-balance text-white xl:text-5xl xl:leading-[1.1]">
            <FormattedMessage id="auth.promise" />
          </p>
          <p className="mt-4 text-lg text-side-muted">
            <FormattedMessage id="auth.promiseMore" />
          </p>
        </div>
      </header>
      <main className="flex min-w-0 flex-1 flex-col justify-center px-5 py-10 sm:px-10">
        <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-lg"}`}>
          <OpenConnection />
          {step && (
            <div className="mb-3 flex items-center gap-4">
              <p className="text-sm font-semibold text-muted">
                <FormattedMessage id="setup.step" values={{ step, total: STEPS.length }} />
              </p>
              <span aria-hidden="true" className="flex gap-1.5">
                {STEPS.map((each) => (
                  <span
                    key={each}
                    className={`h-1.5 w-8 rounded-full ${each <= step ? "bg-brand" : "bg-edge/40"}`}
                  />
                ))}
              </span>
            </div>
          )}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-3xl font-bold tracking-tight break-words outline-none sm:text-4xl"
          >
            {title ?? <FormattedMessage id={`${screen}.title`} />}
          </h1>
          {children}
        </div>
      </main>
    </div>
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
  const answered = error instanceof ApiError && error.code !== OFFLINE;

  // Whatever comes back next has to take focus, even at the same address.
  useEffect(() => focusNextScreen, []);

  return (
    <AuthLayout screen={answered ? "problem" : "offline"} focusOnMount>
      <p role="alert" className="mt-3 text-lg text-muted">
        {<Problem error={error} />}
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
  "primary inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-xl px-5 text-center font-semibold [overflow-wrap:anywhere] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-center font-semibold shadow-xs [overflow-wrap:anywhere] enabled:hover:border-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";

/** For something less than a button: going somewhere, or a choice beside a bigger one. */
export const textLinkClass =
  "-mx-2 inline-flex min-h-11 items-center px-2 font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-brand";

/** A button that's only a sign, whose name is said but not shown. */
export const iconButtonClass =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-ink/5 hover:text-ink focus-visible:outline-3 focus-visible:outline-brand";
