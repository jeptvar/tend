import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link } from "wouter";

type Screen = "welcome" | "name" | "backup";

// Where focus last followed a navigation. Module-level so the first load, and
// StrictMode's repeated effects, don't count as navigating.
let lastPath = window.location.pathname;

function SetupLayout({
  screen,
  step,
  focusHeading = true,
  children,
}: {
  screen: Screen;
  step?: ReactNode;
  /** Off when the screen focuses its own first field instead. */
  focusHeading?: boolean;
  children: ReactNode;
}) {
  const intl = useIntl();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The link just used is gone from the page, so without this, focus falls back to
  // the top of the document and screen readers announce nothing.
  useEffect(() => {
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4 py-12">
      <title>{intl.formatMessage({ id: `setup.${screen}.pageTitle` })}</title>
      <svg aria-hidden="true" viewBox="0 0 32 32" className="mb-6 size-10 fill-brand">
        <path d="M15 30V17C9 17 5 13 5 7c6 0 10 4 10 9v-3c0-5 4-9 11-9 0 7-4 11-9 11v15z" />
      </svg>
      {step}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl font-semibold tracking-tight outline-none"
      >
        <FormattedMessage id={`setup.${screen}.title`} />
      </h1>
      {children}
    </main>
  );
}

const choiceClass =
  "block rounded-xl border border-ink/15 bg-white/60 p-5 transition hover:border-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand dark:bg-white/5";

const primaryButtonClass =
  "min-h-11 rounded-lg bg-brand px-5 font-medium text-paper hover:bg-brand-strong focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand";

const backLinkClass =
  "-mx-2 inline-flex min-h-11 items-center px-2 text-brand underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-brand";

export function SetupWelcome() {
  return (
    <SetupLayout screen="welcome">
      <p className="mt-3 text-lg text-muted">
        <FormattedMessage id="setup.welcome.intro" />
      </p>
      <ul className="mt-8 grid gap-4">
        <li>
          <Link href="/setup/name" className={choiceClass}>
            <span className="block text-lg font-medium">
              <FormattedMessage id="setup.welcome.new" />
            </span>
            <span className="mt-1 block text-muted">
              <FormattedMessage id="setup.welcome.newHint" />
            </span>
          </Link>
        </li>
        <li>
          <Link href="/setup/backup" className={choiceClass}>
            <span className="block text-lg font-medium">
              <FormattedMessage id="setup.welcome.backup" />
            </span>
            <span className="mt-1 block text-muted">
              <FormattedMessage id="setup.welcome.backupHint" />
            </span>
          </Link>
        </li>
      </ul>
    </SetupLayout>
  );
}

export function SetupName() {
  const intl = useIntl();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [showRequired, setShowRequired] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setShowRequired(true);
      setSubmitted(false);
      inputRef.current?.focus();
      return;
    }
    // Saving the name arrives with the setup API in M1.
    setSubmitted(true);
  }

  return (
    <SetupLayout
      screen="name"
      focusHeading={false}
      step={
        <p className="mb-1 text-sm font-medium text-muted">
          <FormattedMessage id="setup.name.step" />
        </p>
      }
    >
      <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-2">
        <label htmlFor={inputId} className="font-medium">
          <FormattedMessage id="setup.name.label" />
        </label>
        <input
          ref={inputRef}
          id={inputId}
          aria-describedby={`${hintId} ${errorId}`}
          aria-invalid={showRequired}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setShowRequired(false);
          }}
          placeholder={intl.formatMessage({ id: "setup.name.placeholder" })}
          maxLength={100}
          required
          // biome-ignore lint/a11y/noAutofocus: the only field on a single-purpose setup step
          autoFocus
          className="min-h-11 rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] placeholder:text-[#5b655f] focus-visible:outline-3 focus-visible:outline-brand"
        />
        <p id={hintId} className="text-sm text-muted">
          <FormattedMessage id="setup.name.hint" />
        </p>
        <p id={errorId} className="text-sm font-medium text-danger">
          {showRequired && <FormattedMessage id="setup.name.required" />}
        </p>
        <div className="mt-6 flex items-center justify-between">
          <Link href="/setup" className={backLinkClass}>
            <FormattedMessage id="common.back" />
          </Link>
          <button type="submit" className={primaryButtonClass}>
            <FormattedMessage id="setup.name.continue" />
          </button>
        </div>
        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="status" className="mt-4 text-muted">
          {submitted && <FormattedMessage id="setup.name.next" />}
        </p>
      </form>
    </SetupLayout>
  );
}

export function SetupBackup() {
  return (
    <SetupLayout screen="backup">
      <p className="mt-3 text-lg text-muted">
        <FormattedMessage id="setup.backup.body" />
      </p>
      <div className="mt-8">
        <Link href="/setup" className={backLinkClass}>
          <FormattedMessage id="common.back" />
        </Link>
      </div>
    </SetupLayout>
  );
}
